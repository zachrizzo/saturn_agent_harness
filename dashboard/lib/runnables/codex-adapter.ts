// Codex adapter — uses @openai/codex-sdk (thin wrapper over `codex app-server`).

import {
  Codex,
  type ModelReasoningEffort as CodexSdkReasoningEffort,
  type Thread,
  type ThreadEvent,
  type ThreadItem,
} from "@openai/codex-sdk";
import type {
  RunnableAdapter,
  SessionHandle,
  StartSessionOpts,
  TurnOverrides,
  NeutralEvent,
  NeutralMessage,
  NeutralTranscript,
  NeutralPart,
} from "./types";
import { normalizeReasoningEffortForCli, type ModelReasoningEffort } from "../models";
import { resolveReasoningEffortForCliModel } from "../model-capabilities";

type CodexInternal = {
  codex: Codex;
  thread?: Thread;
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  cwd?: string;
  abort?: AbortController;
  pendingInjections?: NeutralMessage[];
  pendingSeed?: string;
};

function threadOptions(
  model: string | undefined,
  cwd: string | undefined,
  reasoningEffort?: ModelReasoningEffort,
) {
  return {
    model,
    modelReasoningEffort: normalizeReasoningEffortForCli("codex", reasoningEffort) as CodexSdkReasoningEffort | undefined,
    workingDirectory: cwd,
    skipGitRepoCheck: true,
    approvalPolicy: "never" as const,
    sandboxMode: "danger-full-access" as const,
  };
}

const codexClient = (() => {
  try {
    return new Codex();
  } catch {
    return null;
  }
})();

function roleLabel(role: NeutralMessage["role"]): string {
  if (role === "assistant") return "Assistant";
  if (role === "system") return "System";
  return "User";
}

function seedPromptFromTranscript(seed?: NeutralTranscript): string | undefined {
  if (!seed || seed.messages.length === 0) return undefined;
  const lines: string[] = [
    "Resuming a conversation from another CLI. Use as context only.",
    "─── PRIOR TRANSCRIPT ───",
  ];
  for (const m of seed.messages) {
    const txt = m.parts
      .filter((p): p is Extract<NeutralPart, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    if (!txt) continue;
    lines.push(`${roleLabel(m.role)}: ${txt}`);
  }
  lines.push("─── END ───");
  return lines.join("\n");
}

function neutralMessageText(message: NeutralMessage): string {
  const parts: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      parts.push(part.text);
    } else if (part.type === "tool_use") {
      parts.push(`Tool use ${part.name}: ${JSON.stringify(part.input)}`);
    } else if (part.type === "tool_result") {
      parts.push(`Tool result ${part.tool_use_id}: ${JSON.stringify(part.content)}`);
    }
  }
  return parts.join("\n");
}

function injectedContextPrompt(items: NeutralMessage[]): string {
  return [
    "Additional context injected by the Saturn harness. Treat it as context, not as a new user request.",
    "",
    ...items.flatMap((item) => {
      const text = neutralMessageText(item).trim();
      return text ? [`${roleLabel(item.role)}: ${text}`] : [];
    }),
  ].join("\n");
}

function consumePendingContext(internal: CodexInternal, userMessage: string): string {
  const blocks: string[] = [];
  if (internal.pendingSeed?.trim()) blocks.push(internal.pendingSeed.trim());
  if (internal.pendingInjections?.length) blocks.push(injectedContextPrompt(internal.pendingInjections));
  internal.pendingSeed = undefined;
  internal.pendingInjections = [];
  if (!blocks.length) return userMessage;
  return `${blocks.join("\n\n")}\n\n---\n\nCurrent user request:\n${userMessage}`;
}

export class CodexAdapter implements RunnableAdapter {
  readonly cli = "codex" as const;

  private ensureClient(): Codex {
    if (!codexClient) throw new Error("Codex SDK unavailable (is the `codex` binary on PATH?)");
    return codexClient;
  }

  async startSession(opts: StartSessionOpts): Promise<SessionHandle> {
    const codex = this.ensureClient();
    const reasoningEffort = await resolveReasoningEffortForCliModel("codex", opts.model, opts.reasoningEffort);
    const thread = codex.startThread(threadOptions(opts.model, opts.cwd, reasoningEffort));
    const internal: CodexInternal = {
      codex,
      thread,
      model: opts.model,
      reasoningEffort,
      cwd: opts.cwd,
    };
    return {
      cli: "codex",
      harness_session_id: opts.harness_session_id,
      internal,
    };
  }

