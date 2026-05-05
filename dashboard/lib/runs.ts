import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { jobsFile, runsRoot, agentsFile, sessionsRoot } from "./paths";
import { parseStreamJsonl, type StreamEvent } from "./events";
import type { ModelReasoningEffort } from "./models";
import { countTextTokensForCli } from "./token-counters";
import { DEFAULT_CLI, normalizeCli } from "./clis";
import type { CLI } from "./clis";
import { reconcileStaleRunningSession } from "./session-lifecycle";
import { withSessionMetaLock } from "./session-meta-lock";
export type { StreamEvent, TokenBreakdown, ToolCallSummary } from "./events";
export { toEvents, getTokenBreakdown, getToolCallSummary } from "./events";
export type { CLI } from "./clis";

export type AgentKind = "chat" | "orchestrator";
export type MutationTier = "read-only" | "writes-scratch" | "writes-source";
export type PlanAction = "start" | "revise" | "approve";

export type PlanModeState = {
  status: "awaiting_approval";
  cli: CLI;
  turn_id?: string;
  started_at: string;
  updated_at: string;
  last_plan?: string;
};

export type OrchestratorBudget = {
  max_total_tokens?: number;
  max_slice_calls?: number;
  max_recursion_depth?: number;
};

export type OnBudgetExceeded = "report-partial" | "stop-hard";
export type OnSliceFailure = "retry-once" | "continue" | "abort";

export type SliceGraphNode = {
  id: string;
  slice_id: string;
  x: number;
  y: number;
  label?: string;
  instructions?: string;
  prompt?: string;
  config?: string;
};

export type SliceGraphEdge = {
  id: string;
  from: string;
  to: string;
};

export type SliceGraph = {
  nodes: SliceGraphNode[];
  edges: SliceGraphEdge[];
};

export type Job = {
  name: string;
  cron: string;
  description?: string;
  cwd?: string;
  prompt: string;
  allowedTools?: string[];
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  cli?: CLI;
  timeout_seconds?: number;
  catchUpMissedRuns?: boolean;
};

export type JobUpdatePatch = {
  cron?: string;
  description?: string | null;
  cwd?: string | null;
  prompt?: string;
  allowedTools?: string[] | null;
  model?: string | null;
  reasoningEffort?: ModelReasoningEffort | null;
  cli?: CLI | null;
  timeout_seconds?: number | null;
  catchUpMissedRuns?: boolean;
};

export type Agent = {
  id: string;
  name: string;
  description?: string;
  // Multi-CLI support: supportedClis + defaultCli replace the old single `cli` field.
  // Old agents with just `cli` are still accepted (treated as supportedClis:[cli]).
  cli?: CLI;                       // legacy — kept for backward compat
  supportedClis?: CLI[];
  defaultCli?: CLI;
  model?: string;                  // legacy single-model; replaced by models map
  models?: Partial<Record<CLI, string>>;
  reasoningEffort?: ModelReasoningEffort;
  reasoningEfforts?: Partial<Record<CLI, ModelReasoningEffort>>;
  prompt: string;
  cwd?: string;
  allowedTools?: string[];
  tags?: string[];
  cron?: string | null;
  created_at: string;
  updated_at?: string;
  // Swarm/orchestrator extensions. All optional — agents without `kind` behave as `kind: "chat"`.
  kind?: AgentKind;
  slices_available?: string[] | "*";
  can_create_custom_slices?: boolean;
  allowed_mutations?: MutationTier[];
  budget?: OrchestratorBudget;
  on_budget_exceeded?: OnBudgetExceeded;
  on_slice_failure?: OnSliceFailure;
  slice_graph?: SliceGraph;
};

// Re-export agent helpers from session-utils (client-safe, no Node built-ins)
export { agentDefaultCli, agentSupportedClis, agentModelForCli } from "./session-utils";

export type TurnRecord = {
  turn_id?: string;       // dashboard-owned id; stable even if the CLI reuses native sessions
  cli: CLI;
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  plan_action?: PlanAction;
  plan_mode?: "plan" | "default";
  cli_session_id?: string;   // underlying CLI's own session id, for native resume
  started_at: string;
  finished_at?: string;
  status?: "running" | "success" | "failed" | "aborted";
  user_message: string;
  final_text?: string;
};

export type BackgroundRunRecord = {
  session_id: string;
  title: string;
  started_at: string;
  source_turn?: number;
};

