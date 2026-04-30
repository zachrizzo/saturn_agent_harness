// MCP tool handler implementations.
// Each function maps 1:1 to an MCP tool exposed on the orchestrator endpoint.
// They are pure async functions — the route layer handles JSON-RPC framing.

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { getSession } from "@/lib/runs";
import { listSlices } from "@/lib/slices";
import { sessionsRoot } from "@/lib/paths";
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
import type { Agent, OrchestratorBudget, SessionMeta, SliceGraph, SliceGraphNode } from "@/lib/runs";
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

type OrderedWorkflow = {
  nodes: SliceGraphNode[];
  edges: SliceGraph["edges"];
  upstreamByNode: Map<string, string[]>;
  downstreamByNode: Map<string, string[]>;
  cycleNodeIds: string[];
};

type GraphRunRecord = {
  graph_run_id: string;
  session_id: string;
  status: "running" | "success" | "failed";
  started_at: string;
  finished_at?: string;
  workflow_graph: object | null;
  inputs: Record<string, unknown>;
  runs: object[];
  terminal_results: object[];
  error?: string;
};

type WorkflowRunResult = {
  runs: object[];
  terminal_results: object[];
  failed_count: number;
  error?: string;
};

function compareGraphNodes(a: SliceGraphNode, b: SliceGraphNode): number {
  return (a.y - b.y) || (a.x - b.x) || a.id.localeCompare(b.id);
}

function graphRunsDir(sessionId: string): string {
  return path.join(sessionsRoot(), sessionId, "graph-runs");
}

function graphRunPath(sessionId: string, graphRunId: string): string {
  return path.join(graphRunsDir(sessionId), `${graphRunId}.json`);
}

async function writeGraphRun(record: GraphRunRecord): Promise<void> {
  await fs.mkdir(graphRunsDir(record.session_id), { recursive: true });
  await fs.writeFile(
    graphRunPath(record.session_id, record.graph_run_id),
    JSON.stringify(record, null, 2),
    "utf8",
  );
}

