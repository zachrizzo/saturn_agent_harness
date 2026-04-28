// Per-session budget accountant.
//
// Persists to `sessions/<session_id>/budget.json`. Writes go through a
// hand-rolled lockfile (O_EXCL sentinel) since we're not pulling in a new dep.
// Reads are atomic enough for the check path — even if a concurrent writer
// half-updates tokens_used, the consumer just reads a slightly-stale figure.
//
// Used by slice-executor.ts (accumulates tokens + slice_calls after each run)
// and the MCP `get_budget` / `stop` tools (step 4).

import { promises as fs } from "node:fs";
import path from "node:path";
import { sessionsRoot } from "./paths";

const LOCK_TIMEOUT_MS = 2000;

export type Budget = {
  tokens_used: number;
  slice_calls: number;
  wallclock_started_at: string; // ISO
  recursion_depth: number;
  stop: boolean;
  stop_reason?: string;
};

export type BudgetLimits = {
  max_total_tokens?: number;
  max_wallclock_seconds?: number;
  max_slice_calls?: number;
  max_recursion_depth?: number;
};

export type BudgetRemaining = {
  tokens?: number;
  slice_calls?: number;
  wallclock_seconds?: number;
};

export type BudgetCheckResult =
  | { ok: true; remaining: BudgetRemaining }
  | {
      ok: false;
      reason: "tokens" | "slice_calls" | "wallclock" | "stop";
      remaining: BudgetRemaining;
    };

function budgetPath(sessionId: string): string {
  return path.join(sessionsRoot(), sessionId, "budget.json");
}

function lockPath(sessionId: string): string {
  return path.join(sessionsRoot(), sessionId, "budget.json.lock");
}

function emptyBudget(): Budget {
  return {
    tokens_used: 0,
    slice_calls: 0,
    wallclock_started_at: new Date().toISOString(),
    recursion_depth: 0,
    stop: false,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Acquire an exclusive lock by creating the lockfile with O_EXCL ("wx").
// Retries with a small backoff; breaks stale locks past LOCK_TIMEOUT_MS.
async function acquireLock(sessionId: string): Promise<void> {
  const lp = lockPath(sessionId);
  await fs.mkdir(path.dirname(lp), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (true) {
    try {
      const fd = await fs.open(lp, "wx");
      await fd.close();
      return;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() > deadline) {
        await fs.unlink(lp).catch(() => {});
        continue;
      }
      await sleep(10 + Math.floor(Math.random() * 40));
    }
  }
}

async function releaseLock(sessionId: string): Promise<void> {
  await fs.unlink(lockPath(sessionId)).catch(() => {});
}

export async function readBudget(sessionId: string): Promise<Budget> {
  const p = budgetPath(sessionId);
  try {
    const raw = await fs.readFile(p, "utf8");
    const parsed = JSON.parse(raw) as Partial<Budget>;
    return {
      tokens_used: parsed.tokens_used ?? 0,
      slice_calls: parsed.slice_calls ?? 0,
      wallclock_started_at: parsed.wallclock_started_at ?? new Date().toISOString(),
      recursion_depth: parsed.recursion_depth ?? 0,
      stop: Boolean(parsed.stop),
      stop_reason: parsed.stop_reason,
    };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyBudget();
    throw err;
  }
}

export async function initBudget(sessionId: string): Promise<Budget> {
  const p = budgetPath(sessionId);
  await fs.mkdir(path.dirname(p), { recursive: true });
  try {
    // Try to write only if missing.
    const fd = await fs.open(p, "wx");
    const b = emptyBudget();
    await fd.writeFile(JSON.stringify(b, null, 2), "utf8");
    await fd.close();
    return b;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return readBudget(sessionId);
    throw err;
  }
}

export async function updateBudget(sessionId: string, delta: Partial<Budget>): Promise<Budget> {
  const p = budgetPath(sessionId);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await acquireLock(sessionId);
  try {
    const current = await readBudget(sessionId);
    const next: Budget = {
      tokens_used: current.tokens_used + (delta.tokens_used ?? 0),
      slice_calls: current.slice_calls + (delta.slice_calls ?? 0),
      recursion_depth: current.recursion_depth + (delta.recursion_depth ?? 0),
      wallclock_started_at:
        delta.wallclock_started_at ?? current.wallclock_started_at,
      stop: delta.stop !== undefined ? Boolean(delta.stop) : current.stop,
      stop_reason: delta.stop_reason !== undefined ? delta.stop_reason : current.stop_reason,
    };
    await fs.writeFile(p, JSON.stringify(next, null, 2), "utf8");
    return next;
  } finally {
    await releaseLock(sessionId);
  }
}

function computeRemaining(budget: Budget, limits: BudgetLimits): BudgetRemaining {
  const out: BudgetRemaining = {};
  if (limits.max_total_tokens !== undefined) {
    out.tokens = Math.max(0, limits.max_total_tokens - budget.tokens_used);
  }
  if (limits.max_slice_calls !== undefined) {
    out.slice_calls = Math.max(0, limits.max_slice_calls - budget.slice_calls);
  }
  if (limits.max_wallclock_seconds !== undefined) {
    const startedMs = Date.parse(budget.wallclock_started_at);
    const elapsedSec = Number.isFinite(startedMs)
      ? Math.max(0, Math.floor((Date.now() - startedMs) / 1000))
      : 0;
    out.wallclock_seconds = Math.max(0, limits.max_wallclock_seconds - elapsedSec);
  }
  return out;
}

export async function checkBudget(
  sessionId: string,
  limits: BudgetLimits
): Promise<BudgetCheckResult> {
  const budget = await readBudget(sessionId);
  const remaining = computeRemaining(budget, limits);

  if (budget.stop) return { ok: false, reason: "stop", remaining };
  if (
    limits.max_total_tokens !== undefined &&
    budget.tokens_used >= limits.max_total_tokens
  ) {
    return { ok: false, reason: "tokens", remaining };
  }
  if (
    limits.max_slice_calls !== undefined &&
    budget.slice_calls >= limits.max_slice_calls
  ) {
    return { ok: false, reason: "slice_calls", remaining };
  }
  if (
    limits.max_wallclock_seconds !== undefined &&
    remaining.wallclock_seconds !== undefined &&
    remaining.wallclock_seconds <= 0
  ) {
    return { ok: false, reason: "wallclock", remaining };
  }
  return { ok: true, remaining };
}

export async function stopBudget(sessionId: string, reason: string): Promise<void> {
  await updateBudget(sessionId, { stop: true, stop_reason: reason });
}
