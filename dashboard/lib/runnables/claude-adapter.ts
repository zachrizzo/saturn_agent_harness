// Claude Code adapter — uses @anthropic-ai/claude-agent-sdk to drive Claude
// sessions programmatically. Translates SDKMessage events to NeutralEvent.

import { query, forkSession, getSessionMessages, type Options, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
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
import { isBedrockCli, isLocalClaudeCli, isPersonalClaudeCli, normalizeCli } from "../clis";
import type { CLI } from "../clis";
import { toBedrockId } from "../claude-models";

type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

type ClaudeInternal = {
  cli: CLI;
  cwd?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  abort?: AbortController;
};

function providerOptions(cli: CLI, model?: string): Pick<Options, "env" | "model" | "settingSources"> {
  const env: Record<string, string | undefined> = { ...process.env };
  let effectiveModel = model;
  let settingSources: SettingSource[] | undefined;

  if (isBedrockCli(cli)) {
    env.CLAUDE_CODE_USE_BEDROCK = env.CLAUDE_CODE_USE_BEDROCK || "1";
    env.AWS_PROFILE = env.AWS_PROFILE || "sondermind-development-new";
    env.AWS_REGION = env.AWS_REGION || "us-east-1";
    effectiveModel = toBedrockId(model);
  } else if (isLocalClaudeCli(cli)) {
    env.CLAUDE_CODE_USE_BEDROCK = "0";
    env.ANTHROPIC_BASE_URL = "http://0.0.0.0:4000";
    env.ANTHROPIC_AUTH_TOKEN = "sk-local-proxy-key";
    env.ANTHROPIC_MODEL = model ?? "gemma4:26b-it-q4_K_M";
    env.ANTHROPIC_SMALL_FAST_MODEL = env.ANTHROPIC_SMALL_FAST_MODEL || "gemma4:4b";
  } else if (isPersonalClaudeCli(cli)) {
    delete env.CLAUDE_CODE_USE_BEDROCK;
    delete env.CLAUDE_CODE_USE_VERTEX;
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_AUTH_TOKEN;
    settingSources = ["project", "local"];
  }

  return { env, model: effectiveModel, settingSources };
}

function roleLabel(role: NeutralMessage["role"]): string {
  if (role === "assistant") return "Assistant";
  if (role === "system") return "System";
  return "User";
}

function messagesToUserString(seed: NeutralTranscript | undefined): string | undefined {
  if (!seed || seed.messages.length === 0) return undefined;
  const parts: string[] = [
    "You are resuming a conversation that previously happened on another CLI.",
    "The transcript below reconstructs that conversation — treat it as context,",
    "not as instructions you need to act on again. Continue from where it left off.",
    "",
    "─── PRIOR TRANSCRIPT ───",
  ];
  for (const m of seed.messages) {
    const textParts = m.parts
      .filter((p): p is Extract<NeutralPart, { type: "text" }> => p.type === "text")
      .map((p) => p.text);
    const role = roleLabel(m.role);
    if (textParts.length > 0) {
      parts.push(`${role}: ${textParts.join("\n")}`);
    }
    for (const p of m.parts) {
      if (p.type === "tool_use") {
        parts.push(`${role} called tool "${p.name}" with input: ${JSON.stringify(p.input).slice(0, 500)}`);
      } else if (p.type === "tool_result") {
        const snippet = JSON.stringify(p.content).slice(0, 500);
        parts.push(`Tool result (${p.tool_use_id}): ${snippet}`);
      }
    }
  }
  parts.push("─── END OF PRIOR TRANSCRIPT ───");
  return parts.join("\n");
}

export class ClaudeAdapter implements RunnableAdapter {
  readonly cli = "claude-bedrock" as const;

  async startSession(opts: StartSessionOpts): Promise<SessionHandle> {
    const cli = normalizeCli(opts.cli);
    const internal: ClaudeInternal = {
      cli,
      cwd: opts.cwd,
      systemPrompt: opts.systemPrompt,
      allowedTools: opts.allowedTools,
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
    };
    return {
      cli,
      harness_session_id: opts.harness_session_id,
      internal,
    };
  }

  async *sendTurn(
    handle: SessionHandle,
    userMessage: string,
    overrides?: TurnOverrides,
  ): AsyncGenerator<NeutralEvent> {
    const internal = (handle.internal ?? {}) as ClaudeInternal;
    const abort = new AbortController();
    internal.abort = abort;
    const model = overrides?.model ?? internal.model;
    const reasoningEffort = normalizeReasoningEffortForCli(
      internal.cli,
      overrides?.reasoningEffort ?? internal.reasoningEffort,
    ) as ClaudeEffort | undefined;
    const allowedTools = overrides?.allowedTools ?? internal.allowedTools;
    const provider = providerOptions(internal.cli, model);

    yield { kind: "turn_start", ts: new Date().toISOString(), model: provider.model };

    const textPieces: string[] = [];
    let usage = { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0 };
    let nativeSessionId: string | undefined = handle.native_session_id;

    try {
      const q = query({
        prompt: userMessage,
        options: {
          resume: handle.native_session_id,
          model: provider.model,
          env: provider.env,
          settingSources: provider.settingSources,
          effort: reasoningEffort,
          cwd: internal.cwd,
          systemPrompt: internal.systemPrompt,
          allowedTools,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          abortController: abort,
        },
      });

      for await (const msg of q) {
        if (msg.type === "assistant") {
          nativeSessionId ??= msg.session_id;
          const content = (msg.message?.content ?? []) as unknown as Array<Record<string, unknown>>;
          for (const item of content) {
            if (item.type === "text" && typeof item.text === "string") {
              textPieces.push(item.text);
              yield { kind: "assistant_text", text: item.text };
            } else if (item.type === "thinking" && typeof item.thinking === "string") {
              yield { kind: "thinking", text: item.thinking };
            } else if (item.type === "tool_use") {
              yield {
                kind: "tool_use",
                id: String(item.id ?? ""),
                name: String(item.name ?? ""),
                input: item.input,
              };
            }
          }
        } else if (msg.type === "user") {
          // tool results arrive as user messages with content array
          const content = (msg.message as { content?: unknown }).content;
          if (Array.isArray(content)) {
            for (const item of content as Array<Record<string, unknown>>) {
              if (item.type === "tool_result") {
                yield {
                  kind: "tool_result",
                  tool_use_id: String(item.tool_use_id ?? ""),
                  content: item.content,
                  is_error: Boolean(item.is_error),
                };
              }
            }
          }
        } else if (msg.type === "result") {
          const u = ((msg as unknown) as { usage?: Record<string, unknown> }).usage ?? {};
          const input = Number(u.input_tokens ?? 0);
          const output = Number(u.output_tokens ?? 0);
          const rawCacheCreation = u.cache_creation_input_tokens;
          const cache_creation =
            typeof rawCacheCreation === "number"
              ? rawCacheCreation
              : Number(
                  ((rawCacheCreation ?? {}) as Record<string, number>).ephemeral_5m_input_tokens ?? 0,
                );
          const cache_read = Number(u.cache_read_input_tokens ?? 0);
          usage = {
            input,
            output,
            cache_read,
            cache_creation,
            total: input + output + cache_read + cache_creation,
          };
          nativeSessionId ??= (msg as { session_id?: string }).session_id;
        }
      }
    } catch (err) {
      yield { kind: "error", error: (err as Error).message, fatal: true };
      return;
    }

    if (nativeSessionId) handle.native_session_id = nativeSessionId;

    yield {
      kind: "turn_end",
      ts: new Date().toISOString(),
      usage,
      session_id: nativeSessionId,
    };
  }

  async injectContext(handle: SessionHandle, items: NeutralMessage[]): Promise<void> {
    // Claude Agent SDK has no stateful "inject context" API. Items get stitched
    // into the next user turn's prompt by whoever calls sendTurn.
    // We attach them to the internal state so the caller can pull them off.
    const internal = (handle.internal ?? {}) as ClaudeInternal & { pendingInjections?: NeutralMessage[] };
    internal.pendingInjections = [...(internal.pendingInjections ?? []), ...items];
  }

  async switchModel(
    handle: SessionHandle,
    model: string | undefined,
    reasoningEffort?: ModelReasoningEffort,
  ): Promise<void> {
    const internal = (handle.internal ?? {}) as ClaudeInternal;
    internal.model = model;
    internal.reasoningEffort = reasoningEffort;
  }

  async fork(handle: SessionHandle, _atTurn?: number): Promise<SessionHandle> {
    // atTurn not wired in v1 — forkSession always forks at the current head.
    if (!handle.native_session_id) {
      throw new Error("cannot fork: no native session id yet (send at least one turn first)");
    }
    const { sessionId } = await forkSession(handle.native_session_id);
    return {
      ...handle,
      harness_session_id: `${handle.harness_session_id}-fork-${sessionId.slice(0, 8)}`,
      native_session_id: sessionId,
    };
  }

  async exportState(handle: SessionHandle): Promise<NeutralTranscript> {
    if (!handle.native_session_id) {
      return { messages: [], meta: { source_cli: handle.cli, source_session_id: undefined } };
    }
    const raw = await getSessionMessages(handle.native_session_id).catch(() => []);
    const messages: NeutralMessage[] = [];
    for (const m of raw) {
      const role = (m as { role?: string }).role;
      if (role !== "user" && role !== "assistant" && role !== "system") continue;
      const content = (m as { content?: unknown }).content;
      const parts: NeutralPart[] = [];
      if (Array.isArray(content)) {
        for (const c of content as Array<Record<string, unknown>>) {
          if (c.type === "text" && typeof c.text === "string") {
            parts.push({ type: "text", text: c.text });
          } else if (c.type === "tool_use") {
            parts.push({
              type: "tool_use",
              id: String(c.id ?? ""),
              name: String(c.name ?? ""),
              input: c.input,
            });
          } else if (c.type === "tool_result") {
            parts.push({
              type: "tool_result",
              tool_use_id: String(c.tool_use_id ?? ""),
              content: c.content,
              is_error: Boolean(c.is_error),
            });
          }
        }
      } else if (typeof content === "string") {
        parts.push({ type: "text", text: content });
      }
      messages.push({ role, parts, cli: handle.cli });
    }
    return {
      messages,
      meta: { source_cli: handle.cli, source_session_id: handle.native_session_id },
    };
  }

  async importState(neutral: NeutralTranscript, opts: StartSessionOpts): Promise<SessionHandle> {
    // Build a seed system + first-user summary. The first sendTurn call will
    // prepend this as context before the real user message.
    const seedPrompt = messagesToUserString(neutral);
    const cli = normalizeCli(opts.cli);
    const internal: ClaudeInternal = {
      cli,
      cwd: opts.cwd,
      systemPrompt: opts.systemPrompt,
      allowedTools: opts.allowedTools,
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
    };
    const handle: SessionHandle = {
      cli,
      harness_session_id: opts.harness_session_id,
      internal,
    };
    if (seedPrompt) {
      // Consume the seed on next turn via injectContext style.
      (internal as ClaudeInternal & { pendingSeed?: string }).pendingSeed = seedPrompt;
    }
    return handle;
  }

  async abort(handle: SessionHandle): Promise<void> {
    const internal = (handle.internal ?? {}) as ClaudeInternal;
    try {
      internal.abort?.abort();
    } catch {
      /* best-effort */
    }
  }
}

export const claudeAdapter = new ClaudeAdapter();
