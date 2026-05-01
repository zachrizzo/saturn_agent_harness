#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";

const root = process.env.AUTOMATIONS_ROOT || path.resolve(process.cwd());
const token = mustEnv("TELEGRAM_BOT_TOKEN");
const baseUrl = process.env.SATURN_BASE_URL || "http://127.0.0.1:3737";
const publicBaseUrl = process.env.SATURN_PUBLIC_URL || baseUrl;
const stateFile = process.env.TELEGRAM_STATE_FILE || path.join(root, "telegram", "state.json");
const defaultDispatchCwd = normalizeDir(
  process.env.SATURN_DISPATCH_DEFAULT_CWD || path.join(root, "telegram", "dispatch-workspace"),
);
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
const cliValues = new Set(["claude-bedrock", "claude-personal", "claude-local", "codex", "claude"]);
const reasoningValues = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
const defaultPrompt = "You are Saturn Dispatch. Help the user from Telegram.";
const noToolsSentinel = "__SATURN_NO_TOOLS__";
const toolPresets = {
  none: [noToolsSentinel],
  read: ["Read", "Grep"],
  "read-only": ["Read", "Grep"],
  code: ["Read", "Grep", "Bash", "Edit", "Write"],
  full: ["Read", "Grep", "Bash", "Edit", "Write"],
};
const botCommands = [
  { command: "start", description: "Connect to Saturn Dispatch" },
  { command: "help", description: "Show Dispatch help" },
  { command: "new", description: "Start a fresh Saturn chat" },
  { command: "reset", description: "Clear the current session" },
  { command: "clear", description: "Clear session or settings" },
  { command: "status", description: "Show active session status" },
  { command: "session", description: "Show the current session id" },
  { command: "settings", description: "Show route, runtime, project, and tools" },
  { command: "project", description: "Set or list project directories" },
  { command: "projects", description: "List recent project directories" },
  { command: "cwd", description: "Set the project working directory" },
  { command: "dirs", description: "List recent project directories" },
  { command: "agent", description: "Route new chats through a saved agent" },
  { command: "agents", description: "List saved agents" },
  { command: "cli", description: "Set Codex or Claude backend" },
  { command: "model", description: "Set or clear the model" },
  { command: "think", description: "Set or clear reasoning effort" },
  { command: "tools", description: "Set Claude tool allowlist" },
  { command: "mcp", description: "Toggle MCP tools for new sessions" },
  { command: "timeout", description: "Set new-session timeout" },
  { command: "prompt", description: "Set ad-hoc system prompt" },
  { command: "verbose", description: "Toggle dashboard links" },
];

if (!allowAll && allowedChatIds.size === 0) {
  throw new Error("Set TELEGRAM_ALLOWED_CHAT_IDS, or set TELEGRAM_ALLOW_ALL=1 for local testing.");
}

let state = await loadState();
await ensureDefaultDispatchCwd();
await refreshBotIdentity();
await syncBotCommands();
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

  if (text.startsWith("/")) {
    const handled = await handleCommand(chatId, text);
    if (handled) return;
  }

  await dispatchMessage(chatId, text);
}

