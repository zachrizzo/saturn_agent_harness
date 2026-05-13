import { promises as fs } from "node:fs";
import path from "node:path";
import { coalesceAssistantTextDeltas, parseStreamJsonl, type StreamEvent } from "./events";
import { sessionDir, type SessionMeta } from "./runs";
import { withSessionMetaLock } from "./session-meta-lock";

type PidsRecord = {
  cli_pgid?: number;
  script_pid?: number;
  cli_pid?: number;
  turn_pid?: number;
};

type AbortSessionRunResult =
  | { ok: true; meta: SessionMeta; aborted: boolean }
  | { ok: false; status: number; error: string };

function rawRecord(ev: StreamEvent): Record<string, unknown> {
  return (ev.raw && typeof ev.raw === "object" ? ev.raw : {}) as Record<string, unknown>;
}

function parseRawLine(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function streamRecordsForTurn(streamRaw: string, turnId?: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const allLines = !turnId;
  let active = allLines;
  let found = allLines;

  for (const line of streamRaw.split("\n").filter(Boolean)) {
    const record = parseRawLine(line);
    if (!record) continue;

    const markerId =
      record.type === "saturn.turn_start" && typeof record.turn_id === "string"
        ? record.turn_id
        : undefined;
    if (markerId) {
      if (turnId && markerId === turnId) {
        active = true;
        found = true;
        records.push(record);
        continue;
      }
      if (turnId && active) break;
    }

    if (active) records.push(record);
  }

  return found ? records : [];
}

function turnIdOf(ev: StreamEvent): string | undefined {
  const raw = rawRecord(ev);
  return raw.type === "saturn.turn_start" && typeof raw.turn_id === "string"
    ? raw.turn_id
    : undefined;
}

function eventsForTurn(streamRaw: string, turnId?: string): StreamEvent[] {
  const events = parseStreamJsonl(streamRaw);
  let start = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const marker = turnIdOf(events[i]);
    if (marker && (!turnId || marker === turnId)) {
      start = i;
      break;
    }
  }

  const end = start >= 0
    ? events.findIndex((ev, idx) => idx > start && Boolean(turnIdOf(ev)))
    : -1;
  return events.slice(Math.max(0, start), end === -1 ? undefined : end);
}

function assistantTextForTurn(streamRaw: string, turnId?: string): string {
  return coalesceAssistantTextDeltas(eventsForTurn(streamRaw, turnId))
    .filter((ev): ev is Extract<StreamEvent, { kind: "assistant_text" }> => ev.kind === "assistant_text")
    .map((ev) => ev.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function compactJson(value: unknown, maxChars = 900): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
  }
  const trimmed = text.trim();
  return trimmed.length > maxChars
    ? `${trimmed.slice(0, maxChars)}\n...[${trimmed.length - maxChars} chars omitted]`
    : trimmed;
}

function interruptedSummaryForTurn(streamRaw: string, turnId?: string): string {
  const lines: string[] = [];
  const maxEntries = 18;
  for (const ev of eventsForTurn(streamRaw, turnId)) {
    if (lines.length >= maxEntries) break;
    if (ev.kind === "tool_use") {
      lines.push(`Tool call: ${ev.name}\nInput: ${compactJson(ev.input)}`);
    } else if (ev.kind === "tool_result") {
      lines.push(`Tool result: ${ev.toolUseId}${ev.isError ? " (error)" : ""}\n${compactJson(ev.content)}`);
    } else if (ev.kind === "todo_list") {
      const items = ev.items.map((item) => `${item.completed ? "[x]" : "[ ]"} ${item.text}`).join("\n");
      if (items.trim()) lines.push(`Todo list:\n${compactJson(items, 1200)}`);
    } else if (ev.kind === "result" && !ev.success) {
      lines.push(`Turn result: failed\n${compactJson(ev.raw, 1200)}`);
    }
  }

  if (lines.length === 0) return "";
  return [
    "Interrupted turn context captured before the user steered or stopped the reply.",
    ...lines,
  ].join("\n\n");
}

