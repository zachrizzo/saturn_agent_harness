import path from "node:path";
import { constants, promises as fs } from "node:fs";
import { sessionsRoot } from "./paths";

const TURN_LOCK_STALE_MS = 6 * 60 * 60 * 1000;

type SessionTurnLockOptions = {
  waitMs?: number;
  retryDelayMs?: number;
};

function lockPath(sessionId: string): string {
  return path.join(sessionsRoot(), sessionId, "turn.lock");
}

function isEEXIST(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "EEXIST";
}

async function removeStaleLock(file: string): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    if (Date.now() - stat.mtimeMs < TURN_LOCK_STALE_MS) return false;
    await fs.unlink(file);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function acquireSessionTurnLock(
  sessionId: string,
  options: SessionTurnLockOptions = {},
): Promise<
  | { ok: true; release: () => Promise<void> }
  | { ok: false }
> {
  const file = lockPath(sessionId);
  const waitMs = Math.max(0, options.waitMs ?? 0);
  const retryDelayMs = Math.max(25, options.retryDelayMs ?? 100);
  const deadline = Date.now() + waitMs;
  const payload = JSON.stringify({
    session_id: sessionId,
    pid: process.pid,
    acquired_at: new Date().toISOString(),
  }, null, 2);

  while (true) {
    try {
      const fd = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
      try {
        await fd.writeFile(payload, "utf8");
      } finally {
        await fd.close();
      }
      return {
        ok: true,
        release: () => fs.unlink(file).catch(() => {}),
      };
    } catch (err) {
      if (!isEEXIST(err)) throw err;
      if (await removeStaleLock(file)) continue;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return { ok: false };
      await sleep(Math.min(retryDelayMs, remainingMs));
    }
  }
}
