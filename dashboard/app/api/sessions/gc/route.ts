import { NextResponse } from "next/server";
import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sessionsRoot } from "@/lib/paths";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const execFileAsync = promisify(execFile);

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

type SliceMeta = {
  sandbox_path?: string;
  sandbox_mode?: string;
  finished_at?: string;
  applied?: boolean;
  [key: string]: unknown;
};

async function listDirs(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

// POST: Scan all sessions for stale tmpfs/worktree sandboxes older than 7 days
// with no applied_at and a finished_at, then remove them.
// Fire-and-forget maintenance endpoint — not called automatically in v1.
export async function POST() {
  const root = sessionsRoot();
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  let cleaned = 0;

  const sessionIds = await listDirs(root);

  for (const sessionId of sessionIds) {
    const slicesDir = path.join(root, sessionId, "slices");
    const runIds = await listDirs(slicesDir);

    for (const runId of runIds) {
      const metaPath = path.join(slicesDir, runId, "meta.json");
      let meta: SliceMeta;
      try {
        const raw = await fs.readFile(metaPath, "utf8");
        meta = JSON.parse(raw) as SliceMeta;
      } catch {
        continue;
      }

      const { sandbox_path, sandbox_mode, finished_at, applied } = meta;

      // Only GC sandboxes that have a path, finished, are old enough, and not applied
      if (!sandbox_path) continue;
      if (!sandbox_mode || !["tmpfs", "worktree"].includes(sandbox_mode)) continue;
      if (!finished_at) continue;
      if (applied) continue;

      const finishedMs = new Date(finished_at).getTime();
      if (isNaN(finishedMs) || finishedMs > cutoff) continue;

      // Remove sandbox
      try {
        if (sandbox_mode === "worktree") {
          await execFileAsync("git", ["worktree", "remove", "--force", sandbox_path]);
        } else {
          // tmpfs — plain directory removal
          await fs.rm(sandbox_path, { recursive: true, force: true });
        }
        cleaned++;
        // Clear sandbox_path from meta so GC doesn't re-attempt
        meta.sandbox_path = undefined;
        await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");
      } catch {
        // best-effort — log but continue
      }
    }
  }

  return NextResponse.json({ cleaned });
}