export type SessionMeta = {
  session_id: string;
  agent_id?: string;           // null for ad-hoc chats
  agent_snapshot?: Agent;      // frozen copy at session start so deleting agent doesn't break session
  started_at: string;
  finished_at?: string;
  status: "running" | "success" | "failed" | "idle";
  turns: TurnRecord[];
  // Per-session overrides for orchestrator runs — never mutate the saved agent.
  overrides?: {
    model?: string;
    strategy_prompt?: string;
    slices_available?: string[] | "*";
    budget?: OrchestratorBudget;
  };
  // Present when this session was forked from another.
  forked_from?: {
    session_id: string;
    at_turn: number;
  };
  // Running sessions that were moved out of the foreground so this session can
  // continue from the last completed turn.
  background_runs?: BackgroundRunRecord[];
  plan_mode?: PlanModeState;
  // Inbox-triage state. All optional — sessions written before this existed
  // just read back as undefined and default to "not pinned / not archived".
  pinned?: boolean;
  archived?: boolean;
  snoozed_until?: string | null; // ISO timestamp; null clears it
  read_at?: string;              // ISO — last time the user opened this chat
  tags?: string[];               // freeform labels shown inline in the inbox
};

export type SessionTriagePatch = {
  pinned?: boolean;
  archived?: boolean;
  snoozed_until?: string | null;
  read_at?: string;
  tags?: string[];
};

export type SessionEventReadMode = "all" | "recent";

export type SessionReadOptions = {
  eventMode?: SessionEventReadMode;
  recentTurns?: number;
  recentMaxBytes?: number;
  compactEvents?: boolean;
  compactValueChars?: number;
  compactMeta?: boolean;
  compactMetaChars?: number;
};

export type SessionListOptions = {
  compactMeta?: boolean;
  compactMetaChars?: number;
};

export type RunMeta = {
  name: string;
  slug: string;
  cron: string;
  started_at: string;
  finished_at?: string;
  status: "running" | "success" | "failed";
  exit_code?: number;
  duration_ms?: number;
  total_tokens?: number;
  num_turns?: number;
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  cli?: CLI;
  retry_attempt?: number;
  retry_of?: string | null;
  retry_scheduled_at?: string;
  retry_after_seconds?: number;
};

export type TokenUsageSummary = {
  name: string;
  started_at: string;
  total_tokens?: number;
};

export type SessionTokenSummary = TokenUsageSummary & {
  session_id: string;
  finished_at?: string;
  status: SessionMeta["status"];
};

export type RunTokenSummary = TokenUsageSummary & {
  slug: string;
  status: RunMeta["status"];
};

