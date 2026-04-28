#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";

const root = process.env.AUTOMATIONS_ROOT || path.resolve(process.cwd());
const token = mustEnv("TELEGRAM_BOT_TOKEN");
const baseUrl = process.env.SATURN_BASE_URL || "http://127.0.0.1:3737";
const publicBaseUrl = process.env.SATURN_PUBLIC_URL || baseUrl;
const stateFile = process.env.TELEGRAM_STATE_FILE || path.join(root, "telegram", "state.json");
const pollTimeout = Number(process.env.TELEGRAM_POLL_TIMEOUT_SECONDS || 25);
const waitSeconds = Number(process.env.TELEGRAM_WAIT_SECONDS || 1800);
const waitIntervalMs = Number(process.env.TELEGRAM_WAIT_INTERVAL_MS || 5000);
const allowAll = process.env.TELEGRAM_ALLOW_ALL === "1";
const allowedChatIds = new Set(
  (process.env.TELEGRAM_ALLOWED_CHAT_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

if (!allowAll && allowedChatIds.size === 0) {
  throw new Error("Set TELEGRAM_ALLOWED_CHAT_IDS, or set TELEGRAM_ALLOW_ALL=1 for local testing.");
}

let state = await loadState();
await refreshBotIdentity();
const pendingMonitors = new Set();

for (const [chatId, chat] of Object.entries(state.chats || {})) {
  if (chat.pending_session_id) {
    monitorSession(chatId, chat.pending_session_id).catch((err) => {
      console.error("[telegram-dispatch] monitor failed", chatId, err);
    });
  }
}

console.log("[telegram-dispatch] polling Telegram updates");

while (true) {
  try {
    const updates = await telegram("getUpdates", {
      offset: state.offset ? state.offset + 1 : undefined,
      timeout: pollTimeout,
      allowed_updates: ["message"],
    });

    for (const update of updates.result || []) {
      state.offset = Math.max(state.offset || 0, update.update_id);
      await saveState();
      handleUpdate(update).catch((err) => {
        console.error("[telegram-dispatch] update failed", err);
      });
    }
  } catch (err) {
    console.error("[telegram-dispatch] poll failed", err);
    await sleep(5000);
  }
}

async function handleUpdate(update) {
  const message = update.message;
  const chatId = String(message?.chat?.id || "");
  const text = message?.text?.trim();
  if (!chatId || !text) return;

  if (!isAllowed(chatId)) {
    await sendMessage(chatId, "This chat is not authorized for Saturn Dispatch.");
    return;
  }
  ensureChat(chatId);
  await saveState();

  if (text === "/start" || text.startsWith("/start ") || text === "/help") {
    await sendMessage(
      chatId,
      [
        "Saturn Dispatch is connected.",
        "",
        "Send messages normally. If a turn is running, follow-ups are queued and sent next.",
        "/new or /reset clears this chat's session mapping.",
        "/new <task> starts a fresh session with that task.",
        "/status shows the active session status.",
        "/session shows the current Saturn session id.",
        "/think <low|medium|high|xhigh> sets reasoning for this chat.",
        "/model <id> sets the model for this chat.",
        "/agent <id|off> routes new sessions through a saved agent.",
        "/verbose <on|off> toggles extra run links.",
      ].join("\n"),
    );
    return;
  }

  if (text === "/session") {
    const sessionId = state.chats?.[chatId]?.session_id;
    await sendMessage(chatId, sessionId ? `Current session: ${sessionId}` : "No session yet.");
    return;
  }

  if (text === "/status") {
    await sendStatus(chatId);
    return;
  }

  if (text === "/new" || text === "/reset" || text === "/clear") {
    clearSessionMapping(chatId);
    await saveState();
    await sendMessage(chatId, "Session mapping cleared. Send the next task to start fresh.");
    return;
  }

  if (text.startsWith("/new ")) {
    clearSessionMapping(chatId);
    await saveState();
    await dispatchMessage(chatId, text.slice(5).trim());
    return;
  }

  if (text.startsWith("/think ")) {
    const effort = text.slice(7).trim();
    if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) {
      await sendMessage(chatId, "Use /think low, /think medium, /think high, or /think xhigh.");
      return;
    }
    state.chats[chatId].reasoningEffort = effort === "max" ? "xhigh" : effort;
    await saveState();
    await sendMessage(chatId, `Reasoning set to ${state.chats[chatId].reasoningEffort}.`);
    return;
  }

  if (text.startsWith("/model ")) {
    const model = text.slice(7).trim();
    if (!model) {
      await sendMessage(chatId, "Use /model <model-id>.");
      return;
    }
    state.chats[chatId].model = model;
    await saveState();
    await sendMessage(chatId, `Model set to ${model}.`);
    return;
  }

  if (text.startsWith("/agent ")) {
    const agentId = text.slice(7).trim();
    if (!agentId) {
      await sendMessage(chatId, "Use /agent <agent-id> or /agent off.");
      return;
    }
    if (agentId === "off" || agentId === "none") {
      delete state.chats[chatId].agent_id;
      clearSessionMapping(chatId);
      await saveState();
      await sendMessage(chatId, "Agent routing disabled for new sessions.");
      return;
    }
    state.chats[chatId].agent_id = agentId;
    clearSessionMapping(chatId);
    await saveState();
    await sendMessage(chatId, `New sessions will use agent ${agentId}.`);
    return;
  }

  if (text.startsWith("/verbose ")) {
    const value = text.slice(9).trim().toLowerCase();
    if (!["on", "off"].includes(value)) {
      await sendMessage(chatId, "Use /verbose on or /verbose off.");
      return;
    }
    state.chats[chatId].verbose = value === "on";
    await saveState();
    await sendMessage(chatId, `Verbose mode ${value}.`);
    return;
  }

  await dispatchMessage(chatId, text);
}

async function dispatchMessage(chatId, text) {
  ensureChat(chatId);
  const chat = state.chats[chatId];

  if (chat.pending_session_id && (await isSessionRunning(chat.pending_session_id))) {
    chat.queue ||= [];
    chat.queue.push({ text, queued_at: new Date().toISOString() });
    await saveState();
    await sendMessage(chatId, `Queued. ${chat.queue.length} message${chat.queue.length === 1 ? "" : "s"} waiting.`);
    return;
  }

  let sessionId = chat.session_id;
  if (!sessionId) {
    const created = await saturn("/api/sessions", {
      method: "POST",
      body: JSON.stringify(buildCreateSessionBody(chat, text)),
    });
    sessionId = created.session_id;
    chat.session_id = sessionId;
  } else {
    try {
      await saturn(`/api/sessions/${sessionId}/messages`, {
        method: "POST",
        body: JSON.stringify(buildMessageBody(chat, text)),
      });
    } catch (err) {
      if (String(err.message || err).includes("409")) {
        chat.queue ||= [];
        chat.queue.push({ text, queued_at: new Date().toISOString() });
        await saveState();
        await sendMessage(chatId, `Queued. ${chat.queue.length} message${chat.queue.length === 1 ? "" : "s"} waiting.`);
        return;
      }
      throw err;
    }
  }

  chat.pending_session_id = sessionId;
  await saveState();

  if (chat.verbose) {
    await sendMessage(chatId, `Working in session ${sessionId}\n${publicBaseUrl}/chats/${sessionId}`);
  } else {
    await sendChatAction(chatId, "typing").catch(() => {});
  }
  monitorSession(chatId, sessionId).catch((err) => {
    console.error("[telegram-dispatch] monitor failed", chatId, sessionId, err);
  });
}

function buildCreateSessionBody(chat, message) {
  const body = {
    message,
    cli: process.env.SATURN_CLI || undefined,
    model: chat.model || process.env.SATURN_MODEL || undefined,
    reasoningEffort: chat.reasoningEffort || process.env.SATURN_REASONING_EFFORT || undefined,
  };

  const agentId = chat.agent_id || process.env.SATURN_AGENT_ID;
  if (agentId) {
    return { ...body, agent_id: agentId };
  }

  return {
    ...body,
    adhoc_config: {
      cli: process.env.SATURN_ADHOC_CLI || process.env.SATURN_CLI || "claude-bedrock",
      model: chat.model || process.env.SATURN_ADHOC_MODEL || process.env.SATURN_MODEL || undefined,
      reasoningEffort:
        chat.reasoningEffort ||
        process.env.SATURN_ADHOC_REASONING_EFFORT ||
        process.env.SATURN_REASONING_EFFORT ||
        undefined,
      prompt: process.env.SATURN_ADHOC_PROMPT || "You are Saturn Dispatch. Help the user from Telegram.",
      cwd: process.env.SATURN_ADHOC_CWD || undefined,
      allowedTools: csv(process.env.SATURN_ADHOC_ALLOWED_TOOLS),
      timeout_seconds: numberOrUndefined(process.env.SATURN_ADHOC_TIMEOUT_SECONDS),
    },
  };
}

function buildMessageBody(chat, message) {
  return {
    message,
    cli: process.env.SATURN_CLI || undefined,
    model: chat.model || process.env.SATURN_MODEL || undefined,
    reasoningEffort: chat.reasoningEffort || process.env.SATURN_REASONING_EFFORT || undefined,
  };
}

async function monitorSession(chatId, sessionId) {
  if (pendingMonitors.has(chatId)) return;
  pendingMonitors.add(chatId);

  const deadline = Date.now() + waitSeconds * 1000;
  try {
    while (Date.now() < deadline) {
      const session = await getSession(sessionId);
      if (session?.meta?.status && session.meta.status !== "running") {
        const lastTurn = session.meta.turns?.[session.meta.turns.length - 1];
        const finalText = lastTurn?.final_text?.trim() || `(session finished with status ${session.meta.status})`;
        await sendLongMessage(chatId, finalText);

        if (state.chats?.[chatId]?.pending_session_id === sessionId) {
          delete state.chats[chatId].pending_session_id;
          await saveState();
        }
        pendingMonitors.delete(chatId);
        await drainQueuedMessages(chatId);
        return;
      }
      await sendChatAction(chatId, "typing").catch(() => {});
      await sleep(waitIntervalMs);
    }

    await sendMessage(chatId, `Session is still running: ${sessionId}`);
  } finally {
    pendingMonitors.delete(chatId);
  }
}

async function drainQueuedMessages(chatId) {
  ensureChat(chatId);
  const chat = state.chats[chatId];
  const next = chat.queue?.shift();
  if (!next) {
    await saveState();
    return;
  }
  await saveState();
  await dispatchMessage(chatId, next.text);
}

async function sendStatus(chatId) {
  const chat = state.chats?.[chatId];
  if (!chat?.session_id) {
    await sendMessage(chatId, "No session yet.");
    return;
  }
  const session = await getSession(chat.session_id);
  if (!session) {
    await sendMessage(chatId, `Session not found: ${chat.session_id}`);
    return;
  }
  const turns = session.meta.turns?.length || 0;
  const queued = chat.queue?.length || 0;
  const settings = [
    chat.agent_id ? `Agent: ${chat.agent_id}` : null,
    chat.model ? `Model: ${chat.model}` : null,
    chat.reasoningEffort ? `Reasoning: ${chat.reasoningEffort}` : null,
  ].filter(Boolean);
  await sendMessage(
    chatId,
    [
      `Session ${chat.session_id}`,
      `Status: ${session.meta.status}`,
      `Turns: ${turns}`,
      `Queued: ${queued}`,
      ...settings,
    ].join("\n"),
  );
}

async function isSessionRunning(sessionId) {
  const session = await getSession(sessionId).catch(() => null);
  return session?.meta?.status === "running";
}

async function getSession(sessionId) {
  return saturn(`/api/sessions/${sessionId}`, { method: "GET" });
}

async function saturn(route, init = {}) {
  const res = await fetch(`${baseUrl}${route}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(`Saturn ${res.status}: ${json.error || text || res.statusText}`);
  }
  return json;
}

async function telegram(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok || json.ok === false) {
    throw new Error(`Telegram ${method} failed: ${json.description || text || res.statusText}`);
  }
  return json;
}

async function refreshBotIdentity() {
  try {
    const result = await telegram("getMe", {});
    const bot = result.result;
    if (bot?.username) {
      state.bot = {
        id: bot.id,
        username: bot.username,
        first_name: bot.first_name,
        updated_at: new Date().toISOString(),
      };
      await saveState();
    }
  } catch (err) {
    console.error("[telegram-dispatch] getMe failed", err);
  }
}

async function sendMessage(chatId, text) {
  return telegram("sendMessage", {
    chat_id: chatId,
    text: text.slice(0, 4096),
    disable_web_page_preview: true,
  });
}

async function sendLongMessage(chatId, text) {
  const chunks = chunkText(text, 3900);
  for (const chunk of chunks) {
    await sendMessage(chatId, chunk);
  }
}

async function sendChatAction(chatId, action) {
  return telegram("sendChatAction", { chat_id: chatId, action });
}

function chunkText(text, maxLen) {
  const chunks = [];
  let rest = text || "";
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf("\n", maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks.length ? chunks : ["(no response)"];
}

function ensureChat(chatId) {
  state.chats ||= {};
  state.chats[chatId] ||= { queue: [] };
  state.chats[chatId].queue ||= [];
}

function clearSessionMapping(chatId) {
  ensureChat(chatId);
  delete state.chats[chatId].session_id;
  delete state.chats[chatId].pending_session_id;
  state.chats[chatId].queue = [];
}

function isAllowed(chatId) {
  return allowAll || allowedChatIds.has(chatId);
}

async function loadState() {
  try {
    const raw = await fs.readFile(stateFile, "utf8");
    return JSON.parse(raw);
  } catch {
    return { offset: 0, chats: {} };
  }
}

async function saveState() {
  await fs.mkdir(path.dirname(stateFile), { recursive: true });
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2), "utf8");
}

function mustEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function csv(value) {
  const items = (value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

function numberOrUndefined(value) {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
