// Slice execution runtime.
//
// Called by the MCP `dispatch_slice` / `dispatch_custom_slice` tools (step 4)
// and the slice tester endpoint (step 9). Renders the slice prompt, sets up
// the sandbox, spawns bin/run-slice.sh, parses output against the slice's
// io_schema, updates the per-session budget, and appends to slices/index.jsonl.

import { promises as fs } from "node:fs";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import path from "node:path";

const execFileAsync = promisify(execFile);

import { binDir, sessionsRoot } from "./paths";
import { getSlice, type Slice, type SliceSandbox, type SliceSandboxMode } from "./slices";
import { sliceInputsValid } from "./session-utils";
import { updateBudget } from "./budget";
import { getTokenBreakdown, parseStreamJsonl } from "./events";
import type { CLI } from "./runs";

// ─── Public types ────────────────────────────────────────────────────────────

export type SliceExecuteInput = {
  sessionId: string;
  sliceId: string;
  inputs: Record<string, unknown>;
  executionContext?: SliceExecutionContext;
  /** Optional overrides from orchestrator (e.g., timeout cap from remaining budget). */
  budgetOverride?: { timeout_seconds?: number; max_tokens?: number };
  /** cwd override — typically the orchestrator session's cwd. */
  cwdOverride?: string;
};

export type SliceExecuteTokens = { input: number; output: number; total: number };

export type SliceExecuteStatus =
  | "success"
  | "failed"
  | "output_validation_error"
  | "budget_exceeded"
  | "timeout";

export type SliceExecuteResult = {
  slice_run_id: string;
  status: SliceExecuteStatus;
  output: unknown | null;
  raw_output: string;
  tokens: SliceExecuteTokens;
  duration_ms: number;
  error?: string;
  sandbox_path?: string;
};

export type CustomSliceSpec = {
  cli: CLI;
  model?: string;
  allowedTools?: string[];
  /** Pre-rendered prompt — no templating is performed on this. */
  prompt: string;
  sandbox?: SliceSandbox;
  budget?: { max_tokens?: number; timeout_seconds?: number };
};

export type CustomSliceExecuteInput = {
  sessionId: string;
  spec: CustomSliceSpec;
  /** Only used for logging / the index entry. */
  inputs?: Record<string, unknown>;
  executionContext?: SliceExecutionContext;
  cwdOverride?: string;
};

export type SliceExecutionContext = {
  graph_run_id?: string;
  graph_node_id?: string;
  label?: string;
  execution_order?: number;
  upstream_node_ids?: string[];
  downstream_node_ids?: string[];
};

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Renders `{{name}}` placeholders from a slice prompt template. Objects/arrays
 * are JSON.stringify'd; missing vars render as empty string. Nothing fancier —
 * anything more is the orchestrator's responsibility.
 */
export function renderTemplate(
  template: string,
  vars: Record<string, unknown>
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_\-.]+)\s*\}\}/g, (_, name: string) => {
    const v = vars[name];
    if (v === undefined || v === null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  });
}

type SchemaValidation = { ok: true } | { ok: false; errors: string[] };

/**
 * Tiny recursive JSON-schema walker — handles the subset we use in slice
 * definitions: type (object/array/string/number/boolean), properties, required,
 * items, enum. Unknown keywords are ignored lenient-style.
 */
export function validateJsonSchema(value: unknown, schema: unknown): SchemaValidation {
  const errors: string[] = [];
  walk(value, schema as Record<string, unknown>, "$", errors);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function walk(
  value: unknown,
  schema: Record<string, unknown> | undefined,
  pathStr: string,
  errors: string[]
): void {
  if (!schema || typeof schema !== "object") return;

  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value as never)) {
      errors.push(`${pathStr}: value not in enum`);
    }
  }

  const type = schema.type as string | undefined;
  if (type) {
    let actual: string;
    if (Array.isArray(value)) actual = "array";
    else if (value === null) actual = "null";
    else actual = typeof value;
    if (type !== actual) {
      errors.push(`${pathStr}: expected ${type}, got ${actual}`);
      return;
    }
  }

  if (
    type === "object" ||
    (schema.properties &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value))
  ) {
    const obj = value as Record<string, unknown>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const key of required) {
      if (!(key in obj)) errors.push(`${pathStr}.${key}: missing required`);
    }
    const props =
      (schema.properties as Record<string, unknown> | undefined) ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj) {
        walk(obj[key], sub as Record<string, unknown>, `${pathStr}.${key}`, errors);
      }
    }
  }

  if (type === "array" && Array.isArray(value)) {
    const items = schema.items as Record<string, unknown> | undefined;
    if (items) {
      value.forEach((item, idx) => {
        walk(item, items, `${pathStr}[${idx}]`, errors);
      });
    }
  }
}