async function handleCommand(chatId, text) {
  const [rawCommand] = text.split(/\s+/);
  const command = rawCommand.split("@")[0].toLowerCase();
  const arg = text.slice(rawCommand.length).trim();

  if (command === "/start" || command === "/help") {
    await sendMessage(chatId, helpText());
    return true;
  }

  if (command === "/session") {
    const sessionId = state.chats?.[chatId]?.session_id;
    await sendMessage(chatId, sessionId ? `Current session: ${sessionId}` : "No session yet.");
    return true;
  }

  if (command === "/status") {
    await sendStatus(chatId);
    return true;
  }

  if (command === "/settings") {
    await sendSettings(chatId);
    return true;
  }

  if (command === "/new") {
    clearSessionMapping(chatId);
    await saveState();
    if (arg) {
      await dispatchMessage(chatId, arg);
    } else {
      await sendMessage(chatId, "New session ready. Send the next task, or use /new <task>.");
    }
    return true;
  }

  if (command === "/reset" || command === "/clear") {
    if (arg === "settings" || arg === "all") {
      state.chats[chatId] = { queue: [] };
      await saveState();
      await sendMessage(chatId, "Dispatch settings and session mapping cleared for this Telegram chat.");
    } else {
      clearSessionMapping(chatId);
      await saveState();
      await sendMessage(chatId, "Session mapping cleared. Send the next task to start fresh.");
    }
    return true;
  }

  if (command === "/think") {
    await setReasoning(chatId, arg);
    return true;
  }

  if (command === "/model") {
    await setModel(chatId, arg);
    return true;
  }

  if (command === "/cli") {
    await setCli(chatId, arg);
    return true;
  }

  if (command === "/agent") {
    await setAgent(chatId, arg);
    return true;
  }

  if (command === "/agents") {
    await sendAgents(chatId);
    return true;
  }

  if (command === "/project" || command === "/cwd") {
    await setProject(chatId, arg);
    return true;
  }

  if (command === "/projects" || command === "/dirs") {
    await sendProjects(chatId);
    return true;
  }

  if (command === "/tools") {
    await setTools(chatId, arg);
    return true;
  }

  if (command === "/mcp") {
    await setMcp(chatId, arg);
    return true;
  }

  if (command === "/timeout") {
    await setTimeoutSeconds(chatId, arg);
    return true;
  }

  if (command === "/prompt") {
    await setPrompt(chatId, arg);
    return true;
  }

  if (command === "/verbose") {
    await setVerbose(chatId, arg);
    return true;
  }

  return false;
}

function helpText() {
  return [
    "Saturn Dispatch is connected.",
    "",
    "Send messages normally. If a turn is running, follow-ups are queued and sent next.",
    "",
    "Session",
    "/new <task> starts a fresh Saturn chat.",
    "/new, /reset, or /clear clears the current session mapping.",
    "/session shows the current Saturn session id.",
    "/status shows status, turns, queue, and active route.",
    "/settings shows this chat's Dispatch settings.",
    "",
    "Routing",
    "/project list shows recent projects.",
    "/project <number|path|off> sets the cwd for new ad-hoc chats; off returns to Dispatch workspace.",
    "/agent <id|off> routes new chats through a saved agent.",
    "/agents lists saved agents.",
    "",
    "Runtime",
    "/cli <codex|claude-personal|claude-bedrock|claude-local> sets backend.",
    "/model <id|off> sets or clears the model.",
    "/think <minimal|low|medium|high|xhigh|max|off> sets reasoning.",
    "/tools <preset|csv|off> sets Claude allowed tools. Presets: none, read, code, full.",
    "/mcp <on|off> toggles MCP tools for the session.",
    "/timeout <seconds|off> sets new-chat timeout.",
    "/prompt <text|off> sets the ad-hoc system prompt.",
    "/verbose <on|off> toggles dashboard links.",
    "/clear settings resets every Dispatch setting for this chat.",
  ].join("\n");
}

async function setReasoning(chatId, arg) {
  const effort = arg.trim().toLowerCase();
  if (!effort) {
    await sendMessage(chatId, "Use /think <minimal|low|medium|high|xhigh|max|off>.");
    return;
  }
  if (effort === "off" || effort === "default" || effort === "none") {
    delete state.chats[chatId].reasoningEffort;
    await saveState();
    await sendMessage(chatId, "Reasoning override cleared.");
    return;
  }
  if (!reasoningValues.has(effort)) {
    await sendMessage(chatId, "Use /think minimal, low, medium, high, xhigh, max, or off.");
    return;
  }
  state.chats[chatId].reasoningEffort = effort === "max" && normalizeCliValue(state.chats[chatId].cli) === "codex" ? "xhigh" : effort;
  await saveState();
  await sendMessage(chatId, `Reasoning set to ${state.chats[chatId].reasoningEffort}.`);
}

