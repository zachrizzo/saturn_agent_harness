// MCP tool handler implementations.
// Each function maps 1:1 to an MCP tool exposed on the orchestrator endpoint.
// They are pure async functions — the route layer handles JSON-RPC framing.

import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { DEFAULT_CLI, normalizeCli } from "@/lib/clis";
import { spawnTurn } from "@/lib/turn";
import {
  deleteJob,
  getAgent,
  getSession,
  getSessionMeta,
  listJobs,
  listAgents,
  sessionDir,
} from "@/lib/runs";
import { listSlices } from "@/lib/slices";
import { binDir, sessionsRoot } from "@/lib/paths";
import { isOrchestrator, sliceFilterForOrchestrator } from "@/lib/session-utils";
import { withSessionMetaLock } from "@/lib/session-meta-lock";
import { markSessionRunnerFailed } from "@/lib/session-lifecycle";
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
  type SliceExecutionContext,
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

const CHAT_SWARM_BUDGET: OrchestratorBudget = {
  max_total_tokens: 300000,
  max_slice_calls: 30,
  max_recursion_depth: 1,
};
const ORCHESTRATOR_GRAPH_NODE_ID = "__orchestrator__";

function syncJobCron(name: string): void {
  const register = path.join(binDir(), "register-job.sh");
  const proc = spawn(register, [name], { detached: true, stdio: "ignore" });
  proc.on("error", () => {});
  proc.unref();
}

function effectiveSwarmAgent(agent: Agent, meta: SessionMeta): Agent {
  const overrideSlices = meta.overrides?.slices_available;
  if (isOrchestrator(agent)) {
    return overrideSlices !== undefined ? { ...agent, slices_available: overrideSlices } : agent;
  }

  return {
    ...agent,
    kind: "orchestrator",
    slices_available: overrideSlices ?? agent.slices_available ?? "*",
    can_create_custom_slices: agent.can_create_custom_slices ?? false,
    allowed_mutations: agent.allowed_mutations ?? ["read-only", "writes-scratch", "writes-source"],
    budget: agent.budget ?? CHAT_SWARM_BUDGET,
    on_budget_exceeded: agent.on_budget_exceeded ?? "report-partial",
    on_slice_failure: agent.on_slice_failure ?? "continue",
  };
}

function effectiveLimits(agent: Agent, overrides?: OrchestratorBudget): BudgetLimits {
  const base = agent.budget ?? {};
  const over = overrides ?? {};
  return {
    max_total_tokens: over.max_total_tokens ?? base.max_total_tokens,
    max_slice_calls: over.max_slice_calls ?? base.max_slice_calls,
    max_recursion_depth: over.max_recursion_depth ?? base.max_recursion_depth,
  };
}

