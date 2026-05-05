export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sessionsRoot } from "@/lib/paths";
import { getTokenBreakdown, parseStreamJsonl } from "@/lib/events";

type SliceIndexEntry = {
  slice_run_id: string;
  graph_run_id?: string;
  graph_node_id?: string;
  slice_id?: string;
  label?: string;
  status?: string;
  started_at?: string;
  finished_at?: string;
  tokens?: { input: number; output: number; total: number };
  duration_ms?: number;
  sandbox_mode?: string;
  planned?: boolean;
  execution_order?: number;
};

type GraphRunRecord = {
  graph_run_id?: string;
  status?: string;
  workflow_graph?: {
    nodes?: Array<{
      id?: string;
      slice_id?: string;
      label?: string;
      execution_order?: number;
    }>;
  };
  runs?: Array<{
    node_id?: string;
    slice_id?: string;
    label?: string;
    execution_order?: number;
    result?: {
      slice_run_id?: string;
      status?: string;
      tokens?: { input?: number; output?: number; total?: number };
      duration_ms?: number;
    };
  }>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function tokenField(record: Record<string, unknown>): SliceIndexEntry["tokens"] | undefined {
  const tokens = asRecord(record.tokens);
  const input = numberField(tokens, "input");
  const output = numberField(tokens, "output");
  const total = numberField(tokens, "total");
  if (input === undefined && output === undefined && total === undefined) return undefined;
  return {
    input: input ?? 0,
    output: output ?? 0,
    total: total ?? 0,
  };
}

function normalizeEntry(value: unknown): SliceIndexEntry | null {
  const record = asRecord(value);
  const slice_run_id = stringField(record, "slice_run_id");
  if (!slice_run_id) return null;
  return {
    slice_run_id,
    graph_run_id: stringField(record, "graph_run_id"),
    graph_node_id: stringField(record, "graph_node_id"),
    slice_id: stringField(record, "slice_id"),
    label: stringField(record, "label"),
    status: stringField(record, "status"),
    started_at: stringField(record, "started_at"),
    finished_at: stringField(record, "finished_at"),
    tokens: tokenField(record),
    duration_ms: numberField(record, "duration_ms"),
    sandbox_mode: stringField(record, "sandbox_mode"),
    planned: record.planned === true,
    execution_order: numberField(record, "execution_order"),
  };
}

function latestEntries(entries: SliceIndexEntry[]): SliceIndexEntry[] {
  const byRun = new Map<string, SliceIndexEntry>();
  for (const entry of entries) {
    byRun.set(entry.slice_run_id, { ...byRun.get(entry.slice_run_id), ...entry });
  }
  return [...byRun.values()].sort((a, b) => {
    if (a.execution_order !== undefined || b.execution_order !== undefined) {
      return (a.execution_order ?? Number.MAX_SAFE_INTEGER) - (b.execution_order ?? Number.MAX_SAFE_INTEGER);
    }
    const aT = a.started_at ? Date.parse(a.started_at) : Number.MAX_SAFE_INTEGER;
    const bT = b.started_at ? Date.parse(b.started_at) : Number.MAX_SAFE_INTEGER;
    return aT - bT;
  });
}

async function sliceIdsFromMainStream(sessionDir: string): Promise<Map<string, string>> {
  const byToolUse = new Map<string, string>();
  const byRun = new Map<string, string>();
  let raw: string;
  try {
    raw = await fs.readFile(path.join(sessionDir, "stream.jsonl"), "utf8");
  } catch {
    return byRun;
  }

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const record = asRecord(obj);
    const content = asRecord(asRecord(record.message).content);
    const item = asRecord(record.item);
    const candidates = Array.isArray(asRecord(record.message).content)
      ? asRecord(record.message).content as unknown[]
      : [content, item, record];

    for (const candidate of candidates) {
      const c = asRecord(candidate);
      const name = stringField(c, "name");
      const id = stringField(c, "id") ?? stringField(c, "tool_use_id");
      const input = asRecord(c.input);
      if (name === "mcp__orchestrator__dispatch_slice" && id) {
        const sliceId = stringField(input, "slice_id");
        if (sliceId) byToolUse.set(id, sliceId);
      }

      const toolUseId = stringField(c, "tool_use_id") ?? stringField(c, "toolUseId");
      const sliceId = toolUseId ? byToolUse.get(toolUseId) : undefined;
      if (!sliceId) continue;
      const resultContent = c.content;
      const texts = Array.isArray(resultContent) ? resultContent : [resultContent];
      for (const textCandidate of texts) {
        const text =
          typeof textCandidate === "string"
            ? textCandidate
            : stringField(asRecord(textCandidate), "text");
        if (!text) continue;
        try {
          const parsed = JSON.parse(text);
          const runId = stringField(asRecord(parsed), "slice_run_id");
          if (runId) byRun.set(runId, sliceId);
        } catch {
          /* ignore non-JSON tool output */
        }
      }
    }
  }

  return byRun;
}

