import path from "node:path";
import { promises as fs } from "node:fs";
import { workingDirectoriesFile } from "./paths";
import { listAgents, listJobs, listSessions } from "./runs";

export type WorkingDirectoryEntry = {
  path: string;
  last_used_at: string;
};

const MAX_RECENTS = 75;

function expandHome(dir: string): string {
  if (dir === "~") return process.env.HOME ?? dir;
  if (dir.startsWith("~/")) return path.join(process.env.HOME ?? "", dir.slice(2));
  return dir;
}

export function normalizeWorkingDirectory(dir: string): string {
  return path.resolve(expandHome(dir.trim()));
}

async function readStoredWorkingDirectories(): Promise<WorkingDirectoryEntry[]> {
  try {
    const raw = await fs.readFile(workingDirectoriesFile(), "utf8");
    const parsed = JSON.parse(raw) as { directories?: WorkingDirectoryEntry[] };
    return (parsed.directories ?? [])
      .filter((entry) => entry && typeof entry.path === "string")
      .map((entry) => ({
        path: normalizeWorkingDirectory(entry.path),
        last_used_at: typeof entry.last_used_at === "string" ? entry.last_used_at : "",
      }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    return [];
  }
}

async function writeStoredWorkingDirectories(entries: WorkingDirectoryEntry[]): Promise<void> {
  await fs.writeFile(
    workingDirectoriesFile(),
    JSON.stringify({ directories: entries.slice(0, MAX_RECENTS) }, null, 2),
    "utf8",
  );
}

export async function assertWorkingDirectory(dir: string): Promise<string> {
  const normalized = normalizeWorkingDirectory(dir);
  const stat = await fs.stat(normalized).catch(() => null);
  if (!stat?.isDirectory()) {
    throw new Error(`Working directory does not exist: ${normalized}`);
  }
  return normalized;
}

export async function recordWorkingDirectory(dir: string): Promise<WorkingDirectoryEntry> {
  const normalized = await assertWorkingDirectory(dir);
  const entry = { path: normalized, last_used_at: new Date().toISOString() };
  const current = await readStoredWorkingDirectories();
  const next = [
    entry,
    ...current.filter((item) => item.path !== normalized),
  ];
  await writeStoredWorkingDirectories(next);
  return entry;
}

export async function listWorkingDirectories(): Promise<WorkingDirectoryEntry[]> {
  const stored = await readStoredWorkingDirectories();
  const entries = new Map<string, WorkingDirectoryEntry>();

  for (const entry of stored) {
    if (!entries.has(entry.path)) entries.set(entry.path, entry);
  }

  const sessions = await listSessions().catch(() => []);
  for (const session of sessions) {
    const cwd = session.agent_snapshot?.cwd;
    if (!cwd) continue;
    const normalized = normalizeWorkingDirectory(cwd);
    if (!entries.has(normalized)) {
      entries.set(normalized, {
        path: normalized,
        last_used_at: session.started_at,
      });
    }
  }

  const [agents, jobs] = await Promise.all([
    listAgents().catch(() => []),
    listJobs().catch(() => []),
  ]);

  for (const agent of agents) {
    if (!agent.cwd) continue;
    const normalized = normalizeWorkingDirectory(agent.cwd);
    if (!entries.has(normalized)) {
      entries.set(normalized, {
        path: normalized,
        last_used_at: agent.updated_at ?? agent.created_at,
      });
    }
  }

  for (const job of jobs) {
    if (!job.cwd) continue;
    const normalized = normalizeWorkingDirectory(job.cwd);
    if (!entries.has(normalized)) {
      entries.set(normalized, { path: normalized, last_used_at: "" });
    }
  }

  return [...entries.values()]
    .filter((entry) => entry.path)
    .sort((a, b) => b.last_used_at.localeCompare(a.last_used_at))
    .slice(0, MAX_RECENTS);
}
