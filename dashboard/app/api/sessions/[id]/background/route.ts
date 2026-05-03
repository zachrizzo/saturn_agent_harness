import { randomUUID } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import { NextResponse } from "next/server";
import { sessionsRoot } from "@/lib/paths";
import type { SessionMeta } from "@/lib/runs";

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

  let parentMeta: SessionMeta;
  try {
    parentMeta = JSON.parse(await fs.readFile(parentMetaFile, "utf8")) as SessionMeta;
  } catch {
    return NextResponse.json({ error: `session not found: ${parentId}` }, { status: 404 });
  }

  if (parentMeta.status !== "running") {
    return NextResponse.json({ error: "session is not running" }, { status: 409 });
  }

  const cutoff = completedTurnCutoff(parentMeta);
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

  const carriedStream = await carriedStreamForTurns(parentId, cutoff);
  await fs.mkdir(continuationDir, { recursive: true });
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
