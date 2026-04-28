import { promises as fs } from "node:fs";
import path from "node:path";
import { jobsFile, runsRoot, agentsFile, sessionsRoot } from "./paths";
import { parseStreamJsonl, type StreamEvent } from "./events";
import type { ModelReasoningEffort } from "./models";
import { countTextTokensForCli } from "./token-counters";
import { DEFAULT_CLI, normalizeCli } from "./clis";
import type { CLI } from "./clis";
export type { StreamEvent, TokenBreakdown, ToolCallSummary } from "./events";
export { toEvents, getTokenBreakdown, getToolCallSummary } from "./events";
export type { CLI } from "./clis";

export type AgentKind = "chat" | "orchestrator";
export type MutationTier = "read-only" | "writes-scratch" | "writes-source";

export type OrchestratorBudget = {
  max_total_tokens?: number;
  max_wallclock_seconds?: number;
  max_slice_calls?: number;
  max_recursion_depth?: number;
};

export type OnBudgetExceeded = "report-partial" | "stop-hard";
export type OnSliceFailure = "retry-once" | "continue" | "abort";

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
  timeout_seconds?: number;
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
};

// Re-export agent helpers from session-utils (client-safe, no Node built-ins)
export { agentDefaultCli, agentSupportedClis, agentModelForCli } from "./session-utils";

export type TurnRecord = {
  turn_id?: string;       // dashboard-owned id; stable even if the CLI reuses native sessions
  cli: CLI;
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  cli_session_id?: string;   // underlying CLI's own session id, for native resume
  started_at: string;
  finished_at?: string;
  status?: "running" | "success" | "failed" | "aborted";
  user_message: string;
  final_text?: string;
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

export async function listJobs(): Promise<Job[]> {
  const raw = await fs.readFile(jobsFile(), "utf8");
  const parsed = JSON.parse(raw) as { jobs: Job[] };
  return (parsed.jobs ?? []).map((job) => ({ ...job, cli: normalizeCli(job.cli) }));
}

export async function getJob(name: string): Promise<Job | undefined> {
  const jobs = await listJobs();
  return jobs.find((j) => j.name === name);
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
  settings: { model?: string | null; cli?: CLI; reasoningEffort?: ModelReasoningEffort | null },
): Promise<void> {
  const raw = await fs.readFile(jobsFile(), "utf8");
  const parsed = JSON.parse(raw) as { jobs: Job[] };
  const job = parsed.jobs.find((j) => j.name === name);
  if (!job) throw new Error(`Job not found: ${name}`);
  if (settings.model !== undefined) {
    if (settings.model === null) delete job.model;
    else job.model = settings.model;
  }
  if (settings.cli !== undefined) job.cli = normalizeCli(settings.cli);
  if (settings.reasoningEffort !== undefined) {
    if (settings.reasoningEffort === null) delete job.reasoningEffort;
    else job.reasoningEffort = settings.reasoningEffort;
  }
  await fs.writeFile(jobsFile(), JSON.stringify(parsed, null, 2), "utf8");
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

export async function listSessions(): Promise<SessionMeta[]> {
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

  const out = metas.filter((m): m is SessionMeta => m !== null);
  for (const meta of out) normalizeSessionMeta(meta);
  out.sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  return out;
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
  sessionId: string
): Promise<{ meta: SessionMeta; events: StreamEvent[]; stderr: string } | null> {
  const dir = sessionDir(sessionId);
  const metaRaw = await fs.readFile(path.join(dir, "meta.json"), "utf8").catch(() => null);
  if (metaRaw === null || !metaRaw.trim()) return null;
  let meta: SessionMeta;
  try {
    meta = JSON.parse(metaRaw) as SessionMeta;
  } catch {
    return null;
  }
  normalizeSessionMeta(meta);

  const [streamRaw, stderr] = await Promise.all([
    fs.readFile(path.join(dir, "stream.jsonl"), "utf8").catch(() => ""),
    fs.readFile(path.join(dir, "stderr.log"), "utf8").catch(() => ""),
  ]);

  return { meta, events: parseStreamJsonl(streamRaw), stderr };
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
  const metaPath = path.join(sessionDir(sessionId), "meta.json");
  const raw = await fs.readFile(metaPath, "utf8");
  const meta = JSON.parse(raw) as SessionMeta;
  const next: SessionMeta = { ...meta, ...safe };
  // Explicit null clears snoozed_until; drop the property entirely to keep meta tidy.
  if (safe.snoozed_until === null) delete next.snoozed_until;
  await fs.writeFile(metaPath, JSON.stringify(next, null, 2), "utf8");
  return next;
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