async function setModel(chatId, arg) {
  const model = arg.trim();
  if (!model) {
    await sendMessage(chatId, "Use /model <model-id> or /model off.");
    return;
  }
  if (["off", "default", "none"].includes(model.toLowerCase())) {
    delete state.chats[chatId].model;
    await saveState();
    await sendMessage(chatId, "Model override cleared.");
    return;
  }
  state.chats[chatId].model = model;
  await saveState();
  await sendMessage(chatId, `Model set to ${model}.`);
}

async function setCli(chatId, arg) {
  const cli = normalizeCliValue(arg.trim());
  if (!cli) {
    await sendMessage(chatId, "Use /cli codex, /cli claude-personal, /cli claude-bedrock, or /cli claude-local.");
    return;
  }
  state.chats[chatId].cli = cli;
  clearSessionMapping(chatId);
  await saveState();
  await sendMessage(chatId, `CLI set to ${cli}. New session ready; send a task or use /new <task>.`);
}

async function setAgent(chatId, arg) {
  const agentId = arg.trim();
  if (!agentId) {
    await sendMessage(chatId, "Use /agent <agent-id> or /agent off. Use /agents to list saved agents.");
    return;
  }
  if (["off", "none", "adhoc", "ad-hoc"].includes(agentId.toLowerCase())) {
    delete state.chats[chatId].agent_id;
    clearSessionMapping(chatId);
    await saveState();
    await sendMessage(chatId, "Agent routing disabled. New sessions will use ad-hoc Dispatch settings.");
    return;
  }
  const agent = await findAgent(agentId);
  if (!agent) {
    await sendMessage(chatId, `Agent not found: ${agentId}\nUse /agents to list saved agents.`);
    return;
  }
  state.chats[chatId].agent_id = agent.id;
  clearSessionMapping(chatId);
  await saveState();
  await sendMessage(chatId, `New sessions will use agent ${agent.id}.`);
}

async function sendAgents(chatId) {
  const agents = await listAgents();
  if (!agents.length) {
    await sendMessage(chatId, "No saved dashboard agents found.");
    return;
  }
  await sendMessage(
    chatId,
    [
      "Saved agents:",
      ...agents.slice(0, 30).map((agent) => {
        const cli = agent.defaultCli || agent.cli || "default";
        return `${agent.id} - ${agent.name || agent.id} (${cli})`;
      }),
      "",
      "Use /agent <id> to route new sessions through one.",
    ].join("\n"),
  );
}

async function setProject(chatId, arg) {
  const value = arg.trim();
  if (!value || value === "list") {
    await sendProjects(chatId);
    return;
  }
  if (["off", "none", "default"].includes(value.toLowerCase())) {
    delete state.chats[chatId].cwd;
    clearSessionMapping(chatId);
    await saveState();
    await sendMessage(
      chatId,
      `Project override cleared. New sessions will use the Dispatch workspace:\n${effectiveProjectCwd(state.chats[chatId])}`,
    );
    return;
  }

  const recent = await listProjects();
  const byNumber = Number(value);
  const candidate = Number.isInteger(byNumber) && byNumber >= 1 && byNumber <= recent.length
    ? recent[byNumber - 1]
    : value;
  const dir = await assertDirectory(candidate).catch((err) => err);
  if (dir instanceof Error) {
    await sendMessage(chatId, dir.message);
    return;
  }

  state.chats[chatId].cwd = dir;
  clearSessionMapping(chatId);
  await saveState();
  await recordProject(dir).catch(() => {});
  await sendMessage(chatId, `Project set to:\n${dir}\nNew session ready; send a task or use /new <task>.`);
}

async function sendProjects(chatId) {
  const projects = await listProjects();
  if (!projects.length) {
    await sendMessage(chatId, "No recent projects found. Use /project /absolute/path.");
    return;
  }
  await sendMessage(
    chatId,
    [
      "Projects:",
      ...projects.slice(0, 20).map((dir, index) => `${index + 1}. ${formatProjectOption(dir)}`),
      "",
      "Use /project <number> or /project /absolute/path.",
    ].join("\n"),
  );
}