/**
 * Pulls the LAST fenced code block out of raw text. Accepts any language tag
 * (```json, ```findings.json, etc.) or none.
 */
export function extractFencedBlock(raw: string): string | null {
  const re = /```(?:[a-zA-Z0-9_.\-]+)?\n([\s\S]*?)```/g;
  let last: string | null = null;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    last = match[1];
  }
  return last;
}

async function readIfExists(p: string): Promise<string> {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return "";
  }
}

function emptyTokens(): SliceExecuteTokens {
  return { input: 0, output: 0, total: 0 };
}

async function tokensFromStream(streamPath: string): Promise<SliceExecuteTokens> {
  const raw = await readIfExists(streamPath);
  if (!raw) return emptyTokens();
  const { input, output, total } = getTokenBreakdown(parseStreamJsonl(raw));
  return { input, output, total };
}

type SandboxResult = { cwd: string; path?: string; repoRoot?: string };

async function git(cwd: string | undefined, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8" });
  return stdout.trim();
}

async function setupSandbox(
  sliceDir: string,
  sandbox: SliceSandbox,
  cwdOverride?: string
): Promise<SandboxResult> {
  switch (sandbox.mode) {
    case "none":
      return { cwd: cwdOverride ?? "" };
    case "tmpfs": {
      const p = path.join(sliceDir, "sandbox");
      await fs.mkdir(p, { recursive: true });
      return { cwd: p, path: p };
    }
    case "worktree": {
      const repoCwd = cwdOverride ?? process.cwd();
      const sandboxDir = path.join(sliceDir, "sandbox");

      // Detect git repo root; fall back to tmpfs if not a git repo
      let repoRoot: string;
      try {
        repoRoot = await git(repoCwd, ["rev-parse", "--show-toplevel"]);
      } catch {
        // Not a git repo — fall back to tmpfs
        await fs.mkdir(sandboxDir, { recursive: true });
        return { cwd: sandboxDir, path: sandboxDir };
      }

      // Create worktree: git worktree add --detach <sandboxDir> HEAD
      await fs.mkdir(sandboxDir, { recursive: true });
      try {
        await git(repoRoot, ["worktree", "add", "--detach", sandboxDir, "HEAD"]);
      } catch {
        // Worktree add failed (e.g. already exists, lock file) — fall back to tmpfs
        return { cwd: sandboxDir, path: sandboxDir };
      }

      // Isolate hooks: worktrees inherit .git/hooks from parent repo, which
      // could run unintended pre-commit scripts or leak env. Point this worktree
      // at an empty hooks path.
      try {
        await git(sandboxDir, ["config", "core.hooksPath", "/dev/null"]);
      } catch {
        /* best-effort */
      }

      return { cwd: sandboxDir, path: sandboxDir, repoRoot };
    }
    default:
      return { cwd: cwdOverride ?? "" };
  }
}

type RunSliceOutcome = {
  exitCode: number;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  timedOut: boolean;
  budgetExceeded: boolean;
};

/** Terminate a slice's CLI process group by reading pids.json (written by
 *  run-slice.sh via run_with_watchdog).  Signalling only `proc.pid` would
 *  hit the outer `run-slice.sh` script — the real CLI (`claude`, `codex`,
 *  LM Studio workers) lives in a separate process group created by
 *  bin/lib/pgid_shim.py, so we signal that group first. */
