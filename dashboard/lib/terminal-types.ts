export type TerminalSource = "pty" | "agent-bash";

export type TerminalStatus = "running" | "success" | "failed";

export type TerminalRecord = {
  id: string;
  source: TerminalSource;
  readOnly: boolean;
  title: string;
  projectPath: string | null;
  projectName: string | null;
  cwd: string | null;
  status: TerminalStatus;
  createdAt: string;
  updatedAt: string;
  sessionId?: string;
  turnId?: string;
  toolUseId?: string;
  command?: string;
  exitCode?: number | null;
  isError?: boolean;
  pid?: number;
  cols?: number;
  rows?: number;
};

export type TerminalGroup = {
  key: string;
  label: string;
  projectPath: string | null;
  terminals: TerminalRecord[];
};

export type TerminalProject = {
  path: string;
  label: string;
  lastUsedAt: string;
  terminalCount: number;
  runningCount: number;
};

export type TerminalListResponse = {
  terminals: TerminalRecord[];
  groups: TerminalGroup[];
  projects: TerminalProject[];
  defaultCwd: string | null;
  totalTerminalCount?: number;
  filteredTerminalCount?: number;
};

export function projectNameFromPath(cwd: string | null | undefined): string | null {
  const normalized = cwd?.trim().replace(/\\/g, "/");
  if (!normalized) return null;
  const parts = normalized.split("/").filter(Boolean);
  return parts.at(-1) ?? normalized;
}

export function formatProjectLabel(name: string | null | undefined): string {
  if (!name) return "No project";
  const segment = name.includes("/") ? name.split("/").filter(Boolean).pop() ?? name : name;
  return segment.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function groupTerminalRecords(terminals: TerminalRecord[]): TerminalGroup[] {
  const groups: TerminalGroup[] = [];
  const byKey = new Map<string, TerminalGroup>();

  for (const terminal of terminals) {
    const key = terminal.projectPath || terminal.projectName || "__no_project__";
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        label: formatProjectLabel(terminal.projectName),
        projectPath: terminal.projectPath,
        terminals: [],
      };
      byKey.set(key, group);
      groups.push(group);
    }
    group.terminals.push(terminal);
  }

  return groups;
}