async function setTools(chatId, arg) {
  const value = arg.trim();
  if (!value) {
    await sendMessage(chatId, "Use /tools <none|read|code|full|comma,separated,tools|off>.");
    return;
  }
  const normalized = value.toLowerCase();
  if (["off", "default"].includes(normalized)) {
    delete state.chats[chatId].allowedTools;
    clearSessionMapping(chatId);
    await saveState();
    await sendMessage(chatId, "Allowed tools override cleared.");
    return;
  }
  const tools = toolPresets[normalized] ?? csv(value);
  if (!tools?.length) {
    await sendMessage(chatId, "Provide at least one tool name, a preset, or /tools off.");
    return;
  }
  state.chats[chatId].allowedTools = tools;
  clearSessionMapping(chatId);
  await saveState();
  await sendMessage(chatId, `Allowed tools set to: ${formatAllowedTools(tools)}.`);
}

async function setMcp(chatId, arg) {
  const value = arg.trim().toLowerCase();
  if (!["on", "off"].includes(value)) {
    await sendMessage(chatId, "Use /mcp on or /mcp off.");
    return;
  }
  state.chats[chatId].mcpTools = value === "on";
  clearSessionMapping(chatId);
  await saveState();
  await sendMessage(chatId, `MCP tools ${value}. New session ready; send a task or use /new <task>.`);
}

async function setTimeoutSeconds(chatId, arg) {
  const value = arg.trim().toLowerCase();
  if (!value) {
    await sendMessage(chatId, "Use /timeout <seconds> or /timeout off.");
    return;
  }
  if (["off", "default", "none"].includes(value)) {
    delete state.chats[chatId].timeout_seconds;
    clearSessionMapping(chatId);
    await saveState();
    await sendMessage(chatId, "Timeout override cleared.");
    return;
  }
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 1) {
    await sendMessage(chatId, "Timeout must be a whole number of seconds.");
    return;
  }
  state.chats[chatId].timeout_seconds = seconds;
  clearSessionMapping(chatId);
  await saveState();
  await sendMessage(chatId, `Timeout set to ${seconds} seconds for new sessions.`);
}

async function setPrompt(chatId, arg) {
  const value = arg.trim();
  if (!value) {
    await sendMessage(chatId, "Use /prompt <system prompt text> or /prompt off.");
    return;
  }
  if (["off", "default", "none"].includes(value.toLowerCase())) {
    delete state.chats[chatId].prompt;
    clearSessionMapping(chatId);
    await saveState();
    await sendMessage(chatId, "Ad-hoc prompt override cleared.");
    return;
  }
  state.chats[chatId].prompt = value;
  clearSessionMapping(chatId);
  await saveState();
  await sendMessage(chatId, "Ad-hoc prompt set for new sessions.");
}

async function setVerbose(chatId, arg) {
  const value = arg.trim().toLowerCase();
  if (!["on", "off"].includes(value)) {
    await sendMessage(chatId, "Use /verbose on or /verbose off.");
    return;
  }
  state.chats[chatId].verbose = value === "on";
  await saveState();
  await sendMessage(chatId, `Verbose mode ${value}.`);
}

