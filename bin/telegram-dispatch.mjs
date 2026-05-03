#!/usr/bin/env node
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTelegramStateManager, NO_TOOLS_SENTINEL } from "./lib/telegram-state.mjs";
import { parseCommandLine, helpText } from "./lib/telegram-router.mjs";

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
const modelSelectionTtlMs = 30 * 60 * 1000;
const requestedMaxQueueMessages = Number(process.env.TELEGRAM_MAX_QUEUE_MESSAGES || 25);
const maxQueueMessages =
  Number.isFinite(requestedMaxQueueMessages) && requestedMaxQueueMessages > 0
    ? Math.floor(requestedMaxQueueMessages)
    : 25;
const requestedMaxSentMediaSessions = Number(process.env.TELEGRAM_MAX_SENT_MEDIA_SESSIONS || 25);
const maxSentMediaSessions =
  Number.isFinite(requestedMaxSentMediaSessions) && requestedMaxSentMediaSessions > 0
    ? Math.floor(requestedMaxSentMediaSessions)
    : 25;
const requestedMaxTelegramMedia = Number(process.env.TELEGRAM_MAX_MEDIA_PER_TURN || 6);
const maxTelegramMediaPerTurn =
  Number.isFinite(requestedMaxTelegramMedia) && requestedMaxTelegramMedia >= 0
    ? Math.floor(requestedMaxTelegramMedia)
    : 6;
const maxTelegramPhotoBytes = 10 * 1024 * 1024;
const maxTelegramDocumentBytes = 45 * 1024 * 1024;
const requestedMaxTelegramInboundImageBytes = Number(process.env.TELEGRAM_MAX_INBOUND_IMAGE_BYTES || 20 * 1024 * 1024);
const maxTelegramInboundImageBytes =
  Number.isFinite(requestedMaxTelegramInboundImageBytes) && requestedMaxTelegramInboundImageBytes > 0
    ? Math.floor(requestedMaxTelegramInboundImageBytes)
    : 20 * 1024 * 1024;
const allowAll = process.env.TELEGRAM_ALLOW_ALL === "1";
const allowedChatIds = new Set(
  (process.env.TELEGRAM_ALLOWED_CHAT_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);
const cliOptions = [
  { id: "claude-bedrock", label: "Claude (Bedrock)" },
  { id: "claude-personal", label: "Claude (Personal)" },
  { id: "claude-local", label: "Claude (Local)" },
  { id: "codex", label: "Codex" },
];
const cliValues = new Set([...cliOptions.map((cli) => cli.id), "claude"]);
const defaultPrompt = "You are Saturn Dispatch. Help the user from Telegram.";
const noToolsSentinel = NO_TOOLS_SENTINEL;
const imageExts = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".jpg",
  ".jpeg",
  ".png",
  ".svg",
  ".tif",
  ".tiff",
  ".webp",
]);
const telegramPhotoExts = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const imageMimeTypes = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
};
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
  { command: "models", description: "List available CLIs and models" },
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

// State management lives in lib/telegram-state.mjs. The manager owns the
// in-memory state object and the load/save/mutate helpers; we alias them
// at module scope so the rest of this file reads the same as before.
const stateMgr = await createTelegramStateManager({
  stateFile,
  maxQueueMessages,
  maxSentMediaSessions,
  allowAll,
  allowedChatIds,
});
let state = stateMgr.state;
const saveState = stateMgr.saveState;
const ensureChat = stateMgr.ensureChat;
const enqueueChatMessage = stateMgr.enqueueChatMessage;
const clearSessionMapping = stateMgr.clearSessionMapping;
const isAllowed = stateMgr.isAllowed;
const mediaSentKeys = stateMgr.mediaSentKeys;
const markMediaSent = stateMgr.markMediaSent;
const formatAllowedTools = stateMgr.formatAllowedTools;

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
  const text = String(message?.text || message?.caption || "").trim();
  const imageSpecs = telegramImageSpecs(message);
  if (!chatId || (!text && imageSpecs.length === 0)) return;

  if (!isAllowed(chatId)) {
    await sendMessage(chatId, "This chat is not authorized for Saturn Dispatch.");
    return;
  }
  ensureChat(chatId);
  await saveState();

  if (text.startsWith("/")) {
    const { command } = parseCommandLine(text);
    if (command !== "/new") {
      const handled = await handleCommand(chatId, text);
      if (handled) {
        if (imageSpecs.length > 0) {
          await sendMessage(chatId, "Attached image was not sent because that message was handled as a command. Send the image as a normal message, or attach it to /new <caption>.");
        }
        return;
      }
    }
  }

  let attachments = [];
  if (imageSpecs.length > 0) {
    try {
      attachments = await downloadTelegramImageAttachments(chatId, message, imageSpecs);
    } catch (err) {
      await sendMessage(chatId, `Could not download the attached image: ${friendlyError(err)}`);
      return;
    }
  }

  if (text.startsWith("/")) {
    const handled = await handleCommand(chatId, text, attachments);
    if (handled) return;
  }

  if (attachments.length === 0 && (await handleModelSelectionReply(chatId, text))) return;

  if (state.chats[chatId].model_choices) {
    delete state.chats[chatId].model_choices;
    await saveState();
  }

  await dispatchMessage(chatId, telegramPromptText(text, attachments), attachments);
}

