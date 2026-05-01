import { readAppSettings } from "./settings";
import { listAgentBashTerminals } from "./terminal-agent";
import { listPtyTerminals } from "./terminal-pty";
import {
  formatProjectLabel,
  groupTerminalRecords,
  projectNameFromPath,
  type TerminalListResponse,
  type TerminalProject,
  type TerminalRecord,
} from "./terminal-types";
import { listWorkingDirectories } from "./working-directories";

export type ListAllTerminalsOptions = {
  sessionId?: string;
};

function projectKey(path: string | null | undefined): string | null {
  const cleaned = path?.trim();
  return cleaned || null;
}

function buildProjects(
  directories: Awaited<ReturnType<typeof listWorkingDirectories>>,
  terminals: TerminalRecord[],
): TerminalProject[] {
  const counts = new Map<string, { terminalCount: number; runningCount: number; lastUsedAt: string }>();
  for (const terminal of terminals) {
    const key = projectKey(terminal.projectPath ?? terminal.cwd);
    if (!key) continue;
    const current = counts.get(key) ?? { terminalCount: 0, runningCount: 0, lastUsedAt: "" };
    current.terminalCount += 1;
    if (terminal.status === "running") current.runningCount += 1;
    if (terminal.updatedAt > current.lastUsedAt) current.lastUsedAt = terminal.updatedAt;
    counts.set(key, current);
  }

  const projects = new Map<string, TerminalProject>();
  for (const entry of directories) {
    const key = projectKey(entry.path);
    if (!key) continue;
    const count = counts.get(key);
    projects.set(key, {
      path: key,
      label: formatProjectLabel(projectNameFromPath(key)),
      lastUsedAt: entry.last_used_at || count?.lastUsedAt || "",
      terminalCount: count?.terminalCount ?? 0,
      runningCount: count?.runningCount ?? 0,
    });
  }

  for (const [key, count] of counts) {
    if (projects.has(key)) continue;
    projects.set(key, {
      path: key,
      label: formatProjectLabel(projectNameFromPath(key)),
      lastUsedAt: count.lastUsedAt,
      terminalCount: count.terminalCount,
      runningCount: count.runningCount,
    });
  }

  return [...projects.values()].sort((a, b) => {
    const time = b.lastUsedAt.localeCompare(a.lastUsedAt);
    if (time !== 0) return time;
    return a.label.localeCompare(b.label);
  });
}

export async function listAllTerminals(options: ListAllTerminalsOptions = {}): Promise<TerminalListResponse> {
  const [settings, agentBash, directories] = await Promise.all([
    readAppSettings().catch(() => null),
    listAgentBashTerminals(),
    listWorkingDirectories({ limit: null }).catch(() => []),
  ]);
  const allTerminals = [
    ...listPtyTerminals(),
    ...agentBash.map((terminal) => terminal.record),
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const sessionId = options.sessionId?.trim();
  const terminals = sessionId
    ? allTerminals.filter((terminal) => terminal.sessionId === sessionId)
    : allTerminals;

  return {
    terminals,
    groups: groupTerminalRecords(terminals),
    projects: sessionId ? buildProjects([], terminals) : buildProjects(directories, allTerminals),
    defaultCwd: settings?.defaultCwd ?? null,
  };
}