async function sendSettings(chatId) {
  ensureChat(chatId);
  const chat = state.chats[chatId];
  const sessionId = chat.session_id;
  const route = chat.agent_id ? `agent ${chat.agent_id}` : "ad-hoc";
  await sendMessage(
    chatId,
    [
      "Dispatch settings",
      `Route: ${route}`,
      `Session: ${sessionId || "none"}`,
      `CLI: ${chat.cli || process.env.SATURN_ADHOC_CLI || process.env.SATURN_CLI || "claude-bedrock"}`,
      `Model: ${chat.model || process.env.SATURN_ADHOC_MODEL || process.env.SATURN_MODEL || "default"}`,
      `Reasoning: ${chat.reasoningEffort || process.env.SATURN_ADHOC_REASONING_EFFORT || process.env.SATURN_REASONING_EFFORT || "default"}`,
      `Project: ${projectDisplay(chat)}`,
      `Tools: ${chat.allowedTools ? formatAllowedTools(chat.allowedTools) : formatAllowedToolsCsv(process.env.SATURN_ADHOC_ALLOWED_TOOLS) || "default"}`,
      `MCP tools: ${chat.mcpTools === undefined ? "default" : chat.mcpTools ? "on" : "off"}`,
      `Timeout: ${chat.timeout_seconds || process.env.SATURN_ADHOC_TIMEOUT_SECONDS || "default"}`,
      `Verbose: ${chat.verbose ? "on" : "off"}`,
      chat.prompt ? "Prompt: custom" : `Prompt: ${process.env.SATURN_ADHOC_PROMPT ? "launchd default" : "default"}`,
    ].join("\n"),
  );
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
    cli: chat.cli || process.env.SATURN_CLI || undefined,
    model: chat.model || process.env.SATURN_MODEL || undefined,
    reasoningEffort: chat.reasoningEffort || process.env.SATURN_REASONING_EFFORT || undefined,
    mcpTools: chat.mcpTools,
  };

  const agentId = chat.agent_id || process.env.SATURN_AGENT_ID;
  if (agentId) {
    return { ...body, agent_id: agentId };
  }

  return {
    ...body,
    adhoc_config: {
      cli: chat.cli || process.env.SATURN_ADHOC_CLI || process.env.SATURN_CLI || "claude-bedrock",
      model: chat.model || process.env.SATURN_ADHOC_MODEL || process.env.SATURN_MODEL || undefined,
      reasoningEffort:
        chat.reasoningEffort ||
        process.env.SATURN_ADHOC_REASONING_EFFORT ||
        process.env.SATURN_REASONING_EFFORT ||
        undefined,
      prompt: chat.prompt || process.env.SATURN_ADHOC_PROMPT || defaultPrompt,
      cwd: effectiveProjectCwd(chat),
      allowedTools: chat.allowedTools ?? csv(process.env.SATURN_ADHOC_ALLOWED_TOOLS),
      timeout_seconds: chat.timeout_seconds || numberOrUndefined(process.env.SATURN_ADHOC_TIMEOUT_SECONDS),
    },
  };
}

function buildMessageBody(chat, message) {
  return {
    message,
    cli: chat.cli || process.env.SATURN_CLI || undefined,
    model: chat.model || process.env.SATURN_MODEL || undefined,
    mcpTools: chat.mcpTools,
    reasoningEffort: chat.reasoningEffort || process.env.SATURN_REASONING_EFFORT || undefined,
  };
}

async function monitorSession(chatId, sessionId) {
  const monitorKey = `${chatId}:${sessionId}`;
  if (pendingMonitors.has(monitorKey)) return;
  pendingMonitors.add(monitorKey);

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
        pendingMonitors.delete(monitorKey);
        await drainQueuedMessages(chatId);
        return;
      }
      await sendChatAction(chatId, "typing").catch(() => {});
      await sleep(waitIntervalMs);
    }

    await sendMessage(chatId, `Session is still running: ${sessionId}`);
  } finally {
    pendingMonitors.delete(monitorKey);
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
    chat.cli ? `CLI: ${chat.cli}` : null,
    chat.model ? `Model: ${chat.model}` : null,
    chat.reasoningEffort ? `Reasoning: ${chat.reasoningEffort}` : null,
    chat.agent_id ? null : `Project: ${projectDisplay(chat)}`,
    chat.allowedTools ? `Tools: ${formatAllowedTools(chat.allowedTools)}` : null,
    chat.timeout_seconds ? `Timeout: ${chat.timeout_seconds}s` : null,
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

function normalizeCliValue(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "claude") return "claude-bedrock";
  return cliValues.has(normalized) ? normalized : "";
}

function expandHome(dir) {
  if (dir === "~") return process.env.HOME || dir;
  if (dir.startsWith("~/")) return path.join(process.env.HOME || "", dir.slice(2));
  return dir;
}

