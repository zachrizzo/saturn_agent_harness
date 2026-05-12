import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

let cacheLoaded = false;
let cached: string | undefined;

async function isExecutable(file: string): Promise<boolean> {
  try {
    await fs.access(file, fsConstants.X_OK);
    const stat = await fs.stat(file);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function nodeVersionBinCandidates(home: string): Promise<string[]> {
  const root = path.join(home, ".nvm", "versions", "node");
  try {
    const versions = await fs.readdir(root);
    return versions.map((version) => path.join(root, version, "bin", "claude"));
  } catch {
    return [];
  }
}

async function candidates(): Promise<string[]> {
  const home = os.homedir();
  const pathCandidates = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, "claude"));

  return [
    process.env.CLAUDE_CODE_PATH,
    process.env.CLAUDE_CODE_EXECUTABLE,
    process.env.CLAUDE_PATH,
    ...pathCandidates,
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    path.join(home, ".local", "bin", "claude"),
    path.join(home, "bin", "claude"),
    path.join(home, ".npm-global", "bin", "claude"),
    path.join(home, ".volta", "bin", "claude"),
    path.join(home, ".bun", "bin", "claude"),
    path.join(home, ".asdf", "shims", "claude"),
    ...(await nodeVersionBinCandidates(home)),
  ].filter((item): item is string => Boolean(item));
}

export async function resolveClaudeExecutable(): Promise<string | undefined> {
  if (cacheLoaded) return cached;
  for (const candidate of await candidates()) {
    if (await isExecutable(candidate)) {
      cached = candidate;
      cacheLoaded = true;
      return candidate;
    }
  }
  cached = undefined;
  cacheLoaded = true;
  return undefined;
}
