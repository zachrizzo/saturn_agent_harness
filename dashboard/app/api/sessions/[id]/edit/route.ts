// POST /api/sessions/[id]/edit { at_turn, message }
// Truncates the session to `at_turn` turns in place, then sends `message` as
// the next turn in the same session (backtrack without forking).

import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { promises as fs } from "node:fs";
import { sessionsRoot } from "@/lib/paths";
import { spawnTurn } from "@/lib/turn";
import { acquireSessionTurnLock } from "@/lib/session-turn-lock";
import type { SessionMeta } from "@/lib/runs";
import { DEFAULT_CLI, normalizeCli } from "@/lib/clis";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { at_turn, message } = (await req.json().catch(() => ({}))) as {
    at_turn?: number;
    message?: string;
  };

  if (!message?.trim()) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }

  const metaFile = path.join(sessionsRoot(), id, "meta.json");
  let meta: SessionMeta;
  try {
    meta = JSON.parse(await fs.readFile(metaFile, "utf8")) as SessionMeta;
  } catch {
    return NextResponse.json({ error: `session not found: ${id}` }, { status: 404 });
  }

  if (meta.status === "running") {
    return NextResponse.json({ error: "previous turn still running" }, { status: 409 });
  }

  const lock = await acquireSessionTurnLock(id);
  if (!lock.ok) {
    return NextResponse.json({ error: "previous turn still running" }, { status: 409 });
  }

  const cutoff =
    typeof at_turn === "number" && at_turn >= 0 && at_turn <= meta.turns.length
      ? at_turn
      : meta.turns.length;

  // Truncate turns in meta
  meta.turns = meta.turns.slice(0, cutoff);
  meta.status = "running";
  await fs.writeFile(metaFile, JSON.stringify(meta, null, 2), "utf8");

  // Truncate stream.jsonl to only include events for the first `cutoff` completed turns
  const streamFile = path.join(sessionsRoot(), id, "stream.jsonl");
  try {
    const existing = await fs.readFile(streamFile, "utf8");
    if (cutoff === 0) {
      await fs.writeFile(streamFile, "", "utf8");
    } else {
      const lines = existing.split("\n");
      let resultsSeen = 0;
      const keep: string[] = [];
      for (const line of lines) {
        if (!line) continue;
        keep.push(line);
        if (/"type"\s*:\s*"result"/.test(line)) {
          resultsSeen++;
          if (resultsSeen >= cutoff) break;
        }
      }
      await fs.writeFile(streamFile, keep.join("\n") + (keep.length > 0 ? "\n" : ""), "utf8");
    }
  } catch {
    // stream missing — nothing to truncate
  }

  const last = meta.turns[meta.turns.length - 1];
  const snap = meta.agent_snapshot;
  const cli = normalizeCli(last?.cli ?? snap?.defaultCli ?? snap?.cli ?? DEFAULT_CLI);
  const model = last?.model ?? snap?.models?.[cli] ?? snap?.model;
  const reasoningEffort =
    last?.reasoningEffort ??
    snap?.reasoningEfforts?.[cli] ??
    snap?.reasoningEffort;

  try {
    await spawnTurn(id, cli, model, message, snap, undefined, reasoningEffort);
  } catch (err) {
    await lock.release();
    throw err;
  }

  return NextResponse.json({ ok: true });
}
