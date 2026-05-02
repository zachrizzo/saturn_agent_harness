import { promises as fs } from "node:fs";
import path from "node:path";
import { sessionsRoot } from "./paths";
import type { SessionMeta, TurnRecord } from "./runs";

const STALE_RUNNING_SESSION_MS = 5 * 60 * 1000;

type PidsRecord = {
  turn_pid?: number;
  script_pid?: number;
  cli_pgid?: number;
  started_at?: string;
};

function sessionPath(sessionId: string): string {
  return path.join(sessionsRoot(), sessionId);
}

function metaPath(sessionId: string): string {
  return path.join(sessionPath(sessionId), "meta.json");
}

function streamPath(sessionId: string): string {
  return path.join(sessionPath(sessionId), "stream.jsonl");
}

function pidsPath(sessionId: string): string {
  return path.join(sessionPath(sessionId), "pids.json");
}

function turnLockPath(sessionId: string): string {
  return path.join(sessionPath(sessionId), "turn.lock");
}

function processIsLive(pid: number | undefined): boolean {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EPERM") return true;
    return false;
  }
}

async function readPids(sessionId: string): Promise<PidsRecord> {
  const raw = await fs.readFile(pidsPath(sessionId), "utf8").catch(() => "");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as PidsRecord;
  } catch {
    return {};
  }
}

async function liveRunnerExists(sessionId: string): Promise<boolean> {
  const pids = await readPids(sessionId);
  if (processIsLive(pids.script_pid) || processIsLive(pids.turn_pid)) return true;
  if (pids.cli_pgid && processIsLive(-Math.abs(pids.cli_pgid))) return true;
  return false;
}

function runningSince(meta: SessionMeta): string {
  const extra = meta as SessionMeta & { last_turn_started_at?: string };
  return extra.last_turn_started_at
    ?? meta.turns.at(-1)?.started_at
    ?? meta.started_at;
}

function runningAgeMs(meta: SessionMeta, nowMs = Date.now()): number {
  const startedMs = new Date(runningSince(meta)).getTime();
  return Number.isFinite(startedMs) ? nowMs - startedMs : Number.POSITIVE_INFINITY;
}

function runningTurn(meta: SessionMeta): TurnRecord | undefined {
  const last = meta.turns.at(-1);
  return last?.status === "running" ? last : undefined;
}

async function appendLifecycleEvent(sessionId: string, event: Record<string, unknown>): Promise<void> {
  await fs.appendFile(streamPath(sessionId), `${JSON.stringify(event)}\n`, "utf8").catch(() => {});
}

async function writeMeta(meta: SessionMeta): Promise<void> {
  await fs.writeFile(metaPath(meta.session_id), JSON.stringify(meta, null, 2), "utf8");
}

export async function markSessionRunnerFailed(
  sessionId: string,
  reason: string,
  eventType = "saturn.runner_failed",
): Promise<SessionMeta | null> {
  const raw = await fs.readFile(metaPath(sessionId), "utf8").catch(() => null);
  if (!raw) return null;

  let meta: SessionMeta;
  try {
    meta = JSON.parse(raw) as SessionMeta;
  } catch {
    return null;
  }

  if (meta.status !== "running") return meta;

  const now = new Date().toISOString();
  const turn = runningTurn(meta);
  meta.status = "failed";
  meta.finished_at = now;
  delete (meta as SessionMeta & { last_turn_started_at?: string }).last_turn_started_at;
  if (turn) {
    turn.status = "aborted";
    turn.finished_at = now;
  }

  await writeMeta(meta);
  await appendLifecycleEvent(sessionId, {
    type: eventType,
    session_id: sessionId,
    turn_id: turn?.turn_id ?? null,
    reason,
    at: now,
  });
  await fs.rm(pidsPath(sessionId), { force: true }).catch(() => {});
  await fs.rm(turnLockPath(sessionId), { force: true }).catch(() => {});
  return meta;
}

export async function markSessionIfRunnerExited(
  sessionId: string,
  exitCode: number | null,
): Promise<SessionMeta | null> {
  if (await liveRunnerExists(sessionId)) return null;
  return markSessionRunnerFailed(
    sessionId,
    `runner exited before finalizing session metadata${exitCode === null ? "" : ` (exit ${exitCode})`}`,
    "saturn.runner_exited",
  );
}

export async function reconcileStaleRunningSession(meta: SessionMeta): Promise<SessionMeta> {
  if (meta.status !== "running") return meta;
  if (runningAgeMs(meta) < STALE_RUNNING_SESSION_MS) return meta;
  if (await liveRunnerExists(meta.session_id)) return meta;

  return await markSessionRunnerFailed(
    meta.session_id,
    "no live runner process was found for this running session",
    "saturn.session_reaped",
  ) ?? meta;
}