function nativeSessionIdForTurn(streamRaw: string, turnId?: string): string | undefined {
  let nativeSessionId: string | undefined;
  for (const record of streamRecordsForTurn(streamRaw, turnId)) {
    if (
      record.type === "system" &&
      record.subtype === "init" &&
      typeof record.session_id === "string" &&
      record.session_id.trim()
    ) {
      nativeSessionId = record.session_id;
    }
    if (
      record.type === "thread.started" &&
      typeof record.thread_id === "string" &&
      record.thread_id.trim()
    ) {
      nativeSessionId = record.thread_id;
    }
  }
  return nativeSessionId;
}

function abortedMarkerExists(streamRaw: string, turnId?: string): boolean {
  return streamRaw
    .split("\n")
    .filter(Boolean)
    .some((line) => {
      const obj = parseRawLine(line);
      return obj?.type === "saturn.turn_aborted" && (!turnId || obj.turn_id === turnId);
    });
}

function processIsLive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalPid(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try { process.kill(pid, signal); } catch {}
}

async function waitForExit(pid: number | undefined, timeoutMs = 1000): Promise<boolean> {
  if (!pid) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsLive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !processIsLive(pid);
}

async function terminateRunner(pids: PidsRecord): Promise<void> {
  const groupPid = pids.cli_pgid ? -Math.abs(pids.cli_pgid) : undefined;
  const directPids = [pids.script_pid, pids.cli_pid, pids.turn_pid];
  const targets = [groupPid, ...directPids];

  for (const pid of targets) signalPid(pid, "SIGTERM");
  const exited = await Promise.all(directPids.map((pid) => waitForExit(pid)));
  if (exited.every(Boolean)) return;

  for (const pid of targets) signalPid(pid, "SIGKILL");
  await Promise.all(directPids.map((pid) => waitForExit(pid, 1000)));
}

export async function abortSessionRun(sessionId: string): Promise<AbortSessionRunResult> {
  const dir = sessionDir(sessionId);
  const metaPath = path.join(dir, "meta.json");
  const rawMeta = await fs.readFile(metaPath, "utf8").catch(() => null);
  if (!rawMeta) return { ok: false, status: 404, error: "not found" };

  const pids = JSON.parse(await fs.readFile(path.join(dir, "pids.json"), "utf8").catch(() => "{}")) as PidsRecord;
  await terminateRunner(pids);

  let aborted = false;
  const meta = await withSessionMetaLock(sessionId, async () => {
    const latest = JSON.parse(await fs.readFile(metaPath, "utf8")) as SessionMeta;
    const lastTurn = latest.turns.at(-1);
    if (latest.status !== "running" && lastTurn?.status !== "running") return latest;

    const now = new Date().toISOString();
    const streamPath = path.join(dir, "stream.jsonl");
    const streamRaw = await fs.readFile(streamPath, "utf8").catch(() => "");
    const turnId = lastTurn?.turn_id;
    const partialAssistantText = assistantTextForTurn(streamRaw, turnId);
    const nativeSessionId = lastTurn?.cli_session_id ?? nativeSessionIdForTurn(streamRaw, turnId);
    const interruptedSummary = interruptedSummaryForTurn(streamRaw, turnId);

    latest.status = "failed";
    latest.finished_at = now;
    delete (latest as SessionMeta & { last_turn_started_at?: string }).last_turn_started_at;
    if (lastTurn?.status === "running") {
      aborted = true;
      lastTurn.status = "aborted";
      lastTurn.finished_at = now;
      if (nativeSessionId) lastTurn.cli_session_id = nativeSessionId;
      if (partialAssistantText) lastTurn.final_text = partialAssistantText;
      if (interruptedSummary) lastTurn.interrupted_summary = interruptedSummary;
    }
    if (!abortedMarkerExists(streamRaw, turnId)) {
      await fs.appendFile(
        streamPath,
        JSON.stringify({ type: "saturn.turn_aborted", session_id: sessionId, turn_id: turnId ?? null, aborted_at: now }) + "\n",
        "utf8",
      ).catch(() => {});
    }
    await fs.writeFile(metaPath, JSON.stringify(latest, null, 2), "utf8");
    return latest;
  });

  await fs.rm(path.join(dir, "pids.json"), { force: true }).catch(() => {});
  await fs.rm(path.join(dir, "turn.lock"), { force: true }).catch(() => {});
  return { ok: true, meta, aborted };
}
