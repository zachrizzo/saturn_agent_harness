import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { getSessionMeta } from "@/lib/runs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_STATUS_BYTES = 1024 * 1024;

type GitChange = {
  path: string;
  absolutePath: string;
  status: string;
  staged: string;
  unstaged: string;
  untracked: boolean;
  exists: boolean;
};

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: MAX_STATUS_BYTES },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function normalizeStatus(raw: string): { staged: string; unstaged: string; untracked: boolean } {
  const staged = raw[0] === " " ? "" : raw[0] ?? "";
  const unstaged = raw[1] === " " ? "" : raw[1] ?? "";
  return { staged, unstaged, untracked: raw === "??" };
}

function parseStatus(stdout: string, gitRoot: string): Array<Omit<GitChange, "exists">> {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const status = line.slice(0, 2);
      const rawPath = line.slice(3);
      const filePath = rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) ?? rawPath : rawPath;
      const normalizedPath = filePath.replace(/^"|"$/g, "");
      const flags = normalizeStatus(status);
      return {
        path: normalizedPath,
        absolutePath: path.join(gitRoot, normalizedPath),
        status,
        ...flags,
      };
    });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSessionMeta(id);
  if (!session) return NextResponse.json({ error: "not found" }, { status: 404 });

  const cwd = session.agent_snapshot?.cwd;
  if (!cwd) {
    return NextResponse.json({
      isGitRepo: false,
      files: [],
      message: "This session has no working directory.",
    });
  }

  let gitRoot: string;
  try {
    gitRoot = (await runGit(["rev-parse", "--show-toplevel"], cwd)).trim();
  } catch {
    return NextResponse.json({
      isGitRepo: false,
      files: [],
      message: "This session working directory is not inside a Git repository.",
    });
  }

  const stdout = await runGit(["status", "--porcelain", "--untracked-files=all"], gitRoot);
  const parsed = parseStatus(stdout, gitRoot);
  const files: GitChange[] = await Promise.all(
    parsed.map(async (change) => ({
      ...change,
      exists: Boolean(await fs.stat(change.absolutePath).catch(() => null)),
    })),
  );

  return NextResponse.json({
    isGitRepo: true,
    gitRoot,
    files,
  });
}
