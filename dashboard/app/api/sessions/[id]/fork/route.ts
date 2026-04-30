// POST /api/sessions/[id]/fork { at_turn?, message }
// Creates a new session seeded with the parent session's transcript up to
// at_turn (default: all turns). The fork starts a new conversation by sending
// `message` as the first user turn, with prior turns replayed as context.

import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { sessionsRoot } from "@/lib/paths";
import { spawnTurn } from "@/lib/turn";
import type { SessionMeta } from "@/lib/runs";
import { DEFAULT_CLI, normalizeCli } from "@/lib/clis";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: parentId } = await params;
  const { at_turn, message } = (await req.json().catch(() => ({}))) as {
    at_turn?: number;
    message?: string;
  };

  if (!message?.trim()) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }

  const parentMetaFile = path.join(sessionsRoot(), parentId, "meta.json");
  let parentMeta: SessionMeta;
  try {
    parentMeta = JSON.parse(await fs.readFile(parentMetaFile, "utf8")) as SessionMeta;
  } catch {
    return NextResponse.json({ error: `parent session not found: ${parentId}` }, { status: 404 });
  }

  // How many parent turns to carry forward. Default: all.
  const cutoff =
    typeof at_turn === "number" && at_turn >= 0 && at_turn <= parentMeta.turns.length
      ? at_turn
      : parentMeta.turns.length;
  const carriedTurns = parentMeta.turns.slice(0, cutoff);

  const forkId = randomUUID();
  const forkDir = path.join(sessionsRoot(), forkId);
  await fs.mkdir(forkDir, { recursive: true });

  const forkMeta: SessionMeta = {
    session_id: forkId,
    agent_id: parentMeta.agent_id,
    agent_snapshot: parentMeta.agent_snapshot,
    started_at: new Date().toISOString(),
    status: "running",
    turns: carriedTurns,
    forked_from: { session_id: parentId, at_turn: cutoff },
  };
  if (parentMeta.overrides) forkMeta.overrides = parentMeta.overrides;

  await fs.writeFile(
    path.join(forkDir, "meta.json"),
    JSON.stringify(forkMeta, null, 2),
    "utf8",
  );

  // Copy parent's stream.jsonl events for the first `cutoff` completed turns,
  // so the transcript (assistant replies, tool calls) is visible in the fork.
  // Each completed turn ends with a single `"type":"result"` event.
  let carriedStream = "";
  try {
    const parentStream = await fs.readFile(
      path.join(sessionsRoot(), parentId, "stream.jsonl"),
      "utf8",
    );
    if (cutoff > 0) {
      const lines = parentStream.split("\n");
      let resultsSeen = 0;
      const keep: string[] = [];
      for (const line of lines) {
        if (!line) continue;
        keep.push(line);
        // cheap detection — matches `"type":"result"` in the compact JSONL
        if (/"type"\s*:\s*"result"/.test(line)) {
          resultsSeen++;
          if (resultsSeen >= cutoff) break;
        }
      }
      carriedStream = keep.join("\n") + (keep.length > 0 ? "\n" : "");
    }
  } catch {
    // parent stream missing — fork starts with empty transcript
  }
  await fs.writeFile(path.join(forkDir, "stream.jsonl"), carriedStream, "utf8");

  // Use last carried turn's cli/model as defaults for the first fork turn.
  const last = carriedTurns[carriedTurns.length - 1];
  const cli = normalizeCli(last?.cli ?? parentMeta.agent_snapshot?.cli ?? DEFAULT_CLI);
  const model = last?.model ?? parentMeta.agent_snapshot?.model;
  const reasoningEffort =
    last?.reasoningEffort ??
    parentMeta.agent_snapshot?.reasoningEfforts?.[cli] ??
    parentMeta.agent_snapshot?.reasoningEffort;

  await spawnTurn(forkId, cli, model, message, parentMeta.agent_snapshot, undefined, reasoningEffort);

  return NextResponse.json({
    session_id: forkId,
    forked_from: { session_id: parentId, at_turn: cutoff },
  });
}
