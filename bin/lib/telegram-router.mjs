// Message routing + command parsing helpers for telegram-dispatch.mjs.
//
// The long-poll loop in the main script delegates here for command parsing
// and the canned `/help` text. The actual handler switch stays in the main
// script because individual handlers close over many other modules
// (Saturn API client, Telegram API client, state manager, dispatch logic).

/**
 * Parse a slash-command line into its parts.
 * Telegram-style mentions like `/foo@MyBot` are stripped from the command.
 *
 * @param {string} text
 * @returns {{ rawCommand: string, command: string, arg: string }}
 */
export function parseCommandLine(text) {
  const [rawCommand = ""] = String(text || "").split(/\s+/);
  return {
    rawCommand,
    command: rawCommand.split("@")[0].toLowerCase(),
    arg: String(text || "").slice(rawCommand.length).trim(),
  };
}

/**
 * Help/usage text shown by /start and /help. Returned as a single string so
 * callers can pass it straight to sendMessage.
 */
export function helpText() {
  return [
    "Saturn Dispatch is connected.",
    "",
    "Send messages normally. If a turn is running, follow-ups are queued and sent next.",
    "Send or take a photo with an optional caption to attach it to the next turn.",
    "Use /new <caption> with a photo to start a fresh session with that image.",
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
    "/models lists the available CLIs and models.",
    "/think shows valid reasoning levels for the current model.",
    "/think <level|off> sets or clears reasoning.",
    "/tools <preset|csv|off> sets Claude allowed tools. Presets: none, read, code, full.",
    "/mcp <on|off> toggles MCP tools for the session.",
    "/timeout <seconds|off> sets new-chat timeout.",
    "/prompt <text|off> sets the ad-hoc system prompt.",
    "/verbose <on|off> toggles dashboard links.",
    "/clear settings resets every Dispatch setting for this chat.",
  ].join("\n");
}
