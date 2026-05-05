import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { getSessionMeta, sessionDir, type SessionMeta } from "@/lib/runs";
import { parseStreamJsonl, type StreamEvent } from "@/lib/events";
import { withSessionMetaLock } from "@/lib/session-meta-lock";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function rawRecord(ev: StreamEvent): Record<string, unknown> {
  return (ev.raw && typeof ev.raw === "object" ? ev.raw : {}) as Record<string, unknown>;
}

function turnIdOf(ev: StreamEvent): string | undefined {
  const raw = rawRecord(ev);
  return raw.type === "saturn.turn_start" && typeof raw.turn_id === "string"
    ? raw.turn_id
    : undefined;
}

function assistantTextForTurn(streamRaw: string, turnId?: string): string {
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
  const turnEvents = events.slice(Math.max(0, start), end === -1 ? undefined : end);
  return turnEvents
    .filter((ev): ev is Extract<StreamEvent, { kind: "assistant_text" }> => ev.kind === "assistant_text")
    .map((ev) => ev.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function abortedMarkerExists(streamRaw: string, turnId?: string): boolean {
  return streamRaw
    .split("\n")
    .filter(Boolean)
    .some((line) => {
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        return obj.type === "saturn.turn_aborted" && (!turnId || obj.turn_id === turnId);
      } catch {
        return false;
      }
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

async function terminateRunner(pids: {
  cli_pgid?: number;
  script_pid?: number;
  cli_pid?: number;
  turn_pid?: number;
}): Promise<void> {
  const groupPid = pids.cli_pgid ? -Math.abs(pids.cli_pgid) : undefined;
  const directPids = [pids.script_pid, pids.cli_pid, pids.turn_pid];
  const targets = [groupPid, ...directPids];

  for (const pid of targets) signalPid(pid, "SIGTERM");
  const exited = await Promise.all(directPids.map((pid) => waitForExit(pid)));
  if (exited.every(Boolean)) return;

  for (const pid of targets) signalPid(pid, "SIGKILL");
  await Promise.all(directPids.map((pid) => waitForExit(pid, 1000)));
}

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const meta = await getSessionMeta(id);
  if (!meta) return NextResponse.json({ error: "not found" }, { status: 404 });

  const dir = sessionDir(id);
  const pids = JSON.parse(await fs.readFile(path.join(dir, "pids.json"), "utf8").catch(() => "{}")) as {
    cli_pgid?: number;
    script_pid?: number;
    cli_pid?: number;
    turn_pid?: number;
  };
  await terminateRunner(pids);

  await withSessionMetaLock(id, async () => {
    const metaPath = path.join(dir, "meta.json");
    const latest = JSON.parse(await fs.readFile(metaPath, "utf8")) as SessionMeta;
    const lastTurn = latest.turns.at(-1);
    if (latest.status !== "running" && lastTurn?.status !== "running") return;

    const now = new Date().toISOString();
    const streamPath = path.join(dir, "stream.jsonl");
    const streamRaw = await fs.readFile(streamPath, "utf8").catch(() => "");
    const turnId = lastTurn?.turn_id;
    const partialAssistantText = assistantTextForTurn(streamRaw, turnId);

    latest.status = "failed";
    latest.finished_at = now;
    delete (latest as SessionMeta & { last_turn_started_at?: string }).last_turn_started_at;
    if (lastTurn?.status === "running") {
      lastTurn.status = "aborted";
      lastTurn.finished_at = now;
      if (partialAssistantText) lastTurn.final_text = partialAssistantText;
    }
    if (!abortedMarkerExists(streamRaw, turnId)) {
      await fs.appendFile(
        streamPath,
        JSON.stringify({ type: "saturn.turn_aborted", session_id: id, turn_id: turnId ?? null, aborted_at: now }) + "\n",
        "utf8",
      ).catch(() => {});
    }
    await fs.writeFile(metaPath, JSON.stringify(latest, null, 2), "utf8");
  });
  await fs.rm(path.join(dir, "pids.json"), { force: true }).catch(() => {});
  await fs.rm(path.join(dir, "turn.lock"), { force: true }).catch(() => {});
  return NextResponse.json({ ok: true });
}