function isENOENT(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

const RECENT_SESSION_EVENT_TURNS = 4;
const RECENT_SESSION_EVENT_MAX_BYTES = 2 * 1024 * 1024;
const SESSION_STREAM_TAIL_CHUNK_BYTES = 256 * 1024;
const TURN_START_MARKER = "saturn.turn_start";
const TURN_END_MARKERS = [
  "\"type\":\"turn.completed\"",
  "\"type\": \"turn.completed\"",
  "\"type\":\"result\"",
  "\"type\": \"result\"",
  "\"type\":\"step_finish\"",
  "\"type\": \"step_finish\"",
  "\"type\":\"turn.failed\"",
  "\"type\": \"turn.failed\"",
  "\"type\":\"saturn.turn_aborted\"",
  "\"type\": \"saturn.turn_aborted\"",
];
const COMPACT_EVENT_VALUE_CHARS = 1200;
const COMPACT_EVENT_ARRAY_ITEMS = 10;
const COMPACT_EVENT_OBJECT_KEYS = 18;
const COMPACT_SESSION_META_CHARS = 600;
const COMPACT_SESSION_RECENT_FINAL_CHARS = 1200;

type SessionStreamRead = {
  raw: string;
  partial: boolean;
  visiblePartial: boolean;
};

async function readStreamFile(streamFile: string): Promise<string> {
  return fs.readFile(streamFile, "utf8").catch(() => "");
}

function stripPartialFirstLine(raw: string, startsAtBeginning: boolean): string {
  if (startsAtBeginning) return raw;
  const firstNewline = raw.indexOf("\n");
  return firstNewline === -1 ? "" : raw.slice(firstNewline + 1);
}

function countTurnStartMarkers(raw: string): number {
  let count = 0;
  let idx = raw.indexOf(TURN_START_MARKER);
  while (idx !== -1) {
    count += 1;
    idx = raw.indexOf(TURN_START_MARKER, idx + TURN_START_MARKER.length);
  }
  return count;
}

function isTurnEndLine(line: string): boolean {
  return TURN_END_MARKERS.some((marker) => line.includes(marker));
}

function countTurnEndMarkers(raw: string): number {
  let count = 0;
  for (const line of raw.split("\n")) {
    if (isTurnEndLine(line)) count += 1;
  }
  return count;
}

function trimToRecentTurns(raw: string, recentTurns: number): { raw: string; trimmed: boolean } {
  const lines = raw.split("\n");
  const turnStartLines: number[] = [];
  lines.forEach((line, idx) => {
    if (line.includes(TURN_START_MARKER)) turnStartLines.push(idx);
  });

  if (turnStartLines.length <= recentTurns) {
    return { raw, trimmed: false };
  }

  const startLine = turnStartLines[turnStartLines.length - recentTurns];
  return { raw: lines.slice(startLine).join("\n"), trimmed: true };
}

function trimToRecentTurnEnds(
  raw: string,
  recentTurns: number,
  hasTrailingTurn: boolean,
): { raw: string; trimmed: boolean; markerCount: number } {
  const lines = raw.split("\n");
  const turnEndLines: number[] = [];
  lines.forEach((line, idx) => {
    if (isTurnEndLine(line)) turnEndLines.push(idx);
  });

  const completedTurnsToKeep = Math.max(0, hasTrailingTurn ? recentTurns - 1 : recentTurns);
  const boundaryIdx = turnEndLines.length - completedTurnsToKeep - 1;
  if (boundaryIdx < 0) {
    return { raw, trimmed: false, markerCount: turnEndLines.length };
  }

  return {
    raw: lines.slice(turnEndLines[boundaryIdx] + 1).join("\n"),
    trimmed: true,
    markerCount: turnEndLines.length,
  };
}

async function readRecentSessionStream(
  streamFile: string,
  recentTurns: number,
  maxBytes: number,
  hasTrailingTurn: boolean,
): Promise<SessionStreamRead> {
  let handle: FileHandle;
  try {
    handle = await fs.open(streamFile, "r");
  } catch (err) {
    if (isENOENT(err)) return { raw: "", partial: false, visiblePartial: false };
    throw err;
  }

  try {
    const stat = await handle.stat();
    if (stat.size === 0) return { raw: "", partial: false, visiblePartial: false };

    let offset = stat.size;
    let loadedBytes = 0;
    const buffers: Buffer[] = [];
    let candidate = "";
    let candidateStart = stat.size;
    const requiredEndMarkers = Math.max(1, hasTrailingTurn ? recentTurns : recentTurns + 1);

    while (offset > 0 && loadedBytes < maxBytes) {
      const length = Math.min(
        SESSION_STREAM_TAIL_CHUNK_BYTES,
        offset,
        maxBytes - loadedBytes,
      );
      offset -= length;
      const buffer = Buffer.allocUnsafe(length);
      const result = await handle.read(buffer, 0, length, offset);
      buffers.unshift(result.bytesRead === length ? buffer : buffer.subarray(0, result.bytesRead));
      loadedBytes += result.bytesRead;
      candidateStart = offset;

      const raw = Buffer.concat(buffers).toString("utf8");
      candidate = stripPartialFirstLine(raw, candidateStart === 0);
      if (countTurnStartMarkers(candidate) >= recentTurns) break;
      if (countTurnEndMarkers(candidate) >= requiredEndMarkers) break;
    }

    const turnStartCount = countTurnStartMarkers(candidate);
    if (turnStartCount > 0) {
      const trimmed = trimToRecentTurns(candidate, recentTurns);
      return {
        raw: trimmed.raw,
        partial: candidateStart > 0 || trimmed.trimmed,
        visiblePartial: candidateStart > 0 && turnStartCount < recentTurns,
      };
    }

    const trimmed = trimToRecentTurnEnds(candidate, recentTurns, hasTrailingTurn);
    return {
      raw: trimmed.raw,
      partial: candidateStart > 0 || trimmed.trimmed || trimmed.markerCount > recentTurns,
      visiblePartial: candidateStart > 0 && trimmed.markerCount < requiredEndMarkers,
    };
  } finally {
    await handle.close();
  }
}

async function readSessionStream(
  streamFile: string,
  options: SessionReadOptions,
  hasTrailingTurn: boolean,
): Promise<SessionStreamRead> {
  if (options.eventMode !== "recent") {
    return { raw: await readStreamFile(streamFile), partial: false, visiblePartial: false };
  }

  return readRecentSessionStream(
    streamFile,
    Math.max(1, options.recentTurns ?? RECENT_SESSION_EVENT_TURNS),
    Math.max(SESSION_STREAM_TAIL_CHUNK_BYTES, options.recentMaxBytes ?? RECENT_SESSION_EVENT_MAX_BYTES),
    hasTrailingTurn,
  );
}

function compactString(value: string, maxChars: number): string {
  if (/^data:(image|video|audio)\//i.test(value)) {
    return `[media data omitted from initial load: ${value.length.toLocaleString()} chars]`;
  }
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n...[${(value.length - maxChars).toLocaleString()} chars omitted from initial load]`;
}

function compactOptionalString(
  value: string | null | undefined,
  maxChars: number,
): { value: string | undefined; changed: boolean } {
  if (value === undefined) return { value, changed: false };
  if (value === null) return { value: undefined, changed: true };
  if (maxChars === Number.POSITIVE_INFINITY) return { value, changed: false };
  if (maxChars <= 0) return { value: "", changed: value.length > 0 };
  const compacted = compactString(value, maxChars);
  return { value: compacted, changed: compacted !== value };
}

function firstUserMessageTurnIndex(turns: TurnRecord[]): number {
  return turns.findIndex((turn) => Boolean(turn.user_message?.trim()));
}

function compactSessionMetaForList(
  meta: SessionMeta,
  maxChars: number,
): { meta: SessionMeta; partial: boolean } {
  const turns = meta.turns ?? [];
  const firstUserIdx = firstUserMessageTurnIndex(turns);
  const lastIdx = turns.length - 1;
  let partial = false;

  const compactTurns = turns.map((turn, idx): TurnRecord => {
    const keepUserPreview = idx === firstUserIdx || idx === lastIdx;
    const keepFinalPreview = idx === lastIdx;
    const next: TurnRecord = { ...turn };

    const user = compactOptionalString(next.user_message, keepUserPreview ? maxChars : 0);
    next.user_message = user.value ?? "";
    partial ||= user.changed;

    const finalText = compactOptionalString(next.final_text, keepFinalPreview ? maxChars : 0);
    if (finalText.value === undefined) delete next.final_text;
    else next.final_text = finalText.value;
    partial ||= finalText.changed;

    return next;
  });

  return { meta: { ...meta, turns: compactTurns }, partial };
}

function compactSessionMetaForRecentRead(
  meta: SessionMeta,
  recentTurns: number,
  maxChars: number,
): { meta: SessionMeta; partial: boolean } {
  const turns = meta.turns ?? [];
  const firstUserIdx = firstUserMessageTurnIndex(turns);
  const recentStart = Math.max(0, turns.length - Math.max(1, recentTurns));
  let partial = false;

  const compactTurns = turns.map((turn, idx): TurnRecord => {
    const next: TurnRecord = { ...turn };
    const keepFullUser = idx >= recentStart;
    const keepTitleUser = idx === firstUserIdx;

    const user = compactOptionalString(
      next.user_message,
      keepFullUser ? Number.POSITIVE_INFINITY : keepTitleUser ? maxChars : 0,
    );
    next.user_message = user.value ?? "";
    partial ||= user.changed;

    const finalText = compactOptionalString(
      next.final_text,
      idx >= recentStart ? COMPACT_SESSION_RECENT_FINAL_CHARS : 0,
    );
    if (finalText.value === undefined) delete next.final_text;
    else next.final_text = finalText.value;
    partial ||= finalText.changed;

    return next;
  });

  return { meta: { ...meta, turns: compactTurns }, partial };
}

function compactEventValue(value: unknown, maxChars: number, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return compactString(value, maxChars);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= 3) {
    if (Array.isArray(value)) return `[${value.length.toLocaleString()} items omitted from initial load]`;
    if (typeof value === "object") {
      return `{${Object.keys(value as Record<string, unknown>).length.toLocaleString()} keys omitted from initial load}`;
    }
    return String(value);
  }
  if (Array.isArray(value)) {
    const head = value
      .slice(0, COMPACT_EVENT_ARRAY_ITEMS)
      .map((item) => compactEventValue(item, Math.max(160, Math.floor(maxChars / 2)), depth + 1));
    if (value.length > COMPACT_EVENT_ARRAY_ITEMS) {
      head.push(`[${(value.length - COMPACT_EVENT_ARRAY_ITEMS).toLocaleString()} items omitted from initial load]`);
    }
    return head;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const record = value as Record<string, unknown>;
    const mimeType = typeof record.mimeType === "string"
      ? record.mimeType
      : typeof record.media_type === "string"
        ? record.media_type
        : undefined;
    if (typeof record.data === "string" && mimeType && /^(image|video|audio)\//i.test(mimeType)) {
      const out: Record<string, unknown> = {};
      for (const [key, entryValue] of entries) {
        if (key === "data") continue;
        out[key] = compactEventValue(entryValue, Math.max(160, Math.floor(maxChars / 2)), depth + 1);
      }
      out.data_omitted_chars = record.data.length;
      return out;
    }

    const out: Record<string, unknown> = {};
    for (const [key, entryValue] of entries.slice(0, COMPACT_EVENT_OBJECT_KEYS)) {
      out[key] = compactEventValue(entryValue, Math.max(160, Math.floor(maxChars / 2)), depth + 1);
    }
    if (entries.length > COMPACT_EVENT_OBJECT_KEYS) {
      out.__omittedKeys = entries.length - COMPACT_EVENT_OBJECT_KEYS;
    }
    return out;
  }
  return String(value);
}

function compactRawForEvent(raw: unknown): Record<string, unknown> {
  const src = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const out: Record<string, unknown> = {};
  for (const key of [
    "type",
    "subtype",
    "session_id",
    "thread_id",
    "turn_id",
    "uuid",
    "started_at",
    "cli",
    "model",
    "parent_tool_use_id",
  ]) {
    if (src[key] !== undefined) out[key] = src[key];
  }

  const item = src.item && typeof src.item === "object" ? src.item as Record<string, unknown> : null;
  if (item?.id || item?.type || item?.status || item?.server || item?.name) {
    out.item = {
      ...(typeof item.id === "string" ? { id: item.id } : {}),
      ...(typeof item.type === "string" ? { type: item.type } : {}),
      ...(typeof item.status === "string" ? { status: item.status } : {}),
      ...(typeof item.server === "string" ? { server: item.server } : {}),
      ...(typeof item.name === "string" ? { name: item.name } : {}),
    };
  }
  return out;
}

function compactStreamEvents(events: StreamEvent[], maxChars: number): StreamEvent[] {
  return events.map((event): StreamEvent => {
    const raw = compactRawForEvent(event.raw);
    switch (event.kind) {
      case "assistant_text":
        return { ...event, raw };
      case "plan_text":
        return { ...event, raw };
      case "thinking":
        return { ...event, text: compactString(event.text, maxChars), raw };
      case "tool_use":
        return { ...event, input: compactEventValue(event.input, maxChars), raw };
      case "tool_result":
        return { ...event, content: compactEventValue(event.content, maxChars), raw };
      case "todo_list":
      case "result":
      case "system":
      case "user":
      case "other":
        return { ...event, raw } as StreamEvent;
      default:
        return event;
    }
  });
}

async function readJobsFile(): Promise<{ jobs: Job[] }> {
  try {
    const raw = await fs.readFile(jobsFile(), "utf8");
    const parsed = JSON.parse(raw) as { jobs?: Job[] };
    return { jobs: parsed.jobs ?? [] };
  } catch (err: unknown) {
    if (isENOENT(err)) return { jobs: [] };
    throw err;
  }
}

async function writeJobsFile(data: { jobs: Job[] }): Promise<void> {
  await fs.mkdir(path.dirname(jobsFile()), { recursive: true });
  const body = {
    $comment: "Saved jobs - managed by the dashboard and bin/register-job.sh.",
    jobs: data.jobs,
  };
  await fs.writeFile(jobsFile(), JSON.stringify(body, null, 2), "utf8");
}

export async function listJobs(): Promise<Job[]> {
  const { jobs } = await readJobsFile();
  return jobs.map((job) => ({ ...job, cli: normalizeCli(job.cli) }));
}

export async function getJob(name: string): Promise<Job | undefined> {
  const jobs = await listJobs();
  return jobs.find((j) => j.name === name);
}

export async function createJob(job: Job): Promise<Job> {
  const parsed = await readJobsFile();
  if (parsed.jobs.some((j) => j.name === job.name)) {
    throw new Error(`Job already exists: ${job.name}`);
  }
  const full: Job = { ...job, cli: normalizeCli(job.cli) };
  parsed.jobs.push(full);
  await writeJobsFile(parsed);
  return full;
}

export async function updateJob(
  name: string,
  patch: JobUpdatePatch,
): Promise<Job> {
  const parsed = await readJobsFile();
  const idx = parsed.jobs.findIndex((j) => j.name === name);
  if (idx < 0) throw new Error(`Job not found: ${name}`);

  const job = { ...parsed.jobs[idx] };
  if (patch.cron !== undefined) job.cron = patch.cron;
  if (patch.prompt !== undefined) job.prompt = patch.prompt;
  if (patch.description !== undefined) {
    if (patch.description === null || patch.description === "") delete job.description;
    else job.description = patch.description;
  }
  if (patch.cwd !== undefined) {
    if (patch.cwd === null || patch.cwd === "") delete job.cwd;
    else job.cwd = patch.cwd;
  }
  if (patch.allowedTools !== undefined) {
    if (patch.allowedTools === null) delete job.allowedTools;
    else job.allowedTools = patch.allowedTools;
  }
  if (patch.model !== undefined) {
    if (patch.model === null || patch.model === "") delete job.model;
    else job.model = patch.model;
  }
  if (patch.cli !== undefined) {
    if (patch.cli === null) delete job.cli;
    else job.cli = normalizeCli(patch.cli);
  }
  if (patch.reasoningEffort !== undefined) {
    if (patch.reasoningEffort === null) delete job.reasoningEffort;
    else job.reasoningEffort = patch.reasoningEffort;
  }
  if (patch.timeout_seconds !== undefined) {
    if (patch.timeout_seconds === null) delete job.timeout_seconds;
    else job.timeout_seconds = patch.timeout_seconds;
  }
  if (patch.catchUpMissedRuns !== undefined) {
    if (patch.catchUpMissedRuns) job.catchUpMissedRuns = true;
    else delete job.catchUpMissedRuns;
  }

  parsed.jobs[idx] = job;
  await writeJobsFile(parsed);
  return { ...job, cli: normalizeCli(job.cli) };
}

export async function deleteJob(name: string): Promise<Job> {
  const parsed = await readJobsFile();
  const idx = parsed.jobs.findIndex((j) => j.name === name);
  if (idx < 0) throw new Error(`Job not found: ${name}`);

  const [deleted] = parsed.jobs.splice(idx, 1);
  await writeJobsFile(parsed);
  return { ...deleted, cli: normalizeCli(deleted.cli) };
}

async function listSubdirs(p: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(p, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err: unknown) {
    if (isENOENT(err)) return [];
    throw err;
  }
}

async function readRunMeta(jobPath: string, ts: string): Promise<RunMeta | null> {
  try {
    const raw = await fs.readFile(path.join(jobPath, ts, "meta.json"), "utf8");
    const meta = JSON.parse(raw) as RunMeta;
    if (!meta.slug) meta.slug = ts;
    meta.cli = normalizeCli(meta.cli);
    return meta;
  } catch {
    return null; // skip corrupt / in-progress runs
  }
}

export async function listRuns(jobName?: string): Promise<RunMeta[]> {
  const root = runsRoot();
  const jobDirs = jobName ? [jobName] : await listSubdirs(root);

  const perJob = await Promise.all(
    jobDirs.map(async (job) => {
      const jobPath = path.join(root, job);
      const entries = await listSubdirs(jobPath);
      return Promise.all(entries.map((ts) => readRunMeta(jobPath, ts)));
    }),
  );

  const results = perJob.flat().filter((m): m is RunMeta => m !== null);
  results.sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  return results;
}

export async function listRunTokenSummaries(jobName?: string): Promise<RunTokenSummary[]> {
  const [runs, jobs] = await Promise.all([listRuns(jobName), listJobs().catch(() => [])]);
  const jobsByName = new Map(jobs.map((job) => [job.name, job]));

  const summaries = await Promise.all(
    runs.map(async (meta) => {
      const streamRaw = await fs
        .readFile(path.join(runsRoot(), meta.name, meta.slug, "stream.jsonl"), "utf8")
        .catch(() => "");
      const streamTokens = sumResultTokens(parseStreamJsonl(streamRaw));
      let totalTokens = streamTokens > 0 ? streamTokens : meta.total_tokens;

      if (!totalTokens) {
        const finalMarkdown = await readFinalMarkdown(meta.name, meta.slug);
        const count = await countTextTokensForCli({
          cli: meta.cli,
          model: meta.model,
          text: [jobsByName.get(meta.name)?.prompt, finalMarkdown].filter(Boolean).join("\n\n"),
        });
        totalTokens = count?.total_tokens;
      }

      return {
        name: meta.name,
        slug: meta.slug,
        started_at: meta.started_at,
        status: meta.status,
        total_tokens: totalTokens,
      };
    }),
  );

  return summaries.filter((s) => (s.total_tokens ?? 0) > 0);
}

export async function readFinalMarkdown(name: string, slug: string): Promise<string> {
  return fs.readFile(path.join(runsRoot(), name, slug, "final.md"), "utf8").catch(() => "");
}

export async function getRun(
  name: string,
  ts: string
): Promise<{ meta: RunMeta; events: StreamEvent[]; finalMarkdown: string; stderr: string } | null> {
  const dir = path.join(runsRoot(), name, ts);
  const metaRaw = await fs.readFile(path.join(dir, "meta.json"), "utf8").catch(() => null);
  if (metaRaw === null) return null;
  const meta = JSON.parse(metaRaw) as RunMeta;
  if (!meta.slug) meta.slug = ts;
  meta.cli = normalizeCli(meta.cli);

  const [streamRaw, finalMarkdown, stderr] = await Promise.all([
    fs.readFile(path.join(dir, "stream.jsonl"), "utf8").catch(() => ""),
    fs.readFile(path.join(dir, "final.md"), "utf8").catch(() => ""),
    fs.readFile(path.join(dir, "stderr.log"), "utf8").catch(() => ""),
  ]);

  return { meta, events: parseStreamJsonl(streamRaw), finalMarkdown, stderr };
}

export async function updateJobSettings(
  name: string,
  settings: {
    model?: string | null;
    cli?: CLI;
    reasoningEffort?: ModelReasoningEffort | null;
    cron?: string;
    catchUpMissedRuns?: boolean;
  },
): Promise<void> {
  await updateJob(name, settings);
}

// Keep backwards compat
export async function updateJobModel(name: string, model: string): Promise<void> {
  return updateJobSettings(name, { model });
}

// ─── Agents ────────────────────────────────────────────────────────────────

async function readAgentsFile(): Promise<{ agents: Agent[] }> {
  try {
    const raw = await fs.readFile(agentsFile(), "utf8");
    const parsed = JSON.parse(raw);
    return { agents: parsed.agents ?? [] };
  } catch (err: unknown) {
    if (isENOENT(err)) return { agents: [] };
    throw err;
  }
}

async function writeAgentsFile(data: { agents: Agent[] }): Promise<void> {
  const body = { $comment: "Saved agents — managed by the dashboard.", agents: data.agents };
  await fs.writeFile(agentsFile(), JSON.stringify(body, null, 2), "utf8");
}

export async function listAgents(): Promise<Agent[]> {
  const { agents } = await readAgentsFile();
  agents.forEach(normalizeAgentCliFields);
  return agents;
}

export async function getAgent(id: string): Promise<Agent | undefined> {
  const agents = await listAgents();
  return agents.find((a) => a.id === id);
}

export async function createAgent(agent: Omit<Agent, "created_at"> & { created_at?: string }): Promise<Agent> {
  const data = await readAgentsFile();
  if (data.agents.find((a) => a.id === agent.id)) {
    throw new Error(`Agent already exists: ${agent.id}`);
  }
  const now = new Date().toISOString();
  const full: Agent = { created_at: now, ...agent, updated_at: now };
  normalizeAgentCliFields(full);
  data.agents.push(full);
  await writeAgentsFile(data);
  return full;
}

export async function updateAgent(id: string, patch: Partial<Omit<Agent, "id" | "created_at">>): Promise<Agent> {
  const data = await readAgentsFile();
  const idx = data.agents.findIndex((a) => a.id === id);
  if (idx < 0) throw new Error(`Agent not found: ${id}`);
  data.agents[idx] = { ...data.agents[idx], ...patch, updated_at: new Date().toISOString() };
  normalizeAgentCliFields(data.agents[idx]);
  await writeAgentsFile(data);
  return data.agents[idx];
}

export async function deleteAgent(id: string): Promise<void> {
  const data = await readAgentsFile();
  const filtered = data.agents.filter((a) => a.id !== id);
  if (filtered.length === data.agents.length) throw new Error(`Agent not found: ${id}`);
  await writeAgentsFile({ agents: filtered });
}

// ─── Sessions ──────────────────────────────────────────────────────────────

export function sessionDir(sessionId: string): string {
  return path.join(sessionsRoot(), sessionId);
}

export async function getSessionMeta(sessionId: string): Promise<SessionMeta | null> {
  const raw = await fs.readFile(path.join(sessionDir(sessionId), "meta.json"), "utf8").catch(() => null);
  if (raw === null || !raw.trim()) return null;
  try {
    const meta = JSON.parse(raw) as SessionMeta;
    normalizeSessionMeta(meta);
    return await reconcileStaleRunningSession(meta);
  } catch {
    return null;
  }
}

export async function listSessions(options: SessionListOptions = {}): Promise<SessionMeta[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(sessionsRoot(), { withFileTypes: true });
  } catch (err: unknown) {
    if (isENOENT(err)) return [];
    throw err;
  }

  const metas = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map((e) =>
        fs
          .readFile(path.join(sessionsRoot(), e.name, "meta.json"), "utf8")
          .then((raw) => JSON.parse(raw) as SessionMeta)
          .catch(() => null),
      ),
  );

  const out = await Promise.all(metas.filter((m): m is SessionMeta => m !== null).map(reconcileStaleRunningSession));
  for (const meta of out) normalizeSessionMeta(meta);
  out.sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  if (!options.compactMeta) return out;
  return out.map((meta) =>
    compactSessionMetaForList(
      meta,
      options.compactMetaChars ?? COMPACT_SESSION_META_CHARS,
    ).meta
  );
}

function sumResultTokens(events: StreamEvent[]): number {
  return events.reduce((total, ev) => total + (ev.kind === "result" ? ev.totalTokens : 0), 0);
}

async function countSessionVisibleTokens(meta: SessionMeta): Promise<number> {
  const counts = await Promise.all(
    meta.turns.map(async (turn) => {
      const count = await countTextTokensForCli({
        cli: turn.cli,
        model: turn.model,
        text: [turn.user_message, turn.final_text].filter(Boolean).join("\n\n"),
      });
      return count?.total_tokens ?? 0;
    }),
  );

  return counts.reduce((total, n) => total + n, 0);
}

export async function listSessionTokenSummaries(): Promise<SessionTokenSummary[]> {
  const sessions = await listSessions();

  const summaries = await Promise.all(
    sessions.map(async (meta) => {
      const streamRaw = await fs
        .readFile(path.join(sessionDir(meta.session_id), "stream.jsonl"), "utf8")
        .catch(() => "");
      const streamTokens = sumResultTokens(parseStreamJsonl(streamRaw));
      const countedTokens = streamTokens > 0 ? 0 : await countSessionVisibleTokens(meta);
      const total_tokens = streamTokens > 0 ? streamTokens : countedTokens;

      return {
        session_id: meta.session_id,
        name: "Chats",
        started_at: meta.started_at,
        finished_at: meta.finished_at,
        status: meta.status,
        total_tokens,
      };
    }),
  );

  return summaries.filter((s) => (s.total_tokens ?? 0) > 0);
}

export async function getSession(
  sessionId: string,
  options: SessionReadOptions = {},
): Promise<{ meta: SessionMeta; events: StreamEvent[]; stderr: string; eventsPartial: boolean; visibleEventsPartial: boolean } | null> {
  const dir = sessionDir(sessionId);
  const meta = await getSessionMeta(sessionId);
  if (!meta) return null;

  const [stream, stderr] = await Promise.all([
    readSessionStream(path.join(dir, "stream.jsonl"), options, meta.status === "running"),
    fs.readFile(path.join(dir, "stderr.log"), "utf8").catch(() => ""),
  ]);

  const parsedEvents = parseStreamJsonl(stream.raw);
  const shouldCompactEvents = Boolean(options.compactEvents && meta.status !== "running");
  const events = shouldCompactEvents
    ? compactStreamEvents(parsedEvents, options.compactValueChars ?? COMPACT_EVENT_VALUE_CHARS)
    : parsedEvents;
  const shouldCompactMeta = Boolean(options.compactMeta ?? options.eventMode === "recent");
  const compactedMeta = shouldCompactMeta
    ? compactSessionMetaForRecentRead(
      meta,
      options.recentTurns ?? RECENT_SESSION_EVENT_TURNS,
      options.compactMetaChars ?? COMPACT_SESSION_META_CHARS,
    )
    : { meta, partial: false };

  return {
    meta: compactedMeta.meta,
    events,
    stderr,
    eventsPartial: stream.partial,
    visibleEventsPartial: stream.visiblePartial,
  };
}

function normalizeAgentCliFields(agent: Agent | undefined): void {
  if (!agent) return;
  agent.cli = normalizeCli(agent.cli);
  agent.defaultCli = normalizeCli(agent.defaultCli ?? agent.cli);
  agent.supportedClis = (agent.supportedClis?.length ? agent.supportedClis : [agent.cli ?? DEFAULT_CLI])
    .map((cli) => normalizeCli(cli));
  if (agent.models) {
    const next: Partial<Record<CLI, string>> = {};
    for (const [cli, model] of Object.entries(agent.models)) {
      if (model) next[normalizeCli(cli)] = model;
    }
    agent.models = next;
  }
  if (agent.reasoningEfforts) {
    const next: Partial<Record<CLI, ModelReasoningEffort>> = {};
    for (const [cli, effort] of Object.entries(agent.reasoningEfforts)) {
      if (effort) next[normalizeCli(cli)] = effort;
    }
    agent.reasoningEfforts = next;
  }
}

function normalizeSessionMeta(meta: SessionMeta): void {
  normalizeAgentCliFields(meta.agent_snapshot);
  for (const turn of meta.turns ?? []) {
    turn.cli = normalizeCli(turn.cli);
  }
}

export { isMultiCli, getCliList } from "./session-utils";

function sanitizeTriagePatch(patch: unknown): SessionTriagePatch {
  if (!patch || typeof patch !== "object") return {};
  const src = patch as Record<string, unknown>;
  const out: SessionTriagePatch = {};

  if (Array.isArray(src.tags)) {
    out.tags = src.tags
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter(Boolean);
  }
  if (typeof src.pinned === "boolean") out.pinned = src.pinned;
  if (typeof src.archived === "boolean") out.archived = src.archived;
  if ("snoozed_until" in src) {
    if (src.snoozed_until === null) out.snoozed_until = null;
    else if (typeof src.snoozed_until === "string") out.snoozed_until = src.snoozed_until;
  }
  if (typeof src.read_at === "string") out.read_at = src.read_at;

  return out;
}

export async function updateSessionMeta(
  sessionId: string,
  patch: SessionTriagePatch
): Promise<SessionMeta> {
  const safe = sanitizeTriagePatch(patch);
  return withSessionMetaLock(sessionId, async () => {
    const metaPath = path.join(sessionDir(sessionId), "meta.json");
    const raw = await fs.readFile(metaPath, "utf8");
    const meta = JSON.parse(raw) as SessionMeta;
    const next: SessionMeta = { ...meta, ...safe };
    // Explicit null clears snoozed_until; drop the property entirely to keep meta tidy.
    if (safe.snoozed_until === null) delete next.snoozed_until;
    await fs.writeFile(metaPath, JSON.stringify(next, null, 2), "utf8");
    return next;
  });
}

export async function triggerJob(name: string, _model?: string): Promise<string> {
  const { spawn } = await import("child_process");
  const scriptPath = path.join(path.dirname(runsRoot()), "bin", "run-job.sh");

  // cli-dispatch.sh (called by run-job.sh) handles Bedrock alias expansion and
  // CLAUDE_CODE_USE_BEDROCK injection internally via to_bedrock_id(). No need
  // to touch jobs.json here — doing so would corrupt the UI with Bedrock IDs.
  const proc = spawn(scriptPath, [name], { detached: true, stdio: "ignore" });
  proc.unref();

  return new Date().toISOString().slice(0, 19).replace(/:/g, "-");
}