async function killSliceProcessGroup(
  pidsFile: string,
  fallbackPid: number | undefined,
): Promise<void> {
  type PidsRecord = { turn_pid?: number; script_pid?: number; cli_pgid?: number };
  let pids: PidsRecord | null = null;
  try {
    pids = JSON.parse(await fs.readFile(pidsFile, "utf8")) as PidsRecord;
  } catch {
    pids = null;
  }

  const tryKillPgid = (pgid: number, sig: NodeJS.Signals) => {
    try { process.kill(-pgid, sig); } catch { /* group gone */ }
  };
  const tryKillPid = (pid: number, sig: NodeJS.Signals) => {
    try { process.kill(pid, sig); } catch { /* gone */ }
  };

  if (pids?.cli_pgid && pids.cli_pgid > 0) {
    tryKillPgid(pids.cli_pgid, "SIGTERM");
  }
  if (pids?.script_pid && pids.script_pid > 0) {
    tryKillPgid(pids.script_pid, "SIGTERM");
  } else if (typeof fallbackPid === "number" && fallbackPid > 0) {
    tryKillPid(fallbackPid, "SIGTERM");
  }

  // Escalate to SIGKILL if anyone survived the grace period.
  setTimeout(() => {
    if (pids?.cli_pgid && pids.cli_pgid > 0) {
      tryKillPgid(pids.cli_pgid, "SIGKILL");
    }
    if (pids?.script_pid && pids.script_pid > 0) {
      tryKillPgid(pids.script_pid, "SIGKILL");
    } else if (typeof fallbackPid === "number" && fallbackPid > 0) {
      tryKillPid(fallbackPid, "SIGKILL");
    }
  }, 5000).unref();
}

async function runSliceProcess(params: {
  sliceDir: string;
  sessionId: string;
  sliceRunId: string;
  cli: CLI;
  model: string;
  allowedTools: string[];
  timeoutSeconds: number;
  cwd: string;
  prompt: string;
  /** Optional hard cap on total tokens. If the running total crosses this,
   *  the slice child is SIGTERMed and outcome.budgetExceeded is set. */
  maxTokens?: number;
}): Promise<RunSliceOutcome> {
  const scriptPath = path.join(binDir(), "run-slice.sh");
  const startedAt = new Date().toISOString();
  const startMs = Date.now();
  const streamFile = path.join(params.sliceDir, "stream.jsonl");

  let budgetExceeded = false;

  const pidsFile = path.join(params.sliceDir, "pids.json");

  const exitCode = await new Promise<number>((resolve) => {
    const proc = spawn(scriptPath, [], {
      detached: false,
      stdio: ["pipe", "ignore", "ignore"],
      env: {
        ...process.env,
        SESSION_ID: params.sessionId,
        SLICE_RUN_ID: params.sliceRunId,
        SLICE_CLI: params.cli,
        SLICE_MODEL: params.model,
        SLICE_ALLOWED_TOOLS: params.allowedTools.join(","),
        SLICE_TIMEOUT: String(params.timeoutSeconds),
        SLICE_CWD: params.cwd,
      },
    });

    let watcher: NodeJS.Timeout | null = null;
    if (params.maxTokens && params.maxTokens > 0) {
      const cap = params.maxTokens;
      watcher = setInterval(async () => {
        const tokens = await tokensFromStream(streamFile).catch(() => emptyTokens());
        if (tokens.total > cap) {
          budgetExceeded = true;
          await killSliceProcessGroup(pidsFile, proc.pid);
          if (watcher) clearInterval(watcher);
        }
      }, 1000);
    }

    proc.on("error", () => {
      if (watcher) clearInterval(watcher);
      resolve(1);
    });
    proc.on("exit", (code) => {
      if (watcher) clearInterval(watcher);
      resolve(code ?? 1);
    });
    try {
      proc.stdin.end(params.prompt);
    } catch {
      // stdin may already be closed if spawn failed; the "exit" / "error"
      // handlers above will still fire.
    }
  });

  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - startMs;

  // Detect watchdog-triggered timeout by scanning stderr.
  const stderr = await readIfExists(path.join(params.sliceDir, "stderr.log"));
  const timedOut = exitCode !== 0 && stderr.includes("[watchdog]");

  return { exitCode, startedAt, finishedAt, durationMs, timedOut, budgetExceeded };
}