function compactTitle(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "Swarm run";
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

async function waitForSessionFinalText(
  sessionId: string,
  waitSeconds?: number,
): Promise<{ status?: SessionMeta["status"]; final_text?: string; finished_at?: string }> {
  const deadline = Date.now() + Math.min(Math.max(waitSeconds ?? 0, 0), 60) * 1000;
  let meta = await getSessionMeta(sessionId);
  while (meta?.status === "running" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    meta = await getSessionMeta(sessionId);
  }
  return {
    status: meta?.status,
    final_text: meta?.turns.at(-1)?.final_text,
    finished_at: meta?.finished_at,
  };
}

async function appendParentBackgroundRun(
  parentSessionId: string,
  childSessionId: string,
  title: string,
): Promise<void> {
  await withSessionMetaLock(parentSessionId, async () => {
    const file = path.join(sessionsRoot(), parentSessionId, "meta.json");
    const raw = await fs.readFile(file, "utf8").catch(() => null);
    if (!raw) return;
    const meta = JSON.parse(raw) as SessionMeta;
    const existing = meta.background_runs ?? [];
    if (existing.some((run) => run.session_id === childSessionId)) return;
    meta.background_runs = [
      ...existing,
      {
        session_id: childSessionId,
        title,
        started_at: new Date().toISOString(),
        source_turn: Math.max(0, meta.turns.length - 1),
      },
    ];
    await fs.writeFile(file, JSON.stringify(meta, null, 2), "utf8");
  });
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
  const realNodeIds = new Set(workflow.nodes.map((node) => node.id));
  const entryNodeIds = workflow.nodes
    .filter((node) => (workflow.upstreamByNode.get(node.id) ?? []).length === 0)
    .map((node) => node.id);
  const terminalNodeIds = workflow.nodes
    .filter((node) => (workflow.downstreamByNode.get(node.id) ?? []).length === 0)
    .map((node) => node.id);
  const savedRootEdges = (agent.slice_graph?.edges ?? [])
    .filter((edge) => edge.from === ORCHESTRATOR_GRAPH_NODE_ID && realNodeIds.has(edge.to));
  const rootEdges = savedRootEdges.length > 0
    ? savedRootEdges
    : entryNodeIds.map((nodeId) => ({
        id: `edge-${ORCHESTRATOR_GRAPH_NODE_ID}-${nodeId}`,
        from: ORCHESTRATOR_GRAPH_NODE_ID,
        to: nodeId,
      }));
  const rootDownstreamNodeIds = rootEdges.map((edge) => edge.to);

  return {
    nodes: [
      {
        id: ORCHESTRATOR_GRAPH_NODE_ID,
        type: "orchestrator",
        label: agent.name,
        execution_order: 0,
        upstream_node_ids: [],
        downstream_node_ids: rootDownstreamNodeIds,
      },
      ...workflow.nodes.map((node, index) => {
        const upstreamNodeIds = workflow.upstreamByNode.get(node.id) ?? [];
        return {
          id: node.id,
          type: "agent_slice",
          slice_id: node.slice_id,
          label: node.label,
          instructions: node.instructions,
          prompt: node.prompt,
          config: node.config,
          execution_order: index + 1,
          upstream_node_ids: upstreamNodeIds.length > 0
            ? upstreamNodeIds
            : rootDownstreamNodeIds.includes(node.id)
              ? [ORCHESTRATOR_GRAPH_NODE_ID]
              : [],
          downstream_node_ids: workflow.downstreamByNode.get(node.id) ?? [],
        };
      }),
    ],
    edges: [...rootEdges, ...workflow.edges],
    execution_model: "dependency_graph",
    orchestrator_node_id: ORCHESTRATOR_GRAPH_NODE_ID,
    entry_node_ids: entryNodeIds,
    terminal_node_ids: terminalNodeIds,
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

// ─── list_swarms / dispatch_swarm ────────────────────────────────────────────

export async function handleListSwarms(_sessionId: string): Promise<object> {
  const agents = await listAgents();
  const swarms = agents.filter((agent) => agent.kind === "orchestrator");
  return {
    swarms: swarms.map((agent) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      default_cli: agent.defaultCli ?? agent.cli,
      model: agent.model,
      models: agent.models,
      cwd: agent.cwd,
      slices_available: agent.slices_available,
      budget: agent.budget,
      tags: agent.tags ?? [],
    })),
  };
}

export async function handleDispatchSwarm(
  sessionId: string,
  params: {
    agent_id: string;
    message: string;
    cwd?: string;
    title?: string;
    wait_seconds?: number;
  },
): Promise<object> {
  const message = params.message.trim();
  if (!message) return { status: "failed", error: "message is required" };

  const { agent: parentAgent, meta: parentMeta } = await loadAgentAndMeta(sessionId);
  const swarm = await getAgent(params.agent_id);
  if (!swarm) {
    return { status: "not_found", error: `Swarm agent not found: ${params.agent_id}` };
  }
  if (swarm.kind !== "orchestrator") {
    return { status: "invalid_agent", error: `${params.agent_id} is not a swarm/orchestrator agent` };
  }

  const cwd = params.cwd?.trim() || parentAgent.cwd || swarm.cwd;
  const childAgent: Agent = cwd ? { ...swarm, cwd } : swarm;
  const cli = normalizeCli(childAgent.defaultCli ?? childAgent.cli ?? DEFAULT_CLI);
  const model = childAgent.models?.[cli] ?? childAgent.model;
  const reasoningEffort = childAgent.reasoningEfforts?.[cli] ?? childAgent.reasoningEffort;
  const childSessionId = randomUUID();
  const childDir = sessionDir(childSessionId);
  const now = new Date().toISOString();
  const title = compactTitle(params.title ?? `${childAgent.name}: ${message}`);

  const meta: SessionMeta = {
    session_id: childSessionId,
    agent_id: childAgent.id,
    agent_snapshot: childAgent,
    started_at: now,
    status: "running",
    turns: [],
    forked_from: { session_id: sessionId, at_turn: parentMeta.turns.length },
    read_at: now,
  };

  await fs.mkdir(childDir, { recursive: true });
  await fs.writeFile(path.join(childDir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  await fs.writeFile(path.join(childDir, "stream.jsonl"), "", "utf8");
  await fs.writeFile(path.join(childDir, "stderr.log"), "", "utf8");

  try {
    await appendParentBackgroundRun(sessionId, childSessionId, title);
    await spawnTurn(childSessionId, cli, model, message, childAgent, undefined, reasoningEffort);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await markSessionRunnerFailed(childSessionId, `failed to start swarm: ${detail}`);
    return {
      status: "failed",
      error: detail,
      agent_id: childAgent.id,
      session_id: childSessionId,
      chat_url: `/chats/${childSessionId}`,
    };
  }

  const waited = await waitForSessionFinalText(childSessionId, params.wait_seconds);
  return {
    status: waited.status === "running" || !waited.status ? "started" : waited.status,
    agent_id: childAgent.id,
    agent_name: childAgent.name,
    session_id: childSessionId,
    chat_url: `/chats/${childSessionId}`,
    cwd,
    ...(waited.final_text ? { final_text: waited.final_text } : {}),
    ...(waited.finished_at ? { finished_at: waited.finished_at } : {}),
  };
}

// ─── jobs ──────────────────────────────────────────────────────────────────────

export async function handleListJobs(): Promise<object> {
  const jobs = await listJobs();
  return {
    jobs: jobs.map((job) => ({
      name: job.name,
      cron: job.cron,
      description: job.description,
      cli: job.cli,
      model: job.model,
      cwd: job.cwd,
      catchUpMissedRuns: job.catchUpMissedRuns,
    })),
  };
}

export async function handleDeleteJob(
  _sessionId: string,
  params: { name: string }
): Promise<object> {
  const job = await deleteJob(params.name);
  syncJobCron(params.name);
  return {
    deleted: true,
    job: {
      name: job.name,
      cron: job.cron,
      description: job.description,
    },
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
  const effectiveAgent = effectiveSwarmAgent(agent, meta);
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
  options?: { skipRecursion?: boolean },
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
  if (options?.skipRecursion) {
    return { blocked: null, release: async () => {} };
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
  params: {
    slice_id: string;
    inputs: Record<string, unknown>;
    execution_context?: SliceExecutionContext;
    internal_skip_recursion_gate?: boolean;
  }
): Promise<object> {
  const { agent, meta } = await loadAgentAndMeta(sessionId);
  const effectiveAgent = effectiveSwarmAgent(agent, meta);
  const availableSlices = sliceFilterForOrchestrator(await listSlices(), effectiveAgent);
  if (!availableSlices.some((slice) => slice.id === params.slice_id)) {
    return {
      status: "forbidden",
      error: `slice is not available to this chat: ${params.slice_id}`,
    };
  }

  const limits = effectiveLimits(effectiveAgent, meta.overrides?.budget);

  const gate = await gateForDispatch(sessionId, limits, {
    skipRecursion: params.internal_skip_recursion_gate === true,
  });
  if (gate.blocked) return gate.blocked;

  try {
    const run = () =>
      executeSlice({
        sessionId,
        sliceId: params.slice_id,
        inputs: params.inputs,
        executionContext: params.execution_context,
        cwdOverride: effectiveAgent.cwd,
      });
    const first = await run();
    const result = await applyFailurePolicy(sessionId, effectiveAgent, first, run);
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

  const selectedNodeIds = new Set(nodesToRun.map((node) => node.id));
  const results = new Map<string, object>();
  const runs: object[] = [];
  let failedCount = 0;

  const executionOrderByNode = new Map(nodesToRun.map((node, index) => [node.id, index + 1]));
  const remainingNodeIds = new Set(selectedNodeIds);
  const nodeById = new Map(nodesToRun.map((node) => [node.id, node]));

  const runNode = async (node: SliceGraphNode) => {
    const executionOrder = executionOrderByNode.get(node.id) ?? runs.length + 1;
    const upstreamNodeIds = (params.workflow.upstreamByNode.get(node.id) ?? [])
      .filter((nodeId) => selectedNodeIds.has(nodeId) && results.has(nodeId));
    const downstreamNodeIds = params.workflow.downstreamByNode.get(node.id) ?? [];
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
        execution_order: executionOrder,
        upstream_node_ids: upstreamNodeIds,
        downstream_node_ids: downstreamNodeIds,
      },
      upstream_results: upstreamResults,
    };
    const executionContext: SliceExecutionContext = {
      graph_run_id: params.record?.graph_run_id,
      graph_node_id: node.id,
      label: node.label,
      execution_order: executionOrder,
      upstream_node_ids: upstreamNodeIds,
      downstream_node_ids: downstreamNodeIds,
    };

    const result = await handleDispatchSlice(params.sessionId, {
      slice_id: node.slice_id,
      inputs: nodeInputs,
      execution_context: executionContext,
      internal_skip_recursion_gate: true,
    });
    return {
      node_id: node.id,
      slice_id: node.slice_id,
      label: node.label,
      execution_order: executionOrder,
      upstream_node_ids: upstreamNodeIds,
      downstream_node_ids: downstreamNodeIds,
      upstream_result_count: upstreamResults.length,
      result,
    };
  };

  while (remainingNodeIds.size > 0) {
    const readyNodes = nodesToRun.filter((node) => {
      if (!remainingNodeIds.has(node.id)) return false;
      const requiredUpstreamNodeIds = (params.workflow.upstreamByNode.get(node.id) ?? [])
        .filter((nodeId) => selectedNodeIds.has(nodeId));
      return requiredUpstreamNodeIds.every((nodeId) => results.has(nodeId));
    });

    if (readyNodes.length === 0) {
      throw new Error("No runnable slice graph nodes found; check graph dependencies for a cycle or missing upstream node.");
    }

    const waveEntries = await Promise.all(readyNodes.map((node) => runNode(node)));
    for (const entry of waveEntries.sort((a, b) => a.execution_order - b.execution_order)) {
      if (isFailedNodeResult(entry.result)) failedCount += 1;
      results.set(entry.node_id, entry);
      runs.push(entry);
      remainingNodeIds.delete(entry.node_id);
    }
    if (params.record) {
      params.record.runs = runs;
      await writeGraphRun(params.record);
    }
  }

  const terminalNodeIds = nodesToRun
    .filter((node) => (params.workflow.downstreamByNode.get(node.id) ?? [])
      .filter((nodeId) => selectedNodeIds.has(nodeId)).length === 0)
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
  const effectiveAgent = effectiveSwarmAgent(agent, meta);
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
  const effectiveAgent = effectiveSwarmAgent(agent, meta);

  if (!effectiveAgent.can_create_custom_slices) {
    return {
      status: "forbidden",
      error: "can_create_custom_slices is disabled",
    };
  }

  const sandboxMode = params.spec.sandbox?.mode ?? "none";
  if (sandboxMode === "worktree") {
    const allowedMutations = effectiveAgent.allowed_mutations ?? [];
    if (!allowedMutations.includes("writes-source")) {
      return {
        status: "forbidden",
        error: "mutation tier not permitted: writes-source not in allowed_mutations",
      };
    }
  }

  const limits = effectiveLimits(effectiveAgent, meta.overrides?.budget);
  const gate = await gateForDispatch(sessionId, limits);
  if (gate.blocked) return gate.blocked;

  try {
    const run = () =>
      executeCustomSlice({
        sessionId,
        spec: params.spec,
        inputs: params.inputs,
        cwdOverride: effectiveAgent.cwd,
      });
    const first = await run();
    const result = await applyFailurePolicy(sessionId, effectiveAgent, first, run);
    const after = await checkBudget(sessionId, limits);
    return { ...result, remaining_budget: after.remaining };
  } finally {
    await gate.release();
  }
}

// ─── get_budget ───────────────────────────────────────────────────────────────

export async function handleGetBudget(sessionId: string): Promise<object> {
  const { agent, meta } = await loadAgentAndMeta(sessionId);
  const effectiveAgent = effectiveSwarmAgent(agent, meta);
  const limits = effectiveLimits(effectiveAgent, meta.overrides?.budget);
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
