// MCP tool handler implementations.
// Each function maps 1:1 to an MCP tool exposed on the orchestrator endpoint.
// They are pure async functions — the route layer handles JSON-RPC framing.

import { getSession } from "@/lib/runs";
import { listSlices } from "@/lib/slices";
import { sliceFilterForOrchestrator } from "@/lib/session-utils";
import {
  readBudget,
  checkBudget,
  stopBudget,
  type BudgetLimits,
} from "@/lib/budget";
import {
  executeSlice,
  executeCustomSlice,
  type CustomSliceSpec,
  type SliceExecuteResult,
} from "@/lib/slice-executor";
import type { Agent, OrchestratorBudget, SessionMeta } from "@/lib/runs";
import { checkAndIncrementRecursion, decrementRecursion } from "./recursion";

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function loadAgentAndMeta(
  sessionId: string,
): Promise<{ agent: Agent; meta: SessionMeta }> {
  const session = await getSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);
  const agent = session.meta.agent_snapshot;
  if (!agent) throw new Error(`No agent snapshot on session: ${sessionId}`);
  return { agent, meta: session.meta };
}

function effectiveLimits(agent: Agent, overrides?: OrchestratorBudget): BudgetLimits {
  const base = agent.budget ?? {};
  const over = overrides ?? {};
  return {
    max_total_tokens: over.max_total_tokens ?? base.max_total_tokens,
    max_wallclock_seconds: over.max_wallclock_seconds ?? base.max_wallclock_seconds,
    max_slice_calls: over.max_slice_calls ?? base.max_slice_calls,
    max_recursion_depth: over.max_recursion_depth ?? base.max_recursion_depth,
  };
}

/**
 * Applies agent.on_slice_failure policy to a SliceExecuteResult.
 * - retry-once: run the executor one more time, return whichever is success (or the second result)
 * - continue: return the failure as-is, orchestrator decides
 * - abort: stop the session budget, include stopped marker
 */
async function applyFailurePolicy(
  sessionId: string,
  agent: Agent,
  result: SliceExecuteResult,
  rerun: () => Promise<SliceExecuteResult>,
): Promise<SliceExecuteResult & { retried?: boolean; stopped?: boolean }> {
  if (result.status === "success") return result;
  const policy = agent.on_slice_failure ?? "continue";
  if (policy === "retry-once") {
    const second = await rerun();
    return { ...second, retried: true };
  }
  if (policy === "abort") {
    await stopBudget(sessionId, `slice_failed:${result.status}`);
    return { ...result, stopped: true };
  }
  return result;
}

// ─── list_slices ──────────────────────────────────────────────────────────────

export async function handleListSlices(sessionId: string): Promise<object> {
  const { agent, meta } = await loadAgentAndMeta(sessionId);
  const overrideSlices = meta.overrides?.slices_available;
  const effectiveAgent: Agent =
    overrideSlices !== undefined ? { ...agent, slices_available: overrideSlices } : agent;
  const allSlices = await listSlices();
  const filtered = sliceFilterForOrchestrator(allSlices, effectiveAgent);
  return {
    slices: filtered.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      capability: s.capability,
      io_schema: s.io_schema,
      version: s.version,
    })),
  };
}

// ─── dispatch_slice ───────────────────────────────────────────────────────────

/**
 * Run a budget + recursion gate before dispatching. Returns either the gate's
 * blocking response or a release callback the caller must invoke when done.
 */
async function gateForDispatch(
  sessionId: string,
  limits: BudgetLimits,
): Promise<
  | { blocked: object }
  | { blocked: null; release: () => Promise<void> }
> {
  const check = await checkBudget(sessionId, limits);
  if (!check.ok) {
    return {
      blocked: {
        status: "budget_exceeded",
        reason: check.reason,
        remaining_budget: check.remaining,
      },
    };
  }
  const maxDepth = limits.max_recursion_depth ?? 3;
  const recursion = await checkAndIncrementRecursion(sessionId, maxDepth);
  if (!recursion.allowed) {
    return {
      blocked: {
        status: "recursion_limit_exceeded",
        current_depth: recursion.currentDepth,
        max_depth: maxDepth,
      },
    };
  }
  return { blocked: null, release: () => decrementRecursion(sessionId) };
}

export async function handleDispatchSlice(
  sessionId: string,
  params: { slice_id: string; inputs: Record<string, unknown> }
): Promise<object> {
  const { agent, meta } = await loadAgentAndMeta(sessionId);
  const limits = effectiveLimits(agent, meta.overrides?.budget);

  const gate = await gateForDispatch(sessionId, limits);
  if (gate.blocked) return gate.blocked;

  try {
    const run = () =>
      executeSlice({
        sessionId,
        sliceId: params.slice_id,
        inputs: params.inputs,
        cwdOverride: agent.cwd,
      });
    const first = await run();
    const result = await applyFailurePolicy(sessionId, agent, first, run);
    const after = await checkBudget(sessionId, limits);
    return { ...result, remaining_budget: after.remaining };
  } finally {
    await gate.release();
  }
}

// ─── dispatch_custom_slice ────────────────────────────────────────────────────

export async function handleDispatchCustomSlice(
  sessionId: string,
  params: { spec: CustomSliceSpec; inputs?: Record<string, unknown> }
): Promise<object> {
  const { agent, meta } = await loadAgentAndMeta(sessionId);

  if (!agent.can_create_custom_slices) {
    return {
      status: "forbidden",
      error: "can_create_custom_slices is disabled",
    };
  }

  const sandboxMode = params.spec.sandbox?.mode ?? "none";
  if (sandboxMode === "worktree") {
    const allowedMutations = agent.allowed_mutations ?? [];
    if (!allowedMutations.includes("writes-source")) {
      return {
        status: "forbidden",
        error: "mutation tier not permitted: writes-source not in allowed_mutations",
      };
    }
  }

  const limits = effectiveLimits(agent, meta.overrides?.budget);
  const gate = await gateForDispatch(sessionId, limits);
  if (gate.blocked) return gate.blocked;

  try {
    const run = () =>
      executeCustomSlice({
        sessionId,
        spec: params.spec,
        inputs: params.inputs,
        cwdOverride: agent.cwd,
      });
    const first = await run();
    const result = await applyFailurePolicy(sessionId, agent, first, run);
    const after = await checkBudget(sessionId, limits);
    return { ...result, remaining_budget: after.remaining };
  } finally {
    await gate.release();
  }
}

// ─── get_budget ───────────────────────────────────────────────────────────────

export async function handleGetBudget(sessionId: string): Promise<object> {
  const { agent, meta } = await loadAgentAndMeta(sessionId);
  const limits = effectiveLimits(agent, meta.overrides?.budget);
  const budget = await readBudget(sessionId);
  const check = await checkBudget(sessionId, limits);
  return {
    budget,
    limits,
    remaining: check.remaining,
  };
}

// ─── stop ─────────────────────────────────────────────────────────────────────

export async function handleStop(
  sessionId: string,
  params: { reason: string }
): Promise<object> {
  await stopBudget(sessionId, params.reason);
  return { stopped: true, reason: params.reason };
}