async function appendIndex(
  sessionId: string,
  entry: Record<string, unknown>
): Promise<void> {
  const p = path.join(sessionsRoot(), sessionId, "slices", "index.jsonl");
  try {
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.appendFile(p, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // best-effort — not fatal if index write fails
  }
}

function failure(
  slice_run_id: string,
  error: string,
  sandbox_path?: string
): SliceExecuteResult {
  return {
    slice_run_id,
    status: "failed",
    output: null,
    raw_output: "",
    tokens: emptyTokens(),
    duration_ms: 0,
    error,
    sandbox_path,
  };
}

function statusFromOutcome(
  outcome: RunSliceOutcome,
  timeoutSeconds: number,
  maxTokens: number | undefined
): { status: SliceExecuteStatus; error?: string } | null {
  if (outcome.budgetExceeded) {
    return { status: "budget_exceeded", error: `slice exceeded max_tokens (${maxTokens}) mid-stream` };
  }
  if (outcome.timedOut) {
    return { status: "timeout", error: `slice timed out after ${timeoutSeconds}s` };
  }
  if (outcome.exitCode !== 0) {
    return { status: "failed", error: `slice exited with code ${outcome.exitCode}` };
  }
  return null;
}

async function finalizeSandboxMeta(
  sliceDir: string,
  sandbox: SandboxResult,
  sandboxMode: SliceSandboxMode,
  fallbackDurationMs: number
): Promise<number> {
  const metaPath = path.join(sliceDir, "meta.json");
  let duration_ms = fallbackDurationMs;
  try {
    const metaRaw = await fs.readFile(metaPath, "utf8");
    const meta = JSON.parse(metaRaw) as Record<string, unknown>;
    if (typeof meta.duration_ms === "number") duration_ms = meta.duration_ms;
    if (sandbox.path) {
      meta.sandbox_path = sandbox.path;
      meta.sandbox_mode = sandboxMode;
      if (sandbox.repoRoot) meta.sandbox_repo_root = sandbox.repoRoot;
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");
    }
  } catch {
    if (sandbox.path) {
      const meta: Record<string, unknown> = {
        sandbox_path: sandbox.path,
        sandbox_mode: sandboxMode,
      };
      if (sandbox.repoRoot) meta.sandbox_repo_root = sandbox.repoRoot;
      try {
        await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");
      } catch {
        /* best-effort */
      }
    }
  }
  return duration_ms;
}

async function cleanupWorktreeOnFailure(
  sandboxMode: SliceSandboxMode,
  sandbox: SandboxResult,
  exitCode: number
): Promise<void> {
  if (sandboxMode !== "worktree" || !sandbox.path || exitCode === 0) return;
  try {
    await git(sandbox.repoRoot ?? sandbox.cwd, ["worktree", "remove", "--force", sandbox.path]);
  } catch {
    /* best-effort */
  }
}

async function writeSliceResult(
  sliceDir: string,
  result: {
    slice_id?: string;
    status: SliceExecuteStatus;
    output: unknown | null;
    error?: string;
    tokens: SliceExecuteTokens;
    duration_ms: number;
    raw_output: string;
    executionContext?: SliceExecutionContext;
  },
): Promise<void> {
  const metaPath = path.join(sliceDir, "meta.json");
  if (result.output !== null) {
    await fs.writeFile(path.join(sliceDir, "output.json"), JSON.stringify(result.output, null, 2) + "\n", "utf8");
  }

  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(await fs.readFile(metaPath, "utf8")) as Record<string, unknown>;
  } catch {
    meta = {};
  }

  if (result.slice_id) meta.slice_id = result.slice_id;
  if (result.executionContext) {
    for (const [key, value] of Object.entries(result.executionContext)) {
      if (value !== undefined) meta[key] = value;
    }
  }
  meta.status = result.status;
  meta.output = result.output;
  meta.error = result.error ?? null;
  meta.tokens = result.tokens;
  meta.duration_ms = result.duration_ms;
  meta.raw_output_length = result.raw_output.length;
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");
}