  async *sendTurn(
    handle: SessionHandle,
    userMessage: string,
    overrides?: TurnOverrides,
  ): AsyncGenerator<NeutralEvent> {
    const internal = handle.internal as CodexInternal;
    const abort = new AbortController();
    internal.abort = abort;

    // Codex doesn't expose per-turn model override; switchModel re-creates the thread.
    if (
      (overrides?.model && overrides.model !== internal.model) ||
      overrides?.reasoningEffort !== internal.reasoningEffort
    ) {
      await this.switchModel(handle, overrides?.model ?? internal.model, overrides?.reasoningEffort);
    }

    const thread = internal.thread;
    if (!thread) throw new Error("codex: thread not initialized");
    const prompt = consumePendingContext(internal, userMessage);

    yield { kind: "turn_start", ts: new Date().toISOString(), model: internal.model };

    let usage = { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0 };

    try {
      const { events } = await thread.runStreamed(prompt, { signal: abort.signal });
      for await (const ev of events as AsyncGenerator<ThreadEvent>) {
        if (ev.type === "thread.started") {
          handle.native_session_id = ev.thread_id;
        } else if (ev.type === "item.started") {
          const item = ev.item as ThreadItem;
          if (item.type === "command_execution") {
            yield {
              kind: "tool_use",
              id: item.id,
              name: "Bash",
              input: { command: item.command },
            };
          }
        } else if (ev.type === "item.completed") {
          const item = ev.item as ThreadItem;
          if (item.type === "agent_message") {
            yield { kind: "assistant_text", text: item.text };
          } else if (item.type === "reasoning") {
            yield { kind: "thinking", text: item.text };
          } else if (item.type === "command_execution") {
            yield {
              kind: "tool_result",
              tool_use_id: item.id,
              content: item.aggregated_output,
              is_error: (item.exit_code ?? 0) !== 0,
            };
          } else if (item.type === "file_change") {
            yield {
              kind: "tool_use",
              id: item.id,
              name: "Edit",
              input: { changes: item.changes },
            };
            yield {
              kind: "tool_result",
              tool_use_id: item.id,
              content: { status: item.status },
              is_error: item.status === "failed",
            };
          } else if (item.type === "mcp_tool_call") {
            yield {
              kind: "tool_use",
              id: item.id,
              name: `${item.server}.${item.tool}`,
              input: item.arguments,
            };
            yield {
              kind: "tool_result",
              tool_use_id: item.id,
              content: item.result ?? item.error,
              is_error: item.status === "failed",
            };
          } else if (item.type === "error") {
            yield { kind: "error", error: item.message, fatal: false };
          }
        } else if (ev.type === "turn.completed") {
          const u = ev.usage;
          usage = {
            input: u.input_tokens,
            output: u.output_tokens,
            cache_read: u.cached_input_tokens,
            cache_creation: 0,
            total:
              Math.max(0, u.input_tokens - u.cached_input_tokens) +
              u.output_tokens +
              u.reasoning_output_tokens,
          };
        } else if (ev.type === "turn.failed") {
          yield { kind: "error", error: ev.error.message, fatal: true };
        } else if (ev.type === "error") {
          yield { kind: "error", error: ev.message, fatal: true };
        }
      }
    } catch (err) {
      yield { kind: "error", error: (err as Error).message, fatal: true };
      return;
    }

    yield {
      kind: "turn_end",
      ts: new Date().toISOString(),
      usage,
      session_id: handle.native_session_id,
    };
  }

  async injectContext(handle: SessionHandle, items: NeutralMessage[]): Promise<void> {
    const internal = handle.internal as CodexInternal;
    internal.pendingInjections = [...(internal.pendingInjections ?? []), ...items];
  }

  async switchModel(
    handle: SessionHandle,
    model: string | undefined,
    reasoningEffort?: ModelReasoningEffort,
  ): Promise<void> {
    const internal = handle.internal as CodexInternal;
    const resolvedEffort = await resolveReasoningEffortForCliModel("codex", model, reasoningEffort);
    internal.model = model;
    internal.reasoningEffort = resolvedEffort;
    // Re-open the thread with new model but resume from current thread id if present.
    const opts = threadOptions(model, internal.cwd, resolvedEffort);
    internal.thread = handle.native_session_id
      ? internal.codex.resumeThread(handle.native_session_id, opts)
      : internal.codex.startThread(opts);
  }

  async fork(handle: SessionHandle, _atTurn?: number): Promise<SessionHandle> {
    // Codex SDK has no explicit fork; resume under a fresh harness id and
    // treat follow-up turns as a new branch. Session identity on the Codex side
    // remains the same thread_id — callers must treat this as advisory.
    return { ...handle, harness_session_id: `${handle.harness_session_id}-fork` };
  }

  async exportState(handle: SessionHandle): Promise<NeutralTranscript> {
    // SDK surface doesn't expose rollout readback. Best we can do is return
    // an empty transcript with metadata so cross-CLI handoff carries the id.
    return {
      messages: [],
      meta: { source_cli: "codex", source_session_id: handle.native_session_id },
    };
  }

  async importState(neutral: NeutralTranscript, opts: StartSessionOpts): Promise<SessionHandle> {
    const codex = this.ensureClient();
    const reasoningEffort = await resolveReasoningEffortForCliModel("codex", opts.model, opts.reasoningEffort);
    const thread = codex.startThread(threadOptions(opts.model, opts.cwd, reasoningEffort));
    const internal: CodexInternal = {
      codex,
      thread,
      model: opts.model,
      reasoningEffort,
      cwd: opts.cwd,
      pendingSeed: seedPromptFromTranscript(neutral),
    };
    return {
      cli: "codex",
      harness_session_id: opts.harness_session_id,
      internal,
    };
  }

  async abort(handle: SessionHandle): Promise<void> {
    const internal = handle.internal as CodexInternal;
    try {
      internal.abort?.abort();
    } catch {
      /* noop */
    }
  }
}

export const codexAdapter = new CodexAdapter();
