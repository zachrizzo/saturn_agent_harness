import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { promises as fs } from "node:fs";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { sessionsRoot } from "@/lib/paths";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const execAsync = promisify(exec);

type SliceMeta = {
  sandbox_path?: string;
  sandbox_mode?: string;
  sandbox_repo_root?: string;
  applied?: boolean;
  applied_at?: string;
  [key: string]: unknown;
};

async function readSliceMeta(sliceMetaPath: string): Promise<SliceMeta> {
  const raw = await fs.readFile(sliceMetaPath, "utf8");
  return JSON.parse(raw) as SliceMeta;
}

async function acquireLock(lockPath: string): Promise<boolean> {
  try {
    const fh = await fs.open(lockPath, "wx");
    await fh.writeFile(String(process.pid));
    await fh.close();
    return true;
  } catch {
    return false;
  }
}

async function releaseLock(lockPath: string): Promise<void> {
  await fs.unlink(lockPath).catch(() => { /* best-effort */ });
}

// GET: Returns the diff between the worktree and HEAD (dry-run preview)
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; run_id: string }> }
) {
  const { id: sessionId, run_id } = await params;
  const sliceMetaPath = path.join(
    sessionsRoot(),
    sessionId,
    "slices",
    run_id,
    "meta.json"
  );

  let sliceMeta: SliceMeta;
  try {
    sliceMeta = await readSliceMeta(sliceMetaPath);
  } catch {
    return NextResponse.json({ error: "slice meta not found" }, { status: 404 });
  }

  const sandboxPath = sliceMeta.sandbox_path;
  if (!sandboxPath) {
    return NextResponse.json({ error: "no sandbox" }, { status: 404 });
  }
  if (sliceMeta.sandbox_mode !== "worktree") {
    return NextResponse.json(
      { error: "not a worktree sandbox" },
      { status: 400 }
    );
  }

  const { stdout: diff } = await execAsync(
    `git -C "${sandboxPath}" diff HEAD`
  ).catch(() => ({ stdout: "" }));

  const { stdout: status } = await execAsync(
    `git -C "${sandboxPath}" status --short`
  ).catch(() => ({ stdout: "" }));

  return NextResponse.json({
    diff,
    status,
    sandbox_path: sandboxPath,
    applied: sliceMeta.applied ?? false,
  });
}

// POST: Apply the worktree changes to the session's original repo root
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; run_id: string }> }
) {
  const { id: sessionId, run_id } = await params;

  let body: { confirmed?: boolean } = {};
  try {
    body = await req.json();
  } catch {
    // allow empty body — will fail the confirmed check below
  }

  if (body.confirmed !== true) {
    return NextResponse.json(
      { error: "must send {confirmed: true}" },
      { status: 400 }
    );
  }

  const sessionDir = path.join(sessionsRoot(), sessionId);
  const sliceMetaPath = path.join(sessionDir, "slices", run_id, "meta.json");
  const lockPath = path.join(sessionDir, "apply.lock");

  const gotLock = await acquireLock(lockPath);
  if (!gotLock) {
    return NextResponse.json(
      { error: "another apply is in progress" },
      { status: 409 }
    );
  }

  try {
    let sliceMeta: SliceMeta;
    try {
      sliceMeta = await readSliceMeta(sliceMetaPath);
    } catch {
      return NextResponse.json({ error: "slice meta not found" }, { status: 404 });
    }

    const sandboxPath = sliceMeta.sandbox_path;
    const repoRoot = sliceMeta.sandbox_repo_root;

    if (!sandboxPath || !repoRoot) {
      return NextResponse.json(
        { error: "no worktree sandbox metadata" },
        { status: 404 }
      );
    }

    if (sliceMeta.sandbox_mode !== "worktree") {
      return NextResponse.json(
        { error: "not a worktree sandbox" },
        { status: 400 }
      );
    }

    if (sliceMeta.applied) {
      return NextResponse.json(
        { error: "changes already applied", applied_at: sliceMeta.applied_at },
        { status: 409 }
      );
    }

    const { stdout: patch } = await execAsync(
      `git -C "${sandboxPath}" diff HEAD`
    );

    if (!patch.trim()) {
      return NextResponse.json({ applied: true, message: "no changes to apply" });
    }

    const patchFile = path.join(sessionDir, "slices", run_id, "changes.patch");
    await fs.writeFile(patchFile, patch, "utf8");

    // Pre-flight: would this patch apply cleanly? If not, surface the conflict
    // list instead of partially applying.
    try {
      await execAsync(`git -C "${repoRoot}" apply --check "${patchFile}"`);
    } catch (checkErr: unknown) {
      const msg = checkErr instanceof Error ? checkErr.message : String(checkErr);
      return NextResponse.json(
        {
          error: "patch does not apply cleanly",
          conflicts: msg,
          patch_file: patchFile,
        },
        { status: 409 }
      );
    }

    await execAsync(`git -C "${repoRoot}" apply "${patchFile}"`);

    // Mark as applied in slice meta
    const updatedMeta = await readSliceMeta(sliceMetaPath);
    updatedMeta.applied = true;
    updatedMeta.applied_at = new Date().toISOString();
    await fs.writeFile(sliceMetaPath, JSON.stringify(updatedMeta, null, 2), "utf8");

    // Cleanup: remove the worktree now that changes have landed in the real repo.
    // Best-effort — leaving it around is not a correctness problem, just disk bloat.
    try {
      await execAsync(`git worktree remove --force "${sandboxPath}"`);
    } catch {
      /* noop */
    }

    return NextResponse.json({ applied: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { error: `apply failed: ${msg}` },
      { status: 500 }
    );
  } finally {
    await releaseLock(lockPath);
  }
}
