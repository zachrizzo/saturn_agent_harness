// Per-chat state management for telegram-dispatch.mjs.
//
// Owns the on-disk `telegram/state.json` file and the in-memory `chats`
// map. All mutating helpers go through this module so the long-poll loop
// in telegram-dispatch.mjs stays focused on routing and Telegram API calls.

import { promises as fs } from "node:fs";
import path from "node:path";

export const NO_TOOLS_SENTINEL = "__SATURN_NO_TOOLS__";

/**
 * @typedef {{
 *   stateFile: string,
 *   maxQueueMessages: number,
 *   maxSentMediaSessions: number,
 *   allowAll: boolean,
 *   allowedChatIds: Set<string>,
 * }} TelegramStateOptions
 */

/**
 * Create a state manager bound to a state file. Loads the existing state
 * eagerly so callers can `await createTelegramStateManager(...)` once and
 * then access `state` synchronously in the long-poll loop.
 *
 * @param {TelegramStateOptions} opts
 */
export async function createTelegramStateManager(opts) {
  const {
    stateFile,
    maxQueueMessages,
    maxSentMediaSessions,
    allowAll,
    allowedChatIds,
  } = opts;

  const state = await loadStateFile(stateFile);

  async function saveState() {
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    await fs.writeFile(stateFile, JSON.stringify(state, null, 2), "utf8");
  }

  function ensureChat(chatId) {
    state.chats ||= {};
    state.chats[chatId] ||= { queue: [] };
    state.chats[chatId].queue ||= [];
    if (
      Array.isArray(state.chats[chatId].allowedTools) &&
      state.chats[chatId].allowedTools.length === 0
    ) {
      state.chats[chatId].allowedTools = [NO_TOOLS_SENTINEL];
    }
  }

  function enqueueChatMessage(chatId, text, attachments = []) {
    ensureChat(chatId);
    const chat = state.chats[chatId];
    chat.queue ||= [];
    const overflow = Math.max(0, chat.queue.length - maxQueueMessages + 1);
    if (overflow > 0) chat.queue.splice(0, overflow);
    chat.queue.push({ text, attachments, queued_at: new Date().toISOString() });
    return { length: chat.queue.length, dropped: overflow };
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

  function mediaSentKeys(chat, sessionId) {
    chat.sent_media ||= {};
    const keys = Array.isArray(chat.sent_media[sessionId]) ? chat.sent_media[sessionId] : [];
    return new Set(keys);
  }

  function markMediaSent(chatId, sessionId, key) {
    ensureChat(chatId);
    const chat = state.chats[chatId];
    chat.sent_media ||= {};
    const keys = Array.isArray(chat.sent_media[sessionId]) ? chat.sent_media[sessionId] : [];
    if (!keys.includes(key)) keys.push(key);
    chat.sent_media[sessionId] = keys.slice(-100);
    const sessionIds = Object.keys(chat.sent_media);
    if (sessionIds.length > maxSentMediaSessions) {
      for (const staleId of sessionIds.slice(0, sessionIds.length - maxSentMediaSessions)) {
        delete chat.sent_media[staleId];
      }
    }
  }

  function formatAllowedTools(tools) {
    if (!Array.isArray(tools) || tools.length === 0 || tools.includes(NO_TOOLS_SENTINEL)) {
      return "none";
    }
    return tools.join(", ");
  }

  return {
    /** Live reference to the in-memory state object. */
    state,
    saveState,
    ensureChat,
    enqueueChatMessage,
    clearSessionMapping,
    isAllowed,
    mediaSentKeys,
    markMediaSent,
    formatAllowedTools,
  };
}

async function loadStateFile(stateFile) {
  try {
    const raw = await fs.readFile(stateFile, "utf8");
    return JSON.parse(raw);
  } catch {
    return { offset: 0, chats: {} };
  }
}
