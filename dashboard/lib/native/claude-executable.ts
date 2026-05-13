import { constants as fsConstants, promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

let cacheLoaded = false;
let cached: string | undefined;

const execFileAsync = promisify(execFile);

type Version = {
  major: number;
  minor: number;
  patch: number;
};

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

function explicitCandidates(): string[] {
  return [
    process.env.CLAUDE_CODE_PATH,
    process.env.CLAUDE_CODE_EXECUTABLE,
    process.env.CLAUDE_PATH,
  ].filter((item): item is string => Boolean(item));
}

async function candidates(): Promise<string[]> {
  const home = os.homedir();
  const pathCandidates = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((dir) => path.join(dir, "claude"));

  return [
    ...pathCandidates,
    path.join(home, ".local", "bin", "claude"),
    path.join(home, "bin", "claude"),
    path.join(home, ".npm-global", "bin", "claude"),
    path.join(home, ".volta", "bin", "claude"),
    path.join(home, ".bun", "bin", "claude"),
    path.join(home, ".asdf", "shims", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    ...(await nodeVersionBinCandidates(home)),
  ].filter((item): item is string => Boolean(item));
}

function parseVersion(output: string): Version | undefined {
  const match = output.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

function compareVersions(a: Version | undefined, b: Version | undefined): number {
  if (a && !b) return 1;
  if (!a && b) return -1;
  if (!a || !b) return 0;
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

async function claudeVersion(file: string): Promise<Version | undefined> {
  try {
    const { stdout, stderr } = await execFileAsync(file, ["--version"], {
      timeout: 1_500,
      maxBuffer: 8 * 1024,
    });
    return parseVersion(`${stdout}${stderr}`);
  } catch {
    return undefined;
  }
}

async function bestVersionedCandidate(paths: string[]): Promise<string | undefined> {
  const seen = new Set<string>();
  const executablePaths: string[] = [];
  for (const candidate of paths) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (await isExecutable(candidate)) executablePaths.push(candidate);
  }

  let best = executablePaths[0];
  let bestVersion = best ? await claudeVersion(best) : undefined;
  for (const candidate of executablePaths.slice(1)) {
    const version = await claudeVersion(candidate);
    if (compareVersions(version, bestVersion) > 0) {
      best = candidate;
      bestVersion = version;
    }
  }
  return best;
}

export async function resolveClaudeExecutable(): Promise<string | undefined> {
  if (cacheLoaded) return cached;

  for (const candidate of explicitCandidates()) {
    if (await isExecutable(candidate)) {
      cached = candidate;
      cacheLoaded = true;
      return candidate;
    }
  }

  cached = await bestVersionedCandidate(await candidates());
  cacheLoaded = true;
  return cached;
}
