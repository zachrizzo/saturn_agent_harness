import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import * as pty from "node-pty";
import { assertWorkingDirectory } from "./working-directories";
import { projectNameFromPath, type TerminalRecord } from "./terminal-types";

const MAX_REPLAY_CHARS = 500_000;
const require = createRequire(import.meta.url);
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 28;

type ListenerEvent =
  | { type: "data"; data: string }
  | { type: "meta"; terminal: TerminalRecord }
  | { type: "end"; terminal: TerminalRecord };

type TerminalEntry = {
  record: TerminalRecord;
  proc: pty.IPty;
  buffer: string;
  listeners: Set<(event: ListenerEvent) => void>;
};

type TerminalRegistry = {
  terminals: Map<string, TerminalEntry>;
};

declare global {
  // eslint-disable-next-line no-var
  var __saturnTerminalRegistry: TerminalRegistry | undefined;
}

function registry(): TerminalRegistry {
  globalThis.__saturnTerminalRegistry ??= { terminals: new Map() };
  return globalThis.__saturnTerminalRegistry;
}

function trimReplay(buffer: string): string {
  if (buffer.length <= MAX_REPLAY_CHARS) return buffer;
  return buffer.slice(buffer.length - MAX_REPLAY_CHARS);
}

function clampDimension(value: number | undefined, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, parsed));
}

function emit(entry: TerminalEntry, event: ListenerEvent): void {
  for (const listener of entry.listeners) {
    try {
      listener(event);
    } catch {
      /* best effort */
    }
  }
}

function shellName(shell: string): string {
  return path.basename(shell) || "shell";
}

function ptyEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  return env;
}

async function ensureNodePtyHelperExecutable(): Promise<void> {
  try {
    const packagePath = require.resolve("node-pty/package.json");
    const helperPath = path.join(
      path.dirname(packagePath),
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper",
    );
    await fs.chmod(helperPath, 0o755);
  } catch {
    // node-pty will surface a precise spawn error if the helper is unavailable.
  }
}

export type StartPtyTerminalInput = {
  cwd: string;
  cols?: number;
  rows?: number;
  title?: string;
  sessionId?: string;
};

export async function startPtyTerminal(input: StartPtyTerminalInput): Promise<TerminalRecord> {
  const cwd = await assertWorkingDirectory(input.cwd);
  const shell = process.env.SHELL || "/bin/zsh";
  const cols = clampDimension(input.cols, DEFAULT_COLS, 20, 240);
  const rows = clampDimension(input.rows, DEFAULT_ROWS, 8, 80);
  const now = new Date().toISOString();
  const id = `pty-${randomUUID()}`;
  await ensureNodePtyHelperExecutable();
  const proc = pty.spawn(shell, [], {
    name: "xterm-256color",
    cols,
    rows,
    cwd,
    env: ptyEnv(),
  });

  const record: TerminalRecord = {
    id,
    source: "pty",
    readOnly: false,
    title: input.title?.trim() || shellName(shell),
    projectPath: cwd,
    projectName: projectNameFromPath(cwd),
    cwd,
    status: "running",
    createdAt: now,
    updatedAt: now,
    exitCode: null,
    pid: proc.pid,
    cols,
    rows,
    sessionId: input.sessionId?.trim() || undefined,
  };

  const entry: TerminalEntry = {
    record,
    proc,
    buffer: "",
    listeners: new Set(),
  };
  registry().terminals.set(id, entry);

  proc.onData((data) => {
    entry.buffer = trimReplay(entry.buffer + data);
    entry.record.updatedAt = new Date().toISOString();
    emit(entry, { type: "data", data });
  });

  proc.onExit(({ exitCode }) => {
    entry.record.status = exitCode === 0 ? "success" : "failed";
    entry.record.exitCode = exitCode;
    entry.record.updatedAt = new Date().toISOString();
    emit(entry, { type: "meta", terminal: entry.record });
    emit(entry, { type: "end", terminal: entry.record });
  });

  return record;
}

export function listPtyTerminals(): TerminalRecord[] {
  return [...registry().terminals.values()]
    .map((entry) => entry.record)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getPtyTerminal(id: string): TerminalRecord | null {
  return registry().terminals.get(id)?.record ?? null;
}

export function getPtyReplay(id: string): string | null {
  const entry = registry().terminals.get(id);
  return entry ? entry.buffer : null;
}

export function writePtyTerminal(id: string, data: string): TerminalRecord | null {
  const entry = registry().terminals.get(id);
  if (!entry) return null;
  if (entry.record.status !== "running") return entry.record;
  entry.proc.write(data);
  entry.record.updatedAt = new Date().toISOString();
  return entry.record;
}

export function resizePtyTerminal(id: string, cols: number, rows: number): TerminalRecord | null {
  const entry = registry().terminals.get(id);
  if (!entry) return null;
  if (entry.record.status === "running") {
    const nextCols = clampDimension(cols, entry.record.cols ?? DEFAULT_COLS, 20, 240);
    const nextRows = clampDimension(rows, entry.record.rows ?? DEFAULT_ROWS, 8, 80);
    entry.proc.resize(nextCols, nextRows);
    entry.record.cols = nextCols;
    entry.record.rows = nextRows;
    entry.record.updatedAt = new Date().toISOString();
    emit(entry, { type: "meta", terminal: entry.record });
  }
  return entry.record;
}

export function deletePtyTerminal(id: string): TerminalRecord | null {
  const entry = registry().terminals.get(id);
  if (!entry) return null;
  registry().terminals.delete(id);
  if (entry.record.status === "running") {
    try {
      entry.proc.kill();
    } catch {
      /* already gone */
    }
    entry.record.status = "failed";
    entry.record.updatedAt = new Date().toISOString();
    emit(entry, { type: "end", terminal: entry.record });
  }
  return entry.record;
}

export function subscribePtyTerminal(
  id: string,
  listener: (event: ListenerEvent) => void,
): (() => void) | null {
  const entry = registry().terminals.get(id);
  if (!entry) return null;
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
  };
}
