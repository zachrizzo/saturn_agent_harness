// Programmatic agent runner. Single entrypoint for cron jobs, webhooks,
// integration tests, and custom scripts. Collapses what used to be three
// invocation paths (cron → run-job.sh, chat → /api/sessions/[id]/messages,
// swarm → MCP dispatch_slice) into one function shaped for reuse.
//
// Uses the vendor SDK adapters so orchestration capabilities (mid-turn model
// switch, context injection, cross-CLI handoff) are available to callers.

import { getAgent } from "./runs";
import type { Agent, CLI } from "./runs";
import type { ModelReasoningEffort } from "./models";
import { getAdapter } from "./runnables/registry";
import type { NeutralEvent, NeutralMessage } from "./runnables/types";
import { DEFAULT_CLI, normalizeCli } from "./clis";

export type RunAgentOptions = {
  /** ID of a saved agent in agents.json. Mutually exclusive with adhoc. */
  agent_id?: string;
  /** Ad-hoc agent config (no persistence). Mutually exclusive with agent_id. */
  adhoc?: Agent;
  /** The user message for this turn. */
  message: string;
  /** Override CLI (otherwise uses agent.defaultCli / agent.cli). */
  cli?: CLI;
  /** Override model (otherwise uses agent.models[cli] / agent.model). */
  model?: string;
  /** Override reasoning effort / thinking level. */
  reasoningEffort?: ModelReasoningEffort;
  /** Per-turn allowedTools override. */
  allowedTools?: string[];
  /** Optional harness session id for correlation. If omitted, one is generated. */
  sessionId?: string;
  /** Optional context messages to inject before the turn. */
  injections?: NeutralMessage[];
  /** Abort controller if the caller wants to cancel. */
  signal?: AbortSignal;
};

export type RunAgentResult = {
  session_id: string;
  native_session_id?: string;
  final_text: string;
  events: NeutralEvent[];
  tokens: { input: number; output: number; cache_read: number; cache_creation: number; total: number };
  duration_ms: number;
  error?: string;
};

function resolveCli(agent: Agent, override?: CLI): CLI {
  return normalizeCli(override ?? agent.defaultCli ?? agent.cli ?? DEFAULT_CLI);
}

function resolveModel(agent: Agent, cli: CLI, override?: string): string | undefined {
  return override ?? agent.models?.[cli] ?? agent.model;
}

function resolveReasoningEffort(
  agent: Agent,
  cli: CLI,
  override?: ModelReasoningEffort,
): ModelReasoningEffort | undefined {
  return override ?? agent.reasoningEfforts?.[cli] ?? agent.reasoningEffort;
}

export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  if (!opts.message.trim()) throw new Error("runAgent: message required");

  let agent: Agent | undefined;
  if (opts.agent_id) {
    agent = await getAgent(opts.agent_id);
    if (!agent) throw new Error(`agent not found: ${opts.agent_id}`);
  } else if (opts.adhoc) {
    agent = opts.adhoc;
  } else {
    throw new Error("runAgent: agent_id or adhoc required");
  }

  const cli = resolveCli(agent, opts.cli);
  const model = resolveModel(agent, cli, opts.model);
  const reasoningEffort = resolveReasoningEffort(agent, cli, opts.reasoningEffort);
  const allowedTools = opts.allowedTools ?? agent.allowedTools;
  const sessionId = opts.sessionId ?? `runAgent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const adapter = getAdapter(cli);
  const started = Date.now();
  const handle = await adapter.startSession({
    cli,
    harness_session_id: sessionId,
    model,
    reasoningEffort,
    cwd: agent.cwd,
    systemPrompt: agent.prompt,
    allowedTools,
  });

  if (opts.injections?.length) {
    await adapter.injectContext(handle, opts.injections);
  }

  const events: NeutralEvent[] = [];
  const textPieces: string[] = [];
  let tokens = { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0 };
  let error: string | undefined;

  const onAbort = () => adapter.abort(handle).catch(() => { /* noop */ });
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    for await (const ev of adapter.sendTurn(handle, opts.message, { model, reasoningEffort, allowedTools })) {
      events.push(ev);
      if (ev.kind === "assistant_text") textPieces.push(ev.text);
      else if (ev.kind === "turn_end") tokens = ev.usage;
      else if (ev.kind === "error" && ev.fatal) error = ev.error;
    }
  } catch (err) {
    error = (err as Error).message;
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }

  return {
    session_id: sessionId,
    native_session_id: handle.native_session_id,
    final_text: textPieces.join(""),
    events,
    tokens,
    duration_ms: Date.now() - started,
    error,
  };
}
