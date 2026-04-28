// Runnable adapter contract. Every supported CLI (Claude, Codex)
// implements this interface via a vendor SDK so the harness can drive sessions
// without subprocess/stream-json parsing.
//
// The harness owns the canonical conversation in NeutralTranscript form;
// adapters translate to/from each CLI's native representation.

import type { CLI } from "../clis";
import type { ModelReasoningEffort } from "../models";

export type NeutralRole = "user" | "assistant" | "system";

export type NeutralTextPart = { type: "text"; text: string };
export type NeutralToolUsePart = {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
};
export type NeutralToolResultPart = {
  type: "tool_result";
  tool_use_id: string;
  content: unknown;
  is_error?: boolean;
};
export type NeutralPart = NeutralTextPart | NeutralToolUsePart | NeutralToolResultPart;

export type NeutralMessage = {
  role: NeutralRole;
  parts: NeutralPart[];
  /** Wallclock of when the message was produced. */
  ts?: string;
  /** Which CLI produced it, for replay and audit. */
  cli?: CLI;
  /** Model id when available. */
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
};

export type NeutralTranscript = {
  messages: NeutralMessage[];
  /** Optional metadata carried from the source session for context. */
  meta?: {
    source_cli?: CLI;
    source_session_id?: string;
    summary?: string;
  };
};

// ─── Streaming events (what sendTurn yields) ─────────────────────────────────

export type NeutralEvent =
  | { kind: "turn_start"; ts: string; model?: string }
  | { kind: "assistant_text_delta"; text: string }
  | { kind: "assistant_text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; id: string; name: string; input: unknown }
  | { kind: "tool_result"; tool_use_id: string; content: unknown; is_error: boolean }
  | {
      kind: "turn_end";
      ts: string;
      usage: { input: number; output: number; cache_read: number; cache_creation: number; total: number };
      session_id?: string; // underlying CLI's native session id if exposed
    }
  | { kind: "error"; error: string; fatal: boolean };

// ─── Session handle ──────────────────────────────────────────────────────────

export type SessionHandle = {
  cli: CLI;
  /** Harness's own session id. */
  harness_session_id: string;
  /** Underlying CLI's native session id, if resume/fork requires it. */
  native_session_id?: string;
  /** Optional: adapter-owned opaque state (client handle, pty, etc.). */
  internal?: unknown;
};

export type StartSessionOpts = {
  cli?: CLI;
  harness_session_id: string;
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  cwd?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  /** If set, rehydrate from a neutral transcript. */
  seed?: NeutralTranscript;
};

export type TurnOverrides = {
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  allowedTools?: string[];
};

// ─── Adapter interface ───────────────────────────────────────────────────────

export interface RunnableAdapter {
  readonly cli: CLI;

  startSession(opts: StartSessionOpts): Promise<SessionHandle>;

  /** Run one turn; returns an async stream of neutral events. */
  sendTurn(
    handle: SessionHandle,
    userMessage: string,
    overrides?: TurnOverrides,
  ): AsyncIterable<NeutralEvent>;

  /** Push additional context (e.g., results from another agent) into the live session. */
  injectContext(handle: SessionHandle, items: NeutralMessage[]): Promise<void>;

  /** Change the active model for subsequent turns. */
  switchModel(handle: SessionHandle, model: string | undefined, reasoningEffort?: ModelReasoningEffort): Promise<void>;

  /** Fork at a point. If atTurn is omitted, fork from HEAD. Returns a new handle. */
  fork(handle: SessionHandle, atTurn?: number): Promise<SessionHandle>;

  /** Serialize the current session to a neutral transcript. */
  exportState(handle: SessionHandle): Promise<NeutralTranscript>;

  /** Build a new session seeded with a neutral transcript. */
  importState(neutral: NeutralTranscript, opts: StartSessionOpts): Promise<SessionHandle>;

  /** Signal the live session to stop / cleanup. */
  abort(handle: SessionHandle): Promise<void>;
}

// ─── Registry helpers ────────────────────────────────────────────────────────

export function eventIsTerminal(ev: NeutralEvent): boolean {
  return ev.kind === "turn_end" || (ev.kind === "error" && ev.fatal);
}