async function readGraphRun(sessionId: string, graphRunId: string): Promise<GraphRunRecord | null> {
  try {
    return JSON.parse(await fs.readFile(graphRunPath(sessionId, graphRunId), "utf8")) as GraphRunRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function latestGraphRunId(sessionId: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(graphRunsDir(sessionId), { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.replace(/\.json$/, ""));
    if (files.length === 0) return null;
    const stats = await Promise.all(
      files.map(async (id) => ({
        id,
        mtimeMs: (await fs.stat(graphRunPath(sessionId, id))).mtimeMs,
      })),
    );
    stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return stats[0]?.id ?? null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function waitForGraphRun(
  sessionId: string,
  graphRunId: string,
  waitSeconds?: number,
): Promise<GraphRunRecord | null> {
  const deadline = Date.now() + Math.min(Math.max(waitSeconds ?? 0, 0), 30) * 1000;
  let record = await readGraphRun(sessionId, graphRunId);
  while (record?.status === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    record = await readGraphRun(sessionId, graphRunId);
  }
  return record;
}

function buildOrderedWorkflow(agent: Agent): OrderedWorkflow | null {
  const graph = agent.slice_graph;
  if (!graph || graph.nodes.length === 0) return null;

  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const edges = graph.edges.filter((edge) => nodesById.has(edge.from) && nodesById.has(edge.to));
  const indegree = new Map(graph.nodes.map((node) => [node.id, 0]));
  const upstreamByNode = new Map(graph.nodes.map((node) => [node.id, [] as string[]]));
  const downstreamByNode = new Map(graph.nodes.map((node) => [node.id, [] as string[]]));

  for (const edge of edges) {
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    upstreamByNode.get(edge.to)?.push(edge.from);
    downstreamByNode.get(edge.from)?.push(edge.to);
  }

  const queue = graph.nodes
    .filter((node) => (indegree.get(node.id) ?? 0) === 0)
    .sort(compareGraphNodes);
  const ordered: SliceGraphNode[] = [];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (seen.has(node.id)) continue;
    ordered.push(node);
    seen.add(node.id);

    for (const childId of downstreamByNode.get(node.id) ?? []) {
      const nextDegree = (indegree.get(childId) ?? 0) - 1;
      indegree.set(childId, nextDegree);
      if (nextDegree === 0) {
        const child = nodesById.get(childId);
        if (child) {
          queue.push(child);
          queue.sort(compareGraphNodes);
        }
      }
    }
  }

  const remaining = [...graph.nodes]
    .filter((node) => !seen.has(node.id))
    .sort(compareGraphNodes);
  ordered.push(...remaining);

  return {
    nodes: ordered,
    edges,
    upstreamByNode,
    downstreamByNode,
    cycleNodeIds: remaining.map((node) => node.id),
  };
}

function workflowPayload(agent: Agent): object | null {
  const workflow = buildOrderedWorkflow(agent);
  if (!workflow) return null;

  return {
    nodes: workflow.nodes.map((node, index) => ({
      id: node.id,
      slice_id: node.slice_id,
      label: node.label,
      instructions: node.instructions,
      prompt: node.prompt,
      config: node.config,
      execution_order: index + 1,
      upstream_node_ids: workflow.upstreamByNode.get(node.id) ?? [],
      downstream_node_ids: workflow.downstreamByNode.get(node.id) ?? [],
    })),
    edges: workflow.edges,
    entry_node_ids: workflow.nodes
      .filter((node) => (workflow.upstreamByNode.get(node.id) ?? []).length === 0)
      .map((node) => node.id),
    terminal_node_ids: workflow.nodes
      .filter((node) => (workflow.downstreamByNode.get(node.id) ?? []).length === 0)
      .map((node) => node.id),
    validation: workflow.cycleNodeIds.length > 0
      ? {
          ok: false,
          error: "slice_graph_cycle",
          cycle_node_ids: workflow.cycleNodeIds,
        }
      : { ok: true },
  };
}

function isFailedNodeResult(result: object): boolean {
  const status = (result as { status?: unknown }).status;
  return typeof status === "string" && status !== "success";
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
    workflow_graph: workflowPayload(effectiveAgent),
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

// ─── run_slice_graph ─────────────────────────────────────────────────────────

async function executeWorkflowRun(params: {
  sessionId: string;
  workflow: OrderedWorkflow;
  baseInputs: Record<string, unknown>;
  startNodeId?: string;
  maxNodes?: number;
  record?: GraphRunRecord;
}): Promise<WorkflowRunResult> {
  const allowedNodeIds = new Set(params.workflow.nodes.map((node) => node.id));
  let nodesToRun = params.workflow.nodes;
  if (params.startNodeId) {
    if (!allowedNodeIds.has(params.startNodeId)) {
      throw new Error(`Unknown start_node_id: ${params.startNodeId}`);
    }
    const reachable = new Set<string>();
    const stack = [params.startNodeId];
    while (stack.length > 0) {
      const nodeId = stack.pop()!;
      if (reachable.has(nodeId)) continue;
      reachable.add(nodeId);
      stack.push(...(params.workflow.downstreamByNode.get(nodeId) ?? []));
    }
    nodesToRun = params.workflow.nodes.filter((node) => reachable.has(node.id));
  }

  if (params.maxNodes && params.maxNodes > 0) {
    nodesToRun = nodesToRun.slice(0, params.maxNodes);
  }

  const results = new Map<string, object>();
  const runs: object[] = [];
  let failedCount = 0;

  for (const [index, node] of nodesToRun.entries()) {
    const upstreamNodeIds = (params.workflow.upstreamByNode.get(node.id) ?? [])
      .filter((nodeId) => results.has(nodeId));
    const upstreamResults = upstreamNodeIds.map((nodeId) => results.get(nodeId));
    const nodeInputs = {
      ...params.baseInputs,
      workflow_node: {
        id: node.id,
        slice_id: node.slice_id,
        label: node.label,
        instructions: node.instructions,
        prompt: node.prompt,
        config: node.config,
        execution_order: index + 1,
        upstream_node_ids: upstreamNodeIds,
      },
      upstream_results: upstreamResults,
    };

    const result = await handleDispatchSlice(params.sessionId, {
      slice_id: node.slice_id,
      inputs: nodeInputs,
    });
    const entry = {
      node_id: node.id,
      slice_id: node.slice_id,
      label: node.label,
      execution_order: index + 1,
      upstream_node_ids: upstreamNodeIds,
      upstream_result_count: upstreamResults.length,
      result,
    };
    if (isFailedNodeResult(result)) failedCount += 1;
    results.set(node.id, entry);
    runs.push(entry);

    if (params.record) {
      params.record.runs = runs;
      await writeGraphRun(params.record);
    }
  }

  const terminalNodeIds = params.workflow.nodes
    .filter((node) => (params.workflow.downstreamByNode.get(node.id) ?? []).length === 0)
    .map((node) => node.id);

  return {
    runs,
    terminal_results: terminalNodeIds
      .map((nodeId) => results.get(nodeId))
      .filter((result): result is object => Boolean(result)),
    failed_count: failedCount,
    error: failedCount > 0 ? `${failedCount} workflow node(s) did not complete successfully.` : undefined,
  };
}

async function runWorkflowInBackground(params: {
  sessionId: string;
  workflow: OrderedWorkflow;
  baseInputs: Record<string, unknown>;
  startNodeId?: string;
  maxNodes?: number;
  record: GraphRunRecord;
}): Promise<void> {
  try {
    const result = await executeWorkflowRun({
      sessionId: params.sessionId,
      workflow: params.workflow,
      baseInputs: params.baseInputs,
      startNodeId: params.startNodeId,
      maxNodes: params.maxNodes,
      record: params.record,
    });
    params.record.status = result.failed_count > 0 ? "failed" : "success";
    params.record.finished_at = new Date().toISOString();
    params.record.runs = result.runs;
    params.record.terminal_results = result.terminal_results;
    params.record.error = result.error;
  } catch (err) {
    params.record.status = "failed";
    params.record.finished_at = new Date().toISOString();
    params.record.error = err instanceof Error ? err.message : "slice graph run failed";
  }
  await writeGraphRun(params.record);
}

export async function handleRunSliceGraph(
  sessionId: string,
  params: {
    inputs?: Record<string, unknown>;
    start_node_id?: string;
    max_nodes?: number;
    wait?: boolean;
  }
): Promise<object> {
  const { agent, meta } = await loadAgentAndMeta(sessionId);
  const overrideSlices = meta.overrides?.slices_available;
  const effectiveAgent: Agent =
    overrideSlices !== undefined ? { ...agent, slices_available: overrideSlices } : agent;
  const workflow = buildOrderedWorkflow(effectiveAgent);

  if (!workflow) {
    return {
      status: "no_graph",
      error: "No saved slice graph is configured for this orchestrator.",
    };
  }
  if (workflow.cycleNodeIds.length > 0) {
    return {
      status: "invalid_graph",
      error: "The saved slice graph contains a cycle. Remove the cycle before running the workflow.",
      cycle_node_ids: workflow.cycleNodeIds,
      workflow_graph: workflowPayload(effectiveAgent),
    };
  }

  const baseInputs = params.inputs ?? {};
  if (params.wait) {
    try {
      const result = await executeWorkflowRun({
        sessionId,
        workflow,
        baseInputs,
        startNodeId: params.start_node_id,
        maxNodes: params.max_nodes,
      });
      return {
        status: result.failed_count > 0 ? "failed" : "success",
        workflow_graph: workflowPayload(effectiveAgent),
        runs: result.runs,
        terminal_results: result.terminal_results,
        error: result.error,
      };
    } catch (err) {
      return {
        status: "failed",
        error: err instanceof Error ? err.message : "slice graph run failed",
        workflow_graph: workflowPayload(effectiveAgent),
      };
    }
  }

  const graphRunId = randomUUID();
  const record: GraphRunRecord = {
    graph_run_id: graphRunId,
    session_id: sessionId,
    status: "running",
    started_at: new Date().toISOString(),
    workflow_graph: workflowPayload(effectiveAgent),
    inputs: baseInputs,
    runs: [],
    terminal_results: [],
  };
  await writeGraphRun(record);
  void runWorkflowInBackground({
    sessionId,
    workflow,
    baseInputs,
    startNodeId: params.start_node_id,
    maxNodes: params.max_nodes,
    record,
  });

  return {
    status: "started",
    graph_run_id: graphRunId,
    workflow_graph: record.workflow_graph,
    poll_tool: "get_slice_graph_run",
    message: "Slice graph run started. Poll get_slice_graph_run with graph_run_id; downstream nodes receive upstream_results from completed upstream nodes.",
  };
}

export async function handleGetSliceGraphRun(
  sessionId: string,
  params: { graph_run_id?: string; wait_seconds?: number }
): Promise<object> {
  const graphRunId = params.graph_run_id ?? await latestGraphRunId(sessionId);
  if (!graphRunId) {
    return { status: "not_found", error: "No slice graph run exists for this session." };
  }
  const record = await waitForGraphRun(sessionId, graphRunId, params.wait_seconds);
  if (!record) {
    return {
      status: "not_found",
      error: `Unknown graph_run_id: ${graphRunId}`,
      graph_run_id: graphRunId,
    };
  }
  return record;
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