async function recordBudget(sessionId: string, totalTokens: number): Promise<void> {
  try {
    await updateBudget(sessionId, { tokens_used: totalTokens, slice_calls: 1 });
  } catch {
    /* non-fatal */
  }
}

// ─── executeSlice ────────────────────────────────────────────────────────────

export async function executeSlice(req: SliceExecuteInput): Promise<SliceExecuteResult> {
  const slice_run_id = randomUUID();

  let slice: Slice | undefined;
  try {
    slice = await getSlice(req.sliceId);
  } catch (err) {
    return failure(slice_run_id, `failed to load slice: ${(err as Error).message}`);
  }
  if (!slice) {
    return failure(slice_run_id, `slice not found: ${req.sliceId}`);
  }

  const validation = sliceInputsValid(slice, req.inputs);
  if (!validation.ok) {
    return failure(slice_run_id, `missing required inputs: ${validation.missing.join(", ")}`);
  }

  const sliceDir = path.join(sessionsRoot(), req.sessionId, "slices", slice_run_id);
  try {
    await fs.mkdir(sliceDir, { recursive: true });
  } catch (err) {
    return failure(slice_run_id, `failed to create slice dir: ${(err as Error).message}`);
  }

  const renderedBase = renderTemplate(
    slice.prompt_template.system,
    req.inputs as Record<string, unknown>
  );
  const rendered = Object.keys(req.inputs).length === 0
    ? renderedBase
    : `${renderedBase}

---

Slice inputs from the orchestrator:

\`\`\`json
${JSON.stringify(req.inputs, null, 2)}
\`\`\``;

  let sandbox: SandboxResult;
  try {
    sandbox = await setupSandbox(sliceDir, slice.sandbox, req.cwdOverride);
  } catch (err) {
    return failure(slice_run_id, `sandbox setup failed: ${(err as Error).message}`);
  }

  const timeout_seconds =
    req.budgetOverride?.timeout_seconds ?? slice.budget?.timeout_seconds ?? 180;
  const maxTokens =
    req.budgetOverride?.max_tokens ?? slice.budget?.max_tokens;

  const queuedAt = new Date().toISOString();
  await appendIndex(req.sessionId, {
    slice_run_id,
    ...req.executionContext,
    slice_id: slice.id,
    status: "running",
    started_at: queuedAt,
  });

  let outcome: RunSliceOutcome;
  try {
    outcome = await runSliceProcess({
      sliceDir,
      sessionId: req.sessionId,
      sliceRunId: slice_run_id,
      cli: slice.cli,
      model: slice.model ?? "",
      allowedTools: slice.allowedTools ?? [],
      timeoutSeconds: timeout_seconds,
      cwd: sandbox.cwd,
      prompt: rendered,
      maxTokens,
    });
  } catch (err) {
    return failure(slice_run_id, `process spawn failed: ${(err as Error).message}`, sandbox.path);
  }

  const raw_output = await readIfExists(path.join(sliceDir, "output.raw.txt"));

  // Parse / validate output
  let output: unknown | null = null;
  let status: SliceExecuteStatus;
  let error: string | undefined;

  const outcomeStatus = statusFromOutcome(outcome, timeout_seconds, maxTokens);
  const isStructured =
    slice.capability.output.kind === "structured" && slice.io_schema?.output;

  if (outcomeStatus) {
    status = outcomeStatus.status;
    error = outcomeStatus.error;
  } else if (isStructured) {
    const block = extractFencedBlock(raw_output);
    if (block === null) {
      status = "output_validation_error";
      error = "no fenced code block found in output";
    } else {
      try {
        const parsed = JSON.parse(block);
        const v = validateJsonSchema(parsed, slice.io_schema!.output);
        output = parsed;
        if (v.ok) {
          status = "success";
        } else {
          status = "output_validation_error";
          error = `schema validation failed: ${v.errors.join("; ")}`;
        }
      } catch (e) {
        status = "output_validation_error";
        error = `JSON parse failed: ${(e as Error).message}`;
      }
    }
  } else {
    status = "success";
  }

  const tokens = await tokensFromStream(path.join(sliceDir, "stream.jsonl"));
  const duration_ms = await finalizeSandboxMeta(
    sliceDir,
    sandbox,
    slice.sandbox.mode,
    outcome.durationMs
  );
  await cleanupWorktreeOnFailure(slice.sandbox.mode, sandbox, outcome.exitCode);
  await recordBudget(req.sessionId, tokens.total);
  await writeSliceResult(sliceDir, {
    slice_id: slice.id,
    status,
    output,
    error,
    tokens,
    duration_ms,
    raw_output,
    executionContext: req.executionContext,
  });

  await appendIndex(req.sessionId, {
    slice_run_id,
    ...req.executionContext,
    slice_id: slice.id,
    status,
    started_at: outcome.startedAt,
    finished_at: outcome.finishedAt,
    tokens,
    duration_ms,
  });

  return {
    slice_run_id,
    status,
    output,
    raw_output,
    tokens,
    duration_ms,
    error,
    sandbox_path: sandbox.path,
  };
}

