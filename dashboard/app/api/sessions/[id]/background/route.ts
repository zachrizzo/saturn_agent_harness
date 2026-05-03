import { randomUUID } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";
import { sessionsRoot } from "@/lib/paths";
import type { SessionMeta } from "@/lib/runs";
import { withSessionMetaLock } from "@/lib/session-meta-lock";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function lineEndsTurn(line: string): boolean {
  return /"type"\s*:\s*"(result|turn\.completed|step_finish|turn\.failed|saturn\.turn_aborted)"/.test(line);
}

function completedTurnCutoff(meta: SessionMeta): number {
  if (meta.turns.length === 0) return 0;
  const runningIndex = meta.turns.findIndex((turn) => turn.status === "running");
  if (runningIndex >= 0) return runningIndex;
  if (meta.status === "running") return Math.max(0, meta.turns.length - 1);
  return meta.turns.length;
}

async function carriedStreamForTurns(parentId: string, cutoff: number): Promise<string> {
  if (cutoff <= 0) return "";
  try {
    const parentStream = await fs.readFile(
      path.join(sessionsRoot(), parentId, "stream.jsonl"),
      "utf8",
    );
    const keep: string[] = [];
    let resultsSeen = 0;
    for (const line of parentStream.split("\n")) {
      if (!line) continue;
      keep.push(line);
      if (lineEndsTurn(line)) {
        resultsSeen++;
        if (resultsSeen >= cutoff) break;
      }
    }
    return keep.length > 0 ? `${keep.join("\n")}\n` : "";
  } catch {
    return "";
  }
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: parentId } = await params;
  const parentMetaFile = path.join(sessionsRoot(), parentId, "meta.json");

  // Coordinate with run-turn.sh writes to the parent's meta.json. Without the
  // lock, we can read a snapshot that's about to be invalidated by the parent
  // turn finishing, and the continuation is then seeded from a stale view.
  type Snapshot =
    | { ok: true; meta: SessionMeta; cutoff: number; carriedStream: string }
    | { ok: false; status: number; error: string };

  const snapshot: Snapshot = await withSessionMetaLock(parentId, async () => {
    let meta: SessionMeta;
    try {
      meta = JSON.parse(await fs.readFile(parentMetaFile, "utf8")) as SessionMeta;
    } catch {
      return { ok: false, status: 404, error: `session not found: ${parentId}` };
    }
    if (meta.status !== "running") {
      return { ok: false, status: 409, error: "session is not running" };
    }
    const c = completedTurnCutoff(meta);
    const stream = await carriedStreamForTurns(parentId, c);
    return { ok: true, meta, cutoff: c, carriedStream: stream };
  });

  if (!snapshot.ok) {
    return NextResponse.json({ error: snapshot.error }, { status: snapshot.status });
  }

  const { meta: parentMeta, cutoff, carriedStream } = snapshot;
  const carriedTurns = parentMeta.turns.slice(0, cutoff);
  const continuationId = randomUUID();
  const continuationDir = path.join(sessionsRoot(), continuationId);
  const now = new Date().toISOString();

  const continuationMeta: SessionMeta = {
    session_id: continuationId,
    agent_id: parentMeta.agent_id,
    agent_snapshot: parentMeta.agent_snapshot,
    started_at: now,
    status: carriedTurns.length > 0 ? "success" : "idle",
    turns: carriedTurns,
    forked_from: { session_id: parentId, at_turn: cutoff },
    read_at: now,
  };

  if (parentMeta.overrides) continuationMeta.overrides = parentMeta.overrides;
  if (parentMeta.plan_mode && cutoff === parentMeta.turns.length) {
    continuationMeta.plan_mode = parentMeta.plan_mode;
  }

  await fs.mkdir(continuationDir, { recursive: true });
  // The continuation has its own session id, so its meta.json doesn't share
  // a writer with the parent — no lock needed for these writes themselves.
  await fs.writeFile(
    path.join(continuationDir, "meta.json"),
    JSON.stringify(continuationMeta, null, 2),
    "utf8",
  );
  await fs.writeFile(path.join(continuationDir, "stream.jsonl"), carriedStream, "utf8");
  await fs.writeFile(path.join(continuationDir, "stderr.log"), "", "utf8");

  return NextResponse.json({
    session_id: continuationId,
    background_session_id: parentId,
    forked_from: { session_id: parentId, at_turn: cutoff },
  });
}
