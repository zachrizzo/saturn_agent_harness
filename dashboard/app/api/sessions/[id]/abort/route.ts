import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { getSessionMeta, sessionDir, type SessionMeta } from "@/lib/runs";
import { parseStreamJsonl, type StreamEvent } from "@/lib/events";

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

async function waitForExit(pid: number | undefined, timeoutMs = 1000): Promise<void> {
  if (!pid) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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
  };
  for (const pid of [pids.cli_pgid ? -Math.abs(pids.cli_pgid) : undefined, pids.script_pid, pids.cli_pid]) {
    if (!pid) continue;
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  await waitForExit(pids.script_pid);

  const metaPath = path.join(dir, "meta.json");
  const now = new Date().toISOString();
  const lastTurn = meta.turns.at(-1);
  const streamPath = path.join(dir, "stream.jsonl");
  const streamRaw = await fs.readFile(streamPath, "utf8").catch(() => "");
  const turnId = lastTurn?.turn_id;
  const partialAssistantText = assistantTextForTurn(streamRaw, turnId);

  meta.status = "failed";
  meta.finished_at = now;
  delete (meta as SessionMeta & { last_turn_started_at?: string }).last_turn_started_at;
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
  await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");
  return NextResponse.json({ ok: true });
}
