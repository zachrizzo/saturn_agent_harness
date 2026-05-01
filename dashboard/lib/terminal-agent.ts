import { getSession, listSessions, type SessionMeta } from "./runs";
import type { StreamEvent } from "./events";
import { projectNameFromPath, type TerminalRecord } from "./terminal-types";

export type AgentBashTerminal = {
  record: TerminalRecord;
  output: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function terminalId(sessionId: string, toolUseId: string): string {
  return `agent-bash-${Buffer.from(`${sessionId}:${toolUseId}`).toString("base64url")}`;
}

function commandFromInput(input: unknown): string {
  if (typeof input === "string") return input;
  const rec = asRecord(input);
  for (const key of ["command", "cmd", "script"]) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return JSON.stringify(input ?? {}, null, 2);
}

function textFromValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const rec = asRecord(item);
        if (typeof rec.text === "string") return rec.text;
        if (typeof rec.content === "string") return rec.content;
        return textFromValue(item);
      })
      .filter(Boolean)
      .join("\n");
  }

  const rec = asRecord(value);
  for (const key of ["output", "stdout", "stderr", "aggregated_output", "aggregatedOutput", "content"]) {
    const nested = rec[key];
    if (nested !== undefined && nested !== null) {
      const text = textFromValue(nested);
      if (text) return text;
    }
  }
  return JSON.stringify(value, null, 2);
}

function isBashTool(ev: Extract<StreamEvent, { kind: "tool_use" }>): boolean {
  const name = ev.name.toLowerCase();
  if (name === "bash" || name.includes("bash")) return true;
  const raw = asRecord(ev.raw);
  const item = asRecord(raw.item);
  return item.type === "command_execution" || item.type === "commandExecution";
}

function markerTurnId(ev: StreamEvent): string | undefined {
  const raw = asRecord(ev.raw);
  if (raw.type !== "saturn.turn_start") return undefined;
  return typeof raw.turn_id === "string" ? raw.turn_id : undefined;
}

function turnForId(meta: SessionMeta, turnId: string | undefined) {
  if (!turnId) return undefined;
  return meta.turns.find((turn) => turn.turn_id === turnId);
}

function terminalTitle(command: string): string {
  const firstLine = command.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "Bash";
  return firstLine.length > 84 ? `${firstLine.slice(0, 81)}...` : firstLine;
}

function terminalText(command: string, result: unknown, running: boolean): string {
  const output = textFromValue(result);
  const prompt = `$ ${command.trim() || "(empty command)"}`;
  if (output) return `${prompt}\n${output}`;
  if (running) return `${prompt}\n`;
  return `${prompt}\n`;
}

export function collectAgentBashTerminalsFromSession(
  meta: SessionMeta,
  events: StreamEvent[],
): AgentBashTerminal[] {
  const results = new Map<string, { content: unknown; isError: boolean }>();
  for (const ev of events) {
    if (ev.kind === "tool_result") {
      results.set(ev.toolUseId, { content: ev.content, isError: ev.isError });
    }
  }

  const records: AgentBashTerminal[] = [];
  let currentTurnId: string | undefined;

  for (const ev of events) {
    currentTurnId = markerTurnId(ev) ?? currentTurnId;
    if (ev.kind !== "tool_use" || !isBashTool(ev)) continue;

    const command = commandFromInput(ev.input);
    const result = results.get(ev.id);
    const turn = turnForId(meta, currentTurnId);
    const running = !result && meta.status === "running";
    const status = !result ? (running ? "running" : "failed") : result.isError ? "failed" : "success";
    const cwd = meta.agent_snapshot?.cwd?.trim() || null;
    const createdAt = turn?.started_at ?? meta.started_at;
    const updatedAt = turn?.finished_at ?? (running ? new Date().toISOString() : meta.finished_at ?? createdAt);

    records.push({
      record: {
        id: terminalId(meta.session_id, ev.id),
        source: "agent-bash",
        readOnly: true,
        title: terminalTitle(command),
        projectPath: cwd,
        projectName: projectNameFromPath(cwd),
        cwd,
        status,
        createdAt,
        updatedAt,
        sessionId: meta.session_id,
        turnId: currentTurnId,
        toolUseId: ev.id,
        command,
        exitCode: null,
        isError: result?.isError ?? false,
      },
      output: terminalText(command, result?.content, running),
    });
  }

  return records;
}

export async function listAgentBashTerminals(): Promise<AgentBashTerminal[]> {
  const sessions = await listSessions();
  const terminals: AgentBashTerminal[] = [];
  for (const session of sessions) {
    const full = await getSession(session.session_id).catch(() => null);
    if (!full) continue;
    terminals.push(...collectAgentBashTerminalsFromSession(full.meta, full.events));
  }
  terminals.sort((a, b) => b.record.updatedAt.localeCompare(a.record.updatedAt));
  return terminals;
}

export async function getAgentBashTerminal(id: string): Promise<AgentBashTerminal | null> {
  const terminals = await listAgentBashTerminals();
  return terminals.find((terminal) => terminal.record.id === id) ?? null;
}
