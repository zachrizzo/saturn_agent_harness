import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import parser from "cron-parser";
import { listJobs, listRuns, triggerJob, type Job, type RunMeta } from "./runs";
import { runsRoot } from "./paths";

const CATCH_UP_WINDOW_MS = 25 * 60 * 60 * 1000;
const CATCH_UP_GRACE_MS = 60 * 1000;
const LOCK_STALE_MS = 10 * 60 * 1000;

type CatchUpState = {
  jobs?: Record<string, {
    lastTriggeredScheduledAt?: string;
    lastTriggeredAt?: string;
  }>;
};

export type MissedJobCatchUp = {
  jobName: string;
  scheduledAt: string;
  runSlug: string;
};

function statePath(): string {
  return path.join(runsRoot(), ".missed-job-catchups.json");
}

function lockPath(): string {
  return path.join(runsRoot(), ".missed-job-catchups.lock");
}

async function readState(): Promise<CatchUpState> {
  try {
    const raw = await fs.readFile(statePath(), "utf8");
    const parsed = JSON.parse(raw) as CatchUpState;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeState(state: CatchUpState): Promise<void> {
  await fs.mkdir(runsRoot(), { recursive: true });
  await fs.writeFile(statePath(), JSON.stringify(state, null, 2), "utf8");
}

async function acquireLock(): Promise<FileHandle | null> {
  await fs.mkdir(runsRoot(), { recursive: true });
  const file = lockPath();
  try {
    return await fs.open(file, "wx");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const stat = await fs.stat(file).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
      await fs.rm(file, { force: true });
      return fs.open(file, "wx").catch(() => null);
    }
    return null;
  }
}

async function withCatchUpLock<T>(fn: () => Promise<T>, lockedValue: T): Promise<T> {
  const lock = await acquireLock();
  if (!lock) return lockedValue;
  try {
    await lock.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, "utf8");
    return await fn();
  } finally {
    await lock.close().catch(() => {});
    await fs.rm(lockPath(), { force: true }).catch(() => {});
  }
}

function latestScheduledAt(job: Job, now: Date): Date | null {
  try {
    return parser.parseExpression(job.cron, { currentDate: now }).prev().toDate();
  } catch {
    return null;
  }
}

function runStartedMs(run: RunMeta | undefined): number {
  if (!run?.started_at) return 0;
  const ms = new Date(run.started_at).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function isCatchUpDue(job: Job, runs: RunMeta[], state: CatchUpState, now: Date): Date | null {
  if (!job.catchUpMissedRuns) return null;
  const scheduledAt = latestScheduledAt(job, now);
  if (!scheduledAt) return null;

  const nowMs = now.getTime();
  const scheduledMs = scheduledAt.getTime();
  const ageMs = nowMs - scheduledMs;
  if (ageMs < CATCH_UP_GRACE_MS || ageMs > CATCH_UP_WINDOW_MS) return null;

  const latestRun = runs[0];
  if (latestRun?.status === "running") return null;
  if (runStartedMs(latestRun) >= scheduledMs) return null;

  const scheduledIso = scheduledAt.toISOString();
  if (state.jobs?.[job.name]?.lastTriggeredScheduledAt === scheduledIso) return null;

  return scheduledAt;
}

export async function runMissedJobCatchUps(now = new Date()): Promise<MissedJobCatchUp[]> {
  return withCatchUpLock(async () => {
    const [jobs, runs, state] = await Promise.all([listJobs(), listRuns(), readState()]);
    const runsByJob = new Map<string, RunMeta[]>();
    for (const run of runs) {
      const list = runsByJob.get(run.name);
      if (list) list.push(run);
      else runsByJob.set(run.name, [run]);
    }

    const triggered: MissedJobCatchUp[] = [];
    const nextState: CatchUpState = { jobs: { ...(state.jobs ?? {}) } };

    for (const job of jobs) {
      const scheduledAt = isCatchUpDue(job, runsByJob.get(job.name) ?? [], nextState, now);
      if (!scheduledAt) continue;

      const scheduledIso = scheduledAt.toISOString();
      nextState.jobs![job.name] = {
        lastTriggeredScheduledAt: scheduledIso,
        lastTriggeredAt: now.toISOString(),
      };
      await writeState(nextState);

      const runSlug = await triggerJob(job.name);
      triggered.push({ jobName: job.name, scheduledAt: scheduledIso, runSlug });
    }

    return triggered;
  }, []);
}
