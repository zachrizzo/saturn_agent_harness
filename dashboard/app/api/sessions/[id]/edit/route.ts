// POST /api/sessions/[id]/edit { at_turn, message }
// Truncates the session to `at_turn` turns in place, then sends `message` as
// the next turn in the same session (backtrack without forking).

import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { promises as fs } from "node:fs";
import { sessionsRoot } from "@/lib/paths";
import { spawnTurn } from "@/lib/turn";
import { acquireSessionTurnLock } from "@/lib/session-turn-lock";
import type { CLI, SessionMeta } from "@/lib/runs";
import { DEFAULT_CLI, isBedrockCli, normalizeCli } from "@/lib/clis";
import type { ModelReasoningEffort } from "@/lib/models";
import { assertBedrockSsoReady, isBedrockNotReadyError } from "@/lib/bedrock-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function lineEndsTurn(line: string): boolean {
  return /"type"\s*:\s*"(result|turn\.completed|step_finish|turn\.failed|saturn\.turn_aborted)"/.test(line);
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    at_turn?: number;
    message?: string;
    cli?: CLI;
    model?: string;
    mcpTools?: boolean;
    reasoningEffort?: ModelReasoningEffort;
  };
  const { at_turn, message } = body;

  if (!message?.trim()) {
    return NextResponse.json({ error: "message required" }, { status: 400 });
  }

  const metaFile = path.join(sessionsRoot(), id, "meta.json");
  let meta: SessionMeta;
  let originalMetaRaw: string;
  try {
    originalMetaRaw = await fs.readFile(metaFile, "utf8");
    meta = JSON.parse(originalMetaRaw) as SessionMeta;
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

  const nextTurns = meta.turns.slice(0, cutoff);
  const last = nextTurns[nextTurns.length - 1];
  const snap = meta.agent_snapshot;
  const cli = normalizeCli(body.cli ?? last?.cli ?? snap?.defaultCli ?? snap?.cli ?? DEFAULT_CLI);
  const model = body.model ?? last?.model ?? snap?.models?.[cli] ?? snap?.model;
  const reasoningEffort =
    body.reasoningEffort ??
    last?.reasoningEffort ??
    snap?.reasoningEfforts?.[cli] ??
    snap?.reasoningEffort;

  if (isBedrockCli(cli)) {
    try {
      await assertBedrockSsoReady();
    } catch (err) {
      await lock.release();
      if (isBedrockNotReadyError(err)) {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
      throw err;
    }
  }

  // Truncate turns in meta
  meta.turns = nextTurns;
  meta.status = "running";
  await fs.writeFile(metaFile, JSON.stringify(meta, null, 2), "utf8");

  // Truncate stream.jsonl to only include events for the first `cutoff` completed turns
  const streamFile = path.join(sessionsRoot(), id, "stream.jsonl");
  const originalStreamRaw = await fs.readFile(streamFile, "utf8").catch(() => null);
  try {
    const existing = originalStreamRaw ?? "";
    if (cutoff === 0) {
      await fs.writeFile(streamFile, "", "utf8");
    } else {
      const lines = existing.split("\n");
      let resultsSeen = 0;
      const keep: string[] = [];
      for (const line of lines) {
        if (!line) continue;
        keep.push(line);
        if (lineEndsTurn(line)) {
          resultsSeen++;
          if (resultsSeen >= cutoff) break;
        }
      }
      await fs.writeFile(streamFile, keep.join("\n") + (keep.length > 0 ? "\n" : ""), "utf8");
    }
  } catch {
    // stream missing — nothing to truncate
  }

  try {
    await spawnTurn(id, cli, model, message, snap, body.mcpTools, reasoningEffort);
  } catch (err) {
    await fs.writeFile(metaFile, originalMetaRaw, "utf8").catch(() => {});
    if (originalStreamRaw === null) {
      await fs.rm(streamFile, { force: true }).catch(() => {});
    } else {
      await fs.writeFile(streamFile, originalStreamRaw, "utf8").catch(() => {});
    }
    await lock.release();
    throw err;
  }

  return NextResponse.json({ ok: true });
}