async function handleCommand(chatId, text, attachments = []) {
  const { command, arg } = parseCommandLine(text);

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
    if (arg || attachments.length > 0) {
      await dispatchMessage(chatId, telegramPromptText(arg, attachments), attachments);
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

  if (command === "/models") {
    await sendModels(chatId, arg);
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

async function setReasoning(chatId, arg) {
  const effort = arg.trim().toLowerCase();
  const chat = state.chats[chatId];
  const cli = effectiveCli(chat);
  const model = effectiveModel(chat);
  let caps;
  try {
    caps = await modelCapabilities(cli, model);
  } catch (err) {
    await sendMessage(chatId, `Could not load reasoning levels from Saturn: ${friendlyError(err)}`);
    return;
  }

  if (!effort) {
    const modelLabel = caps.model?.id || model || "backend default";
    await sendMessage(
      chatId,
      caps.efforts.length
        ? [
            `Reasoning levels for ${modelLabel}: ${caps.efforts.join(", ")}`,
            `Current: ${chat.reasoningEffort || "default"}`,
            "Use /think <level> or /think off.",
          ].join("\n")
        : [
            `No reasoning levels were reported for ${modelLabel}.`,
            "Use /models to choose a model, or /think off to clear the override.",
          ].join("\n"),
    );
    return;
  }
  if (effort === "off" || effort === "default" || effort === "none") {
    delete chat.reasoningEffort;
    await saveState();
    await sendMessage(chatId, "Reasoning override cleared.");
    return;
  }
  if (!caps.efforts.includes(effort)) {
    await sendMessage(
      chatId,
      caps.efforts.length
        ? `That level is not available for ${caps.model?.id || model || cli}. Use one of: ${caps.efforts.join(", ")}.`
        : `No reasoning levels were reported for ${caps.model?.id || model || cli}.`,
    );
    return;
  }
  chat.reasoningEffort = effort;
  await saveState();
  await sendMessage(chatId, `Reasoning set to ${chat.reasoningEffort}.`);
}

async function setModel(chatId, arg) {
  const model = arg.trim();
  if (!model) {
    await sendMessage(chatId, "Use /model <model-id> or /model off.");
    return;
  }
  if (["off", "default", "none"].includes(model.toLowerCase())) {
    delete state.chats[chatId].model;
    delete state.chats[chatId].model_choices;
    await saveState();
    await sendMessage(chatId, "Model override cleared.");
    return;
  }
  const chat = state.chats[chatId];
  chat.model = model;
  delete chat.model_choices;
  let reasoningNote = "";
  if (chat.reasoningEffort) {
    const cli = effectiveCli(chat);
    const caps = await modelCapabilities(cli, model).catch(() => null);
    const selected = caps?.models.find((item) => item?.id === model);
    const efforts = normalizeEffortList(selected?.supportedReasoningEfforts);
    if (selected && !efforts.includes(chat.reasoningEffort)) {
      reasoningNote = `Reasoning override cleared; ${model} supports ${efforts.length ? efforts.join(", ") : "no effort levels"}.`;
      delete chat.reasoningEffort;
    }
  }
  await saveState();
  await sendMessage(chatId, ["Model set to " + model + ".", reasoningNote].filter(Boolean).join("\n"));
}

async function setCli(chatId, arg) {
  const cli = normalizeCliValue(arg.trim());
  if (!cli) {
    await sendMessage(chatId, `Use /cli ${cliOptions.map((option) => option.id).join(", /cli ")}.\nUse /models to list model ids.`);
    return;
  }
  state.chats[chatId].cli = cli;
  delete state.chats[chatId].model_choices;
  clearSessionMapping(chatId);
  await saveState();
  await sendMessage(chatId, `CLI set to ${cli}. New session ready; send a task or use /new <task>.`);
}

async function sendModels(chatId, arg = "") {
  ensureChat(chatId);
  const requestedCli = arg.trim();
  let options = cliOptions;
  if (requestedCli) {
    const cli = normalizeCliValue(requestedCli);
    if (!cli) {
      await sendMessage(
        chatId,
        [
          `Unknown CLI: ${requestedCli}`,
          `Use /models or /models <${cliOptions.map((option) => option.id).join("|")}>.`,
        ].join("\n"),
      );
      return;
    }
    options = cliOptions.filter((option) => option.id === cli);
  }

  const chat = state.chats[chatId];
  const currentCli = effectiveCli(chat);
  const currentModel = effectiveModel(chat) || "default";
  const choices = [];
  const sections = [
    "Available Dispatch CLIs and models",
    `Current: /cli ${currentCli}, /model ${currentModel}`,
    "",
    "Reply with a number to select that model.",
    "Use /model <id> to type a model manually, or /model off for the backend default.",
    requestedCli ? "" : "Use /models <cli> to show one backend.",
  ].filter(Boolean);

  for (const option of options) {
    const result = await formatModelsForCli(option, choices.length + 1);
    sections.push("", result.text);
    choices.push(...result.choices);
  }

  if (choices.length) {
    chat.model_choices = {
      created_at: new Date().toISOString(),
      choices,
    };
  } else {
    delete chat.model_choices;
  }
  await saveState();

  await sendLongMessage(chatId, sections.join("\n"));
}

async function formatModelsForCli(option, startIndex) {
  const header = `${option.label}\nCLI: /cli ${option.id}`;
  try {
    const data = await saturn(`/api/models?cli=${encodeURIComponent(option.id)}`, { method: "GET" });
    const models = Array.isArray(data.models) ? data.models : [];
    if (!models.length) return { text: `${header}\nModels: none returned`, choices: [] };
    const choices = models
      .map((model, offset) => modelChoiceFromModel(option, model, startIndex + offset))
      .filter(Boolean);
    return {
      choices,
      text: [
        header,
        "Models:",
        ...choices.map((choice) => `${choice.index}. ${formatModelChoiceLine(choice)}`),
      ].join("\n"),
    };
  } catch (err) {
    return {
      text: [
        header,
        `Models: could not load from Saturn (${friendlyError(err)})`,
      ].join("\n"),
      choices: [],
    };
  }
}

function modelChoiceFromModel(option, model, index) {
  const id = String(model?.id || "").trim();
  if (!id) return null;
  return {
    index,
    cli: option.id,
    cliLabel: option.label,
    modelId: id,
    name: String(model?.name || "").trim(),
    contextWindow: model?.loadedContextWindow || model?.contextWindow,
    defaultReasoningEffort: typeof model?.defaultReasoningEffort === "string" ? model.defaultReasoningEffort : "",
    supportedReasoningEfforts: normalizeEffortList(model?.supportedReasoningEfforts),
  };
}

function formatModelChoiceLine(choice) {
  const id = String(choice?.modelId || "").trim();
  if (!id) return "(missing id)";
  const name = String(choice?.name || "").trim();
  const context = formatTokenCount(choice?.contextWindow);
  const details = [
    name && name !== id ? name : "",
    context ? `${context} ctx` : "",
    formatReasoningChoice(choice),
    choice?.cli ? `/cli ${choice.cli}` : "",
  ].filter(Boolean);
  return details.length ? `${id} - ${details.join(", ")}` : id;
}

function formatReasoningChoice(choice) {
  const efforts = normalizeEffortList(choice?.supportedReasoningEfforts);
  if (!efforts.length) return "no effort levels";
  const defaultEffort = String(choice?.defaultReasoningEffort || "");
  return defaultEffort && efforts.includes(defaultEffort)
    ? `effort ${efforts.join("/")}; default ${defaultEffort}`
    : `effort ${efforts.join("/")}`;
}

async function handleModelSelectionReply(chatId, text) {
  ensureChat(chatId);
  const choiceNumber = parseModelSelectionNumber(text);
  if (!choiceNumber) return false;

  const selection = state.chats[chatId].model_choices;
  const choices = Array.isArray(selection?.choices) ? selection.choices : [];
  if (!choices.length) return false;

  if (isModelSelectionExpired(selection.created_at)) {
    delete state.chats[chatId].model_choices;
    await saveState();
    await sendMessage(chatId, "That model list expired. Send /models again, then reply with a number.");
    return true;
  }

  const choice = choices.find((item) => item.index === choiceNumber);
  if (!choice) {
    await sendMessage(chatId, `Choose a number from 1-${choices.length}, or send /models again.`);
    return true;
  }

  const chat = state.chats[chatId];
  const previousCli = normalizeCliValue(chat.cli || process.env.SATURN_ADHOC_CLI || process.env.SATURN_CLI) || "claude-bedrock";
  chat.cli = choice.cli;
  chat.model = choice.modelId;
  delete chat.model_choices;
  let reasoningNote = "";
  const choiceEfforts = normalizeEffortList(choice.supportedReasoningEfforts);
  if (chat.reasoningEffort && !choiceEfforts.includes(chat.reasoningEffort)) {
    reasoningNote = `Reasoning override cleared; ${choice.modelId} supports ${choiceEfforts.length ? choiceEfforts.join(", ") : "no effort levels"}.`;
    delete chat.reasoningEffort;
  }

  if (choice.cli !== previousCli) {
    clearSessionMapping(chatId);
  }

  await saveState();
  await sendMessage(
    chatId,
    [
      `Model set to ${choice.modelId}.`,
      `CLI set to ${choice.cli}.`,
      reasoningNote,
      choice.cli !== previousCli ? "New session ready; send a task or use /new <task>." : "Use /new <task> to start fresh if needed.",
    ].filter(Boolean).join("\n"),
  );
  return true;
}

function parseModelSelectionNumber(text) {
  const match = String(text || "").trim().match(/^(\d+)(?:[\s.)\]:,-].*)?$/);
  if (!match) return 0;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function isModelSelectionExpired(createdAt) {
  const createdMs = Date.parse(createdAt || "");
  return !Number.isFinite(createdMs) || Date.now() - createdMs > modelSelectionTtlMs;
}

function effectiveCli(chat) {
  return normalizeCliValue(chat?.cli || process.env.SATURN_ADHOC_CLI || process.env.SATURN_CLI) || "claude-bedrock";
}

function effectiveModel(chat) {
  return chat?.model || process.env.SATURN_ADHOC_MODEL || process.env.SATURN_MODEL || "";
}

function normalizeEffortList(values) {
  if (!Array.isArray(values)) return [];
  const out = [];
  for (const value of values) {
    if (typeof value !== "string" || !value.trim() || out.includes(value.trim())) continue;
    out.push(value.trim());
  }
  return out;
}

async function modelCapabilities(cli, modelId) {
  const data = await saturn(`/api/models?cli=${encodeURIComponent(cli)}`, { method: "GET" });
  const models = Array.isArray(data.models) ? data.models : [];
  const requestedModel = String(modelId || "").trim();
  const exact = models.find((item) => item?.id === requestedModel) || null;
  const model = exact || (!requestedModel || requestedModel === "default" ? models[0] || null : null);
  return {
    models,
    model,
    efforts: normalizeEffortList(model?.supportedReasoningEfforts),
  };
}

function formatTokenCount(tokens) {
  const value = Number(tokens);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value >= 1_000_000) {
    const millions = value / 1_000_000;
    return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }
  if (value >= 1_000) return `${Math.round(value / 1_000)}K`;
  return String(value);
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

async function dispatchMessage(chatId, text, attachments = []) {
  ensureChat(chatId);
  const chat = state.chats[chatId];

  if (chat.pending_session_id && (await isSessionRunning(chat.pending_session_id))) {
    const queued = enqueueChatMessage(chatId, text, attachments);
    await saveState();
    await sendMessage(
      chatId,
      `Queued. ${queued.length} message${queued.length === 1 ? "" : "s"} waiting${queued.dropped ? `; dropped ${queued.dropped} oldest` : ""}.${attachmentSummary(attachments)}`,
    );
    return;
  }

  let sessionId = chat.session_id;
  if (!sessionId) {
    const created = await postSaturnPayload("/api/sessions", buildCreateSessionBody(chat, text), attachments);
    sessionId = created.session_id;
    chat.session_id = sessionId;
  } else {
    try {
      await postSaturnPayload(`/api/sessions/${sessionId}/messages`, buildMessageBody(chat, text), attachments);
    } catch (err) {
      if (String(err.message || err).includes("409")) {
        const queued = enqueueChatMessage(chatId, text, attachments);
        await saveState();
        await sendMessage(
          chatId,
          `Queued. ${queued.length} message${queued.length === 1 ? "" : "s"} waiting${queued.dropped ? `; dropped ${queued.dropped} oldest` : ""}.${attachmentSummary(attachments)}`,
        );
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

async function monitorSession(chatId, sessionId, notifyTimeout = true) {
  const monitorKey = `${chatId}:${sessionId}`;
  if (pendingMonitors.has(monitorKey)) return;
  pendingMonitors.add(monitorKey);

  const deadline = Date.now() + waitSeconds * 1000;
  try {
    while (Date.now() < deadline) {
      const session = await getSession(sessionId, { events: "recent", compact: true, metaFull: true });
      if (session?.meta?.status && session.meta.status !== "running") {
        const lastTurn = session.meta.turns?.[session.meta.turns.length - 1];
        const finalText = lastTurn?.final_text?.trim() || `(session finished with status ${session.meta.status})`;
        await sendLongMessage(chatId, finalText);
        await sendSessionMedia(chatId, session, lastTurn).catch(async (err) => {
          console.error("[telegram-dispatch] media send failed", chatId, sessionId, err);
          if (state.chats?.[chatId]?.verbose) {
            await sendMessage(chatId, `Could not send session media: ${friendlyError(err)}`).catch(() => {});
          }
        });

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

    if (notifyTimeout) {
      await sendMessage(chatId, `Session is still running: ${sessionId}`);
    }
    const retry = setTimeout(() => {
      monitorSession(chatId, sessionId, false).catch((err) => {
        console.error("[telegram-dispatch] monitor retry failed", chatId, sessionId, err);
      });
    }, Math.max(1000, waitIntervalMs));
    retry.unref?.();
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
  await dispatchMessage(chatId, next.text, next.attachments || []);
}

function telegramImageSpecs(message) {
  const specs = [];
  const photos = Array.isArray(message?.photo) ? message.photo : [];
  if (photos.length > 0) {
    const photo = photos.reduce((best, candidate) => {
      const bestScore = Number(best?.file_size || 0) || Number(best?.width || 0) * Number(best?.height || 0);
      const candidateScore =
        Number(candidate?.file_size || 0) || Number(candidate?.width || 0) * Number(candidate?.height || 0);
      return candidateScore >= bestScore ? candidate : best;
    }, photos[0]);
    if (photo?.file_id) {
      specs.push({
        kind: "photo",
        fileId: photo.file_id,
        fileUniqueId: photo.file_unique_id,
        fileName: `telegram-photo-${message.message_id || Date.now()}.jpg`,
        mimeType: "image/jpeg",
        fileSize: photo.file_size,
      });
    }
  }

  const document = message?.document;
  if (isTelegramImageDocument(document)) {
    specs.push({
      kind: "document",
      fileId: document.file_id,
      fileUniqueId: document.file_unique_id,
      fileName: document.file_name || `telegram-image-${message.message_id || Date.now()}`,
      mimeType: document.mime_type || mimeTypeForPath(document.file_name),
      fileSize: document.file_size,
    });
  }

  return specs;
}

function isTelegramImageDocument(document) {
  if (!document?.file_id) return false;
  const mimeType = String(document.mime_type || "").toLowerCase();
  const ext = path.extname(document.file_name || "").toLowerCase();
  return mimeType.startsWith("image/") || imageExts.has(ext);
}

async function downloadTelegramImageAttachments(chatId, message, specs) {
  const attachments = [];
  for (const spec of specs) {
    attachments.push(await downloadTelegramImageAttachment(chatId, message, spec));
  }
  return attachments;
}

async function downloadTelegramImageAttachment(chatId, message, spec) {
  if (Number(spec.fileSize || 0) > maxTelegramInboundImageBytes) {
    throw new Error(`image is too large (${formatBytes(Number(spec.fileSize))}); limit is ${formatBytes(maxTelegramInboundImageBytes)}`);
  }

  const file = await telegram("getFile", { file_id: spec.fileId });
  const telegramFilePath = file.result?.file_path;
  if (!telegramFilePath) throw new Error("Telegram did not return a file path");

  const telegramFileSize = Number(file.result?.file_size || spec.fileSize || 0);
  if (telegramFileSize > maxTelegramInboundImageBytes) {
    throw new Error(`image is too large (${formatBytes(telegramFileSize)}); limit is ${formatBytes(maxTelegramInboundImageBytes)}`);
  }

  const res = await fetch(`https://api.telegram.org/file/bot${token}/${telegramFilePath}`);
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`download failed: ${detail || res.statusText}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > maxTelegramInboundImageBytes) {
    throw new Error(`image is too large (${formatBytes(buffer.byteLength)}); limit is ${formatBytes(maxTelegramInboundImageBytes)}`);
  }

  const name = telegramAttachmentName(message, spec, telegramFilePath);
  const type = spec.mimeType || mimeTypeForPath(name) || "application/octet-stream";
  const dir = path.join(root, "telegram", "uploads", safeFileName(chatId));
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, buffer);

  return {
    name,
    path: filePath,
    size: buffer.byteLength,
    type,
  };
}

function telegramAttachmentName(message, spec, telegramFilePath) {
  const sourceName = spec.fileName || path.basename(telegramFilePath || "") || `telegram-${spec.kind}`;
  const sourceExt = path.extname(sourceName).toLowerCase();
  const telegramExt = path.extname(telegramFilePath || "").toLowerCase();
  const ext = imageExts.has(sourceExt)
    ? sourceExt
    : imageExts.has(telegramExt)
      ? telegramExt
      : mimeExt(spec.mimeType) || ".jpg";
  const stem = safeFileName(path.basename(sourceName, sourceExt)).slice(0, 80) || "telegram-image";
  const unique = safeFileName(spec.fileUniqueId || spec.fileId || spec.kind).slice(0, 48) || "image";
  return `${Date.now()}-${message?.message_id || "message"}-${unique}-${stem}${ext}`;
}

function telegramPromptText(text, attachments) {
  const trimmed = String(text || "").trim();
  if (trimmed) return trimmed;
  if (attachments.length === 1) return "Please inspect the attached image and respond.";
  return `Please inspect the attached ${attachments.length} images and respond.`;
}

function attachmentSummary(attachments) {
  if (!attachments?.length) return "";
  return ` Includes ${attachments.length} image${attachments.length === 1 ? "" : "s"}.`;
}

async function sendStatus(chatId) {
  const chat = state.chats?.[chatId];
  if (!chat?.session_id) {
    await sendMessage(chatId, "No session yet.");
    return;
  }
  const session = await getSession(chat.session_id, { events: "recent", compact: true });
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
  const session = await getSession(sessionId, { events: "recent", compact: true }).catch(() => null);
  return session?.meta?.status === "running";
}

async function getSession(sessionId, options = {}) {
  const params = new URLSearchParams();
  if (options.events) params.set("events", options.events);
  if (options.compact) params.set("compact", "1");
  if (options.metaFull) params.set("meta", "full");
  const query = params.size ? `?${params.toString()}` : "";
  return saturn(`/api/sessions/${sessionId}${query}`, { method: "GET" });
}

async function postSaturnPayload(route, payload, attachments = []) {
  if (!attachments.length) {
    return saturn(route, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  const form = new FormData();
  form.append("payload", JSON.stringify(payload));
  for (const attachment of attachments) {
    const buffer = await fs.readFile(attachment.path);
    form.append(
      "files",
      new Blob([buffer], { type: attachment.type || mimeTypeForPath(attachment.name) || "application/octet-stream" }),
      attachment.name || path.basename(attachment.path),
    );
  }

  return saturn(route, {
    method: "POST",
    body: form,
  });
}

async function saturn(route, init = {}) {
  const isFormData = typeof FormData !== "undefined" && init.body instanceof FormData;
  const res = await fetch(`${baseUrl}${route}`, {
    ...init,
    headers: isFormData
      ? { ...(init.headers || {}) }
      : {
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

async function telegramMultipart(method, form) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    body: form,
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

async function sendSessionMedia(chatId, session, lastTurn) {
  const sessionId =
    session?.meta?.session_id ||
    state.chats?.[chatId]?.pending_session_id ||
    state.chats?.[chatId]?.session_id ||
    "";
  const assets = await collectSessionImageAssets(chatId, session, lastTurn, sessionId);
  if (assets.length === 0) return;

  let sent = 0;
  for (const asset of assets) {
    if (sent >= maxTelegramMediaPerTurn) break;
    const delivered = await sendImageAsset(chatId, asset, sessionId);
    if (delivered) sent++;
  }
  await saveState();

  const remaining = assets.length - sent;
  if (remaining > 0 && state.chats?.[chatId]?.verbose) {
    await sendMessage(chatId, `${remaining} additional image${remaining === 1 ? "" : "s"} not sent to keep the Telegram update short.`);
  }
}

async function collectSessionImageAssets(chatId, session, lastTurn, sessionId) {
  const chat = state.chats?.[chatId] || {};
  const sentKeys = mediaSentKeys(chat, sessionId);
  const refs = extractImageRefs(sessionMediaSearchText(session, lastTurn));
  const assets = [];
  const seen = new Set();

  for (const ref of refs) {
    if (assets.length >= maxTelegramMediaPerTurn * 2) break;
    const asset = await resolveImageAsset(ref, session, chat);
    if (!asset) continue;
    const key = asset.key;
    if (seen.has(key) || sentKeys.has(key)) continue;
    seen.add(key);
    assets.push(asset);
  }

  return assets;
}

function sessionMediaSearchText(session, lastTurn) {
  const chunks = [];
  if (lastTurn?.final_text) chunks.push(lastTurn.final_text);
  for (const event of session?.events || []) {
    if (event?.kind === "assistant_text" || event?.kind === "plan_text") {
      chunks.push(String(event.text || ""));
    } else if (event?.kind === "tool_result") {
      chunks.push(searchableValue(event.content));
    } else if (event?.kind === "tool_use") {
      chunks.push(searchableValue(event.input));
    } else if (event?.raw) {
      chunks.push(searchableValue(event.raw, 4000));
    }
  }
  return chunks.filter(Boolean).join("\n");
}

function searchableValue(value, maxLength = 30000) {
  if (typeof value === "string") return value.slice(0, maxLength);
  try {
    return JSON.stringify(value).slice(0, maxLength);
  } catch {
    return "";
  }
}

function extractImageRefs(text) {
  const refs = [];
  const add = (value) => {
    const cleaned = cleanImageRef(value);
    if (cleaned && isImageRef(cleaned)) refs.push(cleaned);
  };

  for (const match of String(text || "").matchAll(/!\[[^\]]*]\((<[^>]+>|[^)\n]+)\)/g)) add(match[1]);
  for (const match of String(text || "").matchAll(/\[[^\]]+]\((<[^>]+>|[^)\n]+)\)/g)) add(match[1]);
  for (const match of String(text || "").matchAll(/\bhttps?:\/\/[^\s<>"')]+?\.(?:avif|bmp|gif|jpe?g|png|svg|webp)(?:\?[^\s<>"')]+)?/gi)) add(match[0]);
  for (const match of String(text || "").matchAll(/\bfile:\/\/[^\s<>"')]+?\.(?:avif|bmp|gif|jpe?g|png|svg|webp)\b/gi)) add(match[0]);
  for (const match of String(text || "").matchAll(/(?:^|[\s"'(<])((?:~|\/|\.)[^\n"'<>)]*?\.(?:avif|bmp|gif|jpe?g|png|svg|webp))(?=$|[\s"')>.,])/gim)) add(match[1]);

  return [...new Set(refs)].slice(0, 40);
}

function cleanImageRef(raw) {
  let value = String(raw || "").trim();
  if (!value) return "";
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1).trim();
  const titleMatch = value.match(/^(.+?)\s+["'][^"']+["']$/);
  if (titleMatch) value = titleMatch[1].trim();
  try {
    if (!value.startsWith("http://") && !value.startsWith("https://")) value = decodeURIComponent(value);
  } catch {}
  return value;
}

function isImageRef(ref) {
  if (/^https?:\/\//i.test(ref)) {
    try {
      return imageExts.has(path.extname(new URL(ref).pathname).toLowerCase());
    } catch {
      return false;
    }
  }
  return imageExts.has(path.extname(stripFileUrl(ref)).toLowerCase());
}

async function resolveImageAsset(ref, session, chat) {
  if (/^https?:\/\//i.test(ref)) {
    const ext = path.extname(new URL(ref).pathname).toLowerCase();
    return {
      kind: "remote",
      url: ref,
      ext,
      key: `url:${ref}`,
      caption: imageCaption(ref),
    };
  }

  const filePath = await resolveLocalImagePath(ref, session, chat);
  if (!filePath) return null;
  const stats = await fs.stat(filePath).catch(() => null);
  if (!stats?.isFile()) return null;

  const ext = path.extname(filePath).toLowerCase();
  const key = `file:${filePath}:${stats.size}:${Math.trunc(stats.mtimeMs)}`;
  return {
    kind: "local",
    path: filePath,
    ext,
    mimeType: imageMimeTypes[ext] || "application/octet-stream",
    size: stats.size,
    key,
    caption: imageCaption(filePath),
  };
}

async function resolveLocalImagePath(ref, session, chat) {
  const requested = expandHomePath(stripFileUrl(ref).trim());
  if (!requested) return null;
  const roots = await mediaRoots(session, chat);
  const candidates = [];

  if (path.isAbsolute(requested)) {
    candidates.push(path.resolve(requested));
  } else {
    for (const rootDir of roots) candidates.push(path.resolve(rootDir, requested));
  }

  for (const candidate of candidates) {
    const realCandidate = await existingImageRealpath(candidate);
    if (realCandidate && roots.some((rootDir) => isWithinRoot(realCandidate, rootDir))) return realCandidate;
  }
  return null;
}

async function mediaRoots(session, chat) {
  const roots = [
    root,
    path.join(root, "public"),
    path.join(root, "output"),
    path.join(root, "tmp"),
    session?.meta?.session_id ? path.join(root, "sessions", session.meta.session_id) : "",
    session?.meta?.agent_snapshot?.cwd,
    effectiveProjectCwd(chat),
    os.tmpdir(),
    path.join(process.env.HOME || "", ".codex", "generated_images"),
    ...(csv(process.env.TELEGRAM_MEDIA_EXTRA_ROOTS) || []),
  ].filter(Boolean);
  const realRoots = await Promise.all(roots.map((candidate) => fs.realpath(candidate).catch(() => null)));
  return [...new Set(realRoots.filter(Boolean))];
}

async function existingImageRealpath(candidate) {
  try {
    const stats = await fs.stat(candidate);
    if (!stats.isFile() || !imageExts.has(path.extname(candidate).toLowerCase())) return null;
    return await fs.realpath(candidate);
  } catch {
    return null;
  }
}

function isWithinRoot(filePath, rootDir) {
  const relative = path.relative(rootDir, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function sendImageAsset(chatId, asset, sessionId) {
  if (asset.kind === "remote") {
    const method = telegramPhotoExts.has(asset.ext) ? "sendPhoto" : "sendDocument";
    const field = method === "sendPhoto" ? "photo" : "document";
    await telegram(method, {
      chat_id: chatId,
      [field]: asset.url,
      caption: truncateCaption(asset.caption),
    });
    markMediaSent(chatId, sessionId, asset.key);
    return true;
  }

  if (asset.size > maxTelegramDocumentBytes) {
    await sendMessage(chatId, `Image is too large for Telegram (${formatBytes(asset.size)}):\n${asset.path}`);
    markMediaSent(chatId, sessionId, asset.key);
    return false;
  }

  const method = telegramPhotoExts.has(asset.ext) && asset.size <= maxTelegramPhotoBytes ? "sendPhoto" : "sendDocument";
  const field = method === "sendPhoto" ? "photo" : "document";
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("caption", truncateCaption(asset.caption));
  const buffer = await fs.readFile(asset.path);
  form.append(field, new Blob([buffer], { type: asset.mimeType }), path.basename(asset.path));
  await telegramMultipart(method, form);
  markMediaSent(chatId, sessionId, asset.key);
  return true;
}

function imageCaption(value) {
  let label = "image";
  if (/^https?:\/\//i.test(value)) {
    try {
      label = new URL(value).pathname.split("/").filter(Boolean).pop() || label;
    } catch {}
  } else {
    label = path.basename(value);
  }
  return `Image: ${label}`;
}

function stripFileUrl(ref) {
  const value = String(ref || "").trim();
  if (!/^file:\/\//i.test(value)) return value;
  try {
    return fileURLToPath(value);
  } catch {
    try {
      return decodeURIComponent(value.replace(/^file:\/\//i, ""));
    } catch {
      return value.replace(/^file:\/\//i, "");
    }
  }
}

function expandHomePath(value) {
  if (value === "~") return process.env.HOME || value;
  if (value.startsWith("~/")) return path.join(process.env.HOME || "", value.slice(2));
  return value;
}

function safeFileName(value) {
  return String(value || "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+/, "")
    .slice(0, 140);
}

function mimeTypeForPath(filePath) {
  return imageMimeTypes[path.extname(filePath || "").toLowerCase()] || "";
}

function mimeExt(mimeType) {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized === "image/jpeg") return ".jpg";
  for (const [ext, type] of Object.entries(imageMimeTypes)) {
    if (type === normalized) return ext;
  }
  return "";
}

function truncateCaption(value) {
  return String(value || "Image").slice(0, 1024);
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
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

function formatAllowedToolsCsv(value) {
  const tools = csv(value);
  return tools ? formatAllowedTools(tools) : "";
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

function friendlyError(err) {
  const message = err instanceof Error ? err.message : String(err || "unknown error");
  return message.replace(/\s+/g, " ").slice(0, 180);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