async function readIndexEntries(slicesDir: string): Promise<SliceIndexEntry[]> {
  const indexPath = path.join(slicesDir, "index.jsonl");
  let raw: string;
  try {
    raw = await fs.readFile(indexPath, "utf8");
  } catch {
    return [];
  }

  const entries: SliceIndexEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = normalizeEntry(JSON.parse(line));
      if (entry) entries.push(entry);
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

async function readMetaEntries(
  sessionDir: string,
  streamSliceIds: Map<string, string>
): Promise<SliceIndexEntry[]> {
  const slicesDir = path.join(sessionDir, "slices");
  let dirs: import("node:fs").Dirent[];
  try {
    dirs = await fs.readdir(slicesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const entries = await Promise.all(dirs
    .filter((dir) => dir.isDirectory())
    .map(async (dir) => {
      const runId = dir.name;
      try {
        const raw = await fs.readFile(path.join(slicesDir, runId, "meta.json"), "utf8");
        const meta = asRecord(JSON.parse(raw));
        return normalizeEntry({
          ...meta,
          slice_run_id: stringField(meta, "slice_run_id") ?? runId,
          slice_id: stringField(meta, "slice_id") ?? streamSliceIds.get(runId),
          status: stringField(meta, "status") ?? "running",
        });
      } catch {
        return normalizeEntry({
          slice_run_id: runId,
          slice_id: streamSliceIds.get(runId),
          status: "running",
        });
      }
    }));
  return entries.filter((entry): entry is SliceIndexEntry => Boolean(entry));
}

async function enrichWithStreamTokens(sessionDir: string, entries: SliceIndexEntry[]): Promise<SliceIndexEntry[]> {
  return Promise.all(entries.map(async (entry) => {
    if (entry.planned) return entry;
    if (entry.tokens?.total && entry.tokens.total > 0) return entry;
    try {
      const raw = await fs.readFile(path.join(sessionDir, "slices", entry.slice_run_id, "stream.jsonl"), "utf8");
      const tokens = getTokenBreakdown(parseStreamJsonl(raw));
      if (tokens.total <= 0) return entry;
      return {
        ...entry,
        tokens: {
          input: tokens.input,
          output: tokens.output,
          total: tokens.total,
        },
      };
    } catch {
      return entry;
    }
  }));
}

async function latestGraphRun(sessionDir: string): Promise<GraphRunRecord | null> {
  const graphRunsDir = path.join(sessionDir, "graph-runs");
  try {
    const entries = await fs.readdir(graphRunsDir, { withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
    if (files.length === 0) return null;
    const stats = await Promise.all(files.map(async (file) => ({
      file: file.name,
      mtimeMs: (await fs.stat(path.join(graphRunsDir, file.name))).mtimeMs,
    })));
    stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const raw = await fs.readFile(path.join(graphRunsDir, stats[0]!.file), "utf8");
    return JSON.parse(raw) as GraphRunRecord;
  } catch {
    return null;
  }
}

function plannedEntriesFromGraph(graph: GraphRunRecord | null, actualEntries: SliceIndexEntry[]): SliceIndexEntry[] {
  const nodes = graph?.workflow_graph?.nodes ?? [];
  if (!graph?.graph_run_id || nodes.length === 0) return [];

  const actualByRunId = new Map(actualEntries.map((entry) => [entry.slice_run_id, entry]));
  const usedRunIds = new Set<string>();
  const completedNodeIds = new Set<string>();
  for (const run of graph.runs ?? []) {
    if (run.node_id) completedNodeIds.add(run.node_id);
  }

  return nodes.map((node, index) => {
    const completedRun = (graph.runs ?? []).find((run) => run.node_id === node.id);
    const completedRunId = completedRun?.result?.slice_run_id;
    if (completedRunId && actualByRunId.has(completedRunId)) {
      usedRunIds.add(completedRunId);
      return {
        ...actualByRunId.get(completedRunId)!,
        graph_run_id: graph.graph_run_id,
        graph_node_id: node.id,
        slice_id: actualByRunId.get(completedRunId)!.slice_id ?? node.slice_id,
        label: node.label ?? actualByRunId.get(completedRunId)!.label,
        execution_order: node.execution_order ?? index + 1,
      };
    }

    const runningMatch = actualEntries.find((entry) =>
      !usedRunIds.has(entry.slice_run_id) &&
      entry.status === "running" &&
      entry.slice_id === node.slice_id &&
      !completedNodeIds.has(node.id ?? "")
    );
    if (runningMatch) {
      usedRunIds.add(runningMatch.slice_run_id);
      return {
        ...runningMatch,
        graph_run_id: graph.graph_run_id,
        graph_node_id: node.id,
        label: node.label ?? runningMatch.label,
        execution_order: node.execution_order ?? index + 1,
      };
    }

    return {
      slice_run_id: `planned:${graph.graph_run_id}:${node.id ?? index}`,
      graph_run_id: graph.graph_run_id,
      graph_node_id: node.id,
      slice_id: node.slice_id,
      label: node.label,
      status: graph.status === "running" ? "queued" : "skipped",
      planned: true,
      execution_order: node.execution_order ?? index + 1,
    };
  });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const sessionDir = path.join(sessionsRoot(), id);
  const slicesDir = path.join(sessionDir, "slices");
  const [streamSliceIds, indexEntries] = await Promise.all([
    sliceIdsFromMainStream(sessionDir),
    readIndexEntries(slicesDir),
  ]);
  const metaEntries = await readMetaEntries(sessionDir, streamSliceIds);
  const actualEntries = await enrichWithStreamTokens(sessionDir, latestEntries([...indexEntries, ...metaEntries]));
  const graph = await latestGraphRun(sessionDir);
  const plannedEntries = plannedEntriesFromGraph(graph, actualEntries);
  return NextResponse.json({ slices: plannedEntries.length > 0 ? latestEntries(plannedEntries) : actualEntries });
}
