import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { listWorkingDirectories, recordWorkingDirectory } from "@/lib/working-directories";

export const dynamic = "force-dynamic";

const SEARCH_ROOTS = [
  path.join(os.homedir(), "programming"),
  path.join(os.homedir(), "sondermind"),
  path.join(os.homedir(), "Desktop"),
];

type DirectoryChild = {
  name: string;
  path: string;
};

function listDirs(root: string, depth = 1): string[] {
  const results: string[] = [];
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = path.join(root, entry.name);
      results.push(full);
      if (depth > 1) results.push(...listDirs(full, depth - 1));
    }
  } catch {}
  return results;
}

function listChildDirs(root: string): DirectoryChild[] {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules")
      .map((entry) => ({ name: entry.name, path: path.join(root, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function browseRoots(recentDirs: string[]): DirectoryChild[] {
  const roots = [
    os.homedir(),
    ...SEARCH_ROOTS,
    ...recentDirs,
  ];
  const seen = new Set<string>();
  return roots
    .map((dir) => path.resolve(dir))
    .filter((dir) => {
      if (seen.has(dir)) return false;
      seen.add(dir);
      try {
        return fs.statSync(dir).isDirectory();
      } catch {
        return false;
      }
    })
    .map((dir) => ({ name: dir === os.homedir() ? "Home" : path.basename(dir) || dir, path: dir }));
}

function parentDir(dir: string): string | null {
  const parent = path.dirname(dir);
  return parent === dir ? null : parent;
}

export async function GET(req: Request) {
  const recentDirs = (await listWorkingDirectories()).map((entry) => entry.path);
  const url = new URL(req.url);
  const requested = url.searchParams.get("path");
  const roots = browseRoots(recentDirs);

  if (requested) {
    const current = path.resolve(requested);
    try {
      if (!fs.statSync(current).isDirectory()) {
        return NextResponse.json({ error: "path is not a directory" }, { status: 400 });
      }
    } catch {
      return NextResponse.json({ error: "directory not found" }, { status: 404 });
    }

    return NextResponse.json({
      current,
      parent: parentDir(current),
      children: listChildDirs(current),
      roots,
      recentDirs,
    });
  }

  const dirs: string[] = [...recentDirs];
  for (const root of SEARCH_ROOTS) {
    dirs.push(...listDirs(root, 2));
  }
  const seen = new Set<string>();
  const unique = dirs.filter((dir) => {
    if (seen.has(dir)) return false;
    seen.add(dir);
    return true;
  });
  const recentSet = new Set(recentDirs);
  const sorted = [
    ...unique.filter((dir) => recentSet.has(dir)),
    ...unique.filter((dir) => !recentSet.has(dir)).sort((a, b) => a.localeCompare(b)),
  ];
  return NextResponse.json({ dirs: sorted, recentDirs, roots });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { dir?: unknown } | null;
  if (!body || typeof body.dir !== "string" || !body.dir.trim()) {
    return NextResponse.json({ error: "dir is required" }, { status: 400 });
  }

  try {
    const entry = await recordWorkingDirectory(body.dir);
    const recentDirs = (await listWorkingDirectories()).map((item) => item.path);
    return NextResponse.json({ dir: entry.path, recentDirs });
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid directory";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