function normalizeDir(dir) {
  return path.resolve(expandHome(dir.trim()));
}

async function assertDirectory(dir) {
  const normalized = normalizeDir(dir);
  const stat = await fs.stat(normalized).catch(() => null);
  if (!stat?.isDirectory()) throw new Error(`Directory not found: ${normalized}`);
  return normalized;
}

async function ensureDefaultDispatchCwd() {
  await fs.mkdir(defaultDispatchCwd, { recursive: true });
}

function effectiveProjectCwd(chat) {
  return chat?.cwd || process.env.SATURN_ADHOC_CWD || defaultDispatchCwd;
}

function projectDisplay(chat) {
  if (chat?.cwd) return chat.cwd;
  if (process.env.SATURN_ADHOC_CWD) return `${process.env.SATURN_ADHOC_CWD} (launchd default)`;
  return `${defaultDispatchCwd} (Dispatch default)`;
}

function formatProjectOption(dir) {
  if (dir === defaultDispatchCwd) return `${dir} (Dispatch default)`;
  if (process.env.SATURN_ADHOC_CWD && normalizeDir(process.env.SATURN_ADHOC_CWD) === dir) {
    return `${dir} (launchd default)`;
  }
  return dir;
}

async function listAgents() {
  const file = path.join(root, "agents.json");
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    return (parsed.agents || []).filter((agent) => agent && typeof agent.id === "string");
  } catch {
    return [];
  }
}

async function findAgent(agentId) {
  const agents = await listAgents();
  return agents.find((agent) => agent.id === agentId);
}

async function listProjects() {
  const seen = new Set();
  const projects = [];
  const add = async (dir) => {
    if (!dir) return;
    const normalized = normalizeDir(dir);
    if (seen.has(normalized)) return;
    const stat = await fs.stat(normalized).catch(() => null);
    if (!stat?.isDirectory()) return;
    seen.add(normalized);
    projects.push(normalized);
  };

  try {
    const parsed = JSON.parse(await fs.readFile(path.join(root, "working-directories.json"), "utf8"));
    for (const entry of parsed.directories || []) await add(entry.path);
  } catch {}

  for (const dir of [
    defaultDispatchCwd,
    process.env.SATURN_ADHOC_CWD,
    root,
    path.join(process.env.HOME || "", "programming"),
    path.join(process.env.HOME || "", "Desktop"),
  ]) {
    await add(dir);
  }

  return projects;
}

async function recordProject(dir) {
  const file = path.join(root, "working-directories.json");
  let parsed = { directories: [] };
  try {
    parsed = JSON.parse(await fs.readFile(file, "utf8"));
  } catch {}
  const normalized = normalizeDir(dir);
  const entry = { path: normalized, last_used_at: new Date().toISOString() };
  const directories = [
    entry,
    ...(parsed.directories || []).filter((item) => item?.path && normalizeDir(item.path) !== normalized),
  ].slice(0, 75);
  await fs.writeFile(file, JSON.stringify({ directories }, null, 2), "utf8");
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

async function syncBotCommands() {
  try {
    await telegram("setMyCommands", {
      commands: botCommands,
      scope: { type: "default" },
    });
    state.bot_commands_synced_at = new Date().toISOString();
    await saveState();
  } catch (err) {
    console.error("[telegram-dispatch] setMyCommands failed", err);
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
  if (Array.isArray(state.chats[chatId].allowedTools) && state.chats[chatId].allowedTools.length === 0) {
    state.chats[chatId].allowedTools = [noToolsSentinel];
  }
}

function clearSessionMapping(chatId) {
  ensureChat(chatId);
  delete state.chats[chatId].session_id;
  delete state.chats[chatId].pending_session_id;
  state.chats[chatId].queue = [];
}

function formatAllowedTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0 || tools.includes(noToolsSentinel)) return "none";
  return tools.join(", ");
}

function formatAllowedToolsCsv(value) {
  const tools = csv(value);
  return tools ? formatAllowedTools(tools) : "";
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
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
