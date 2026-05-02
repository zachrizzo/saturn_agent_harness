import { execFile } from "node:child_process";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { getSessionMeta } from "@/lib/runs";
import { resolveSessionFile } from "@/lib/session-files";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_DIFF_BYTES = 2 * 1024 * 1024;

function runGit(args: string[], cwd: string, allowDifferenceExit = false): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: MAX_DIFF_BYTES + 512 * 1024 },
      (error, stdout, stderr) => {
        const code = typeof (error as { code?: unknown } | null)?.code === "number"
          ? (error as { code: number }).code
          : null;
        if (error && !(allowDifferenceExit && code === 1)) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function truncateDiff(diff: string): { diff: string; truncated: boolean } {
  const bytes = Buffer.byteLength(diff, "utf8");
  if (bytes <= MAX_DIFF_BYTES) return { diff, truncated: false };

  const head = Buffer.from(diff).subarray(0, MAX_DIFF_BYTES).toString("utf8");
  return {
    diff: `${head}\n\n... diff truncated after ${(MAX_DIFF_BYTES / (1024 * 1024)).toFixed(0)} MB ...\n`,
    truncated: true,
  };
}

function normalizeGitPath(filePath: string, gitRoot: string): string {
  return path.relative(gitRoot, filePath).split(path.sep).join("/");
}

async function gitRootFor(filePath: string): Promise<string | null> {
  try {
    const root = await runGit(["rev-parse", "--show-toplevel"], path.dirname(filePath));
    return root.trim() || null;
  } catch {
    return null;
  }
}

async function untrackedDiff(filePath: string, gitRoot: string): Promise<string> {
  return runGit(
    ["diff", "--no-index", "--no-color", "--", "/dev/null", filePath],
    gitRoot,
    true,
  );
}

async function trackedDiff(relativePath: string, gitRoot: string): Promise<string> {
  const [staged, unstaged] = await Promise.all([
    runGit(["diff", "--cached", "--no-color", "--", relativePath], gitRoot),
    runGit(["diff", "--no-color", "--", relativePath], gitRoot),
  ]);

  const sections: string[] = [];
  if (staged.trim()) sections.push(`## Staged changes\n\n${staged}`);
  if (unstaged.trim()) sections.push(`## Unstaged changes\n\n${unstaged}`);
  return sections.join("\n");
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSessionMeta(id);
  if (!session) return NextResponse.json({ error: "not found" }, { status: 404 });

  const rawPath = req.nextUrl.searchParams.get("path");
  if (!rawPath) return NextResponse.json({ error: "missing path" }, { status: 400 });

  const filePath = await resolveSessionFile(id, session.agent_snapshot?.cwd, rawPath);
  if (!filePath) return NextResponse.json({ error: "file not found" }, { status: 404 });

  const gitRoot = await gitRootFor(filePath);
  if (!gitRoot) {
    return NextResponse.json({
      isGitRepo: false,
      hasChanges: false,
      diff: "",
      message: "This file is not inside a Git repository.",
    });
  }

  const relativePath = normalizeGitPath(filePath, gitRoot);
  const status = await runGit(["status", "--porcelain", "--", relativePath], gitRoot);
  const statusLine = status.split(/\r?\n/).find(Boolean) ?? "";

  if (!statusLine) {
    return NextResponse.json({
      isGitRepo: true,
      hasChanges: false,
      diff: "",
      gitRoot,
      relativePath,
      status: "clean",
      message: "No local changes for this file.",
    });
  }

  const rawDiff = statusLine.startsWith("??")
    ? await untrackedDiff(filePath, gitRoot)
    : await trackedDiff(relativePath, gitRoot);
  const { diff, truncated } = truncateDiff(rawDiff);

  return NextResponse.json({
    isGitRepo: true,
    hasChanges: diff.trim().length > 0,
    diff,
    gitRoot,
    relativePath,
    status: statusLine.slice(0, 2),
    truncated,
    message: diff.trim() ? undefined : "Git reports changes, but no textual diff is available.",
  });
}