// ─── executeCustomSlice ──────────────────────────────────────────────────────

export async function executeCustomSlice(
  req: CustomSliceExecuteInput
): Promise<SliceExecuteResult> {
  const slice_run_id = randomUUID();
  const sliceDir = path.join(sessionsRoot(), req.sessionId, "slices", slice_run_id);

  try {
    await fs.mkdir(sliceDir, { recursive: true });
  } catch (err) {
    return failure(slice_run_id, `failed to create slice dir: ${(err as Error).message}`);
  }

  const sandboxSpec: SliceSandbox = req.spec.sandbox ?? { mode: "none", net: "deny" };
  let sandbox: SandboxResult;
  try {
    sandbox = await setupSandbox(sliceDir, sandboxSpec, req.cwdOverride);
  } catch (err) {
    return failure(slice_run_id, `sandbox setup failed: ${(err as Error).message}`);
  }

  const timeout_seconds = req.spec.budget?.timeout_seconds ?? 180;
  const maxTokens = req.spec.budget?.max_tokens;

  const queuedAt = new Date().toISOString();
  await appendIndex(req.sessionId, {
    slice_run_id,
    ...req.executionContext,
    slice_id: "__custom__",
    status: "running",
    started_at: queuedAt,
  });

  let outcome: RunSliceOutcome;
  try {
    outcome = await runSliceProcess({
      sliceDir,
      sessionId: req.sessionId,
      sliceRunId: slice_run_id,
      cli: req.spec.cli,
      model: req.spec.model ?? "",
      allowedTools: req.spec.allowedTools ?? [],
      timeoutSeconds: timeout_seconds,
      cwd: sandbox.cwd,
      prompt: req.spec.prompt,
      maxTokens,
    });
  } catch (err) {
    return failure(slice_run_id, `process spawn failed: ${(err as Error).message}`, sandbox.path);
  }

  const raw_output = await readIfExists(path.join(sliceDir, "output.raw.txt"));

  // Custom slices don't carry schemas in v1 — just map exit code to status.
  const outcomeStatus = statusFromOutcome(outcome, timeout_seconds, maxTokens);
  const status: SliceExecuteStatus = outcomeStatus?.status ?? "success";
  const error = outcomeStatus?.error;

  const tokens = await tokensFromStream(path.join(sliceDir, "stream.jsonl"));
  const duration_ms = await finalizeSandboxMeta(
    sliceDir,
    sandbox,
    sandboxSpec.mode,
    outcome.durationMs
  );
  await cleanupWorktreeOnFailure(sandboxSpec.mode, sandbox, outcome.exitCode);
  await recordBudget(req.sessionId, tokens.total);
  await writeSliceResult(sliceDir, {
    slice_id: "__custom__",
    status,
    output: null,
    error,
    tokens,
    duration_ms,
    raw_output,
    executionContext: req.executionContext,
  });

  await appendIndex(req.sessionId, {
    slice_run_id,
    ...req.executionContext,
    slice_id: "__custom__",
    status,
    started_at: outcome.startedAt,
    finished_at: outcome.finishedAt,
    tokens,
    duration_ms,
  });

  return {
    slice_run_id,
    status,
    output: null,
    raw_output,
    tokens,
    duration_ms,
    error,
    sandbox_path: sandbox.path,
  };
}
