// Cross-process advisory lock around `sessions/<id>/meta.json`.
//
// Uses an O_EXCL sentinel file (`meta.lock`) so the dashboard (Node) and
// run-turn.sh (bash) can coordinate writes to the same meta.json. The lock
// is best-effort: if it can't be acquired within `timeoutMs`, the caller
// proceeds anyway (so the API never hangs forever waiting on a misbehaving
// shell process). Stale locks older than `META_LOCK_STALE_MS` are reaped.

import path from "node:path";
import { randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import { sessionsRoot } from "./paths";

const META_LOCK_STALE_MS = 30 * 1000;
const DEFAULT_TIMEOUT_MS = 2000;
const MIN_BACKOFF_MS = 25;
const MAX_BACKOFF_MS = 200;

function lockPath(sessionId: string): string {
  return path.join(sessionsRoot(), sessionId, "meta.lock");
}

function isEEXIST(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "EEXIST";
}

async function removeStaleLock(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    if (Date.now() - stat.mtimeMs < META_LOCK_STALE_MS) return false;
    await fs.unlink(file);
    return true;
  } catch {
    return false;
  }
}

async function removeOwnedLock(file: string, token: string): Promise<void> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as { token?: unknown };
    if (parsed.token !== token) return;
    await fs.unlink(file);
  } catch {
    // Lock cleanup is best-effort. If the file disappeared, another writer has
    // already made progress; if it changed owners, leave it in place.
  }
}

export type MetaLockHandle = {
  acquired: boolean;
  release: () => Promise<void>;
};

export async function acquireSessionMetaLock(
  sessionId: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<MetaLockHandle> {
  const file = lockPath(sessionId);
  const token = randomUUID();
  const payload = JSON.stringify({
    session_id: sessionId,
    pid: process.pid,
    holder: "dashboard",
    token,
    acquired_at: new Date().toISOString(),
  });
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let backoff = MIN_BACKOFF_MS;
  let staleAttempted = false;

  while (true) {
    try {
      const fd = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      try {
        await fd.writeFile(payload, "utf8");
      } finally {
        await fd.close();
      }
      return {
        acquired: true,
        release: () => removeOwnedLock(file, token),
      };
    } catch (err) {
      if (!isEEXIST(err)) throw err;
      if (!staleAttempted && (await removeStaleLock(file))) {
        staleAttempted = true;
        continue;
      }
      if (Date.now() >= deadline) {
        // Best-effort: proceed without the lock so callers don't hang.
        return { acquired: false, release: async () => {} };
      }
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(MAX_BACKOFF_MS, Math.floor(backoff * 1.6) || MIN_BACKOFF_MS);
    }
  }
}

export async function withSessionMetaLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
  timeoutMs?: number,
): Promise<T> {
  const handle = await acquireSessionMetaLock(sessionId, timeoutMs);
  try {
    return await fn();
  } finally {
    await handle.release();
  }
}
