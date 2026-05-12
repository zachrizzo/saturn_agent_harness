import { NextRequest, NextResponse } from "next/server";
import { getSessionMeta, updateSessionMeta, type CLI } from "@/lib/runs";
import { spawnTurn } from "@/lib/turn";
import { DEFAULT_CLI, isBedrockCli, normalizeCli } from "@/lib/clis";
import type { ModelReasoningEffort } from "@/lib/models";
import { assertBedrockSsoReady, isBedrockNotReadyError } from "@/lib/bedrock-auth";
import { acquireSessionTurnLock } from "@/lib/session-turn-lock";
import { abortSessionRun } from "@/lib/session-abort";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  message?: string;
  cli?: CLI;
  model?: string;
  mcpTools?: boolean;
  reasoningEffort?: ModelReasoningEffort;
};

function titleFromSteerMessage(message: string): string {
  const firstLine = message
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .find(Boolean) ?? message.replace(/\s+/g, " ").trim();
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Body;
  const message = body.message?.trim();
  if (!message) return NextResponse.json({ error: "message is required" }, { status: 400 });

  let meta = await getSessionMeta(id);
  if (!meta) return NextResponse.json({ error: "not found" }, { status: 404 });

  let last = meta.turns.at(-1);
  let agent = meta.agent_snapshot;
  let cli = normalizeCli(body.cli ?? last?.cli ?? agent?.defaultCli ?? agent?.cli ?? DEFAULT_CLI);
  let model = body.model ?? last?.model ?? agent?.models?.[cli] ?? agent?.model;
  let reasoningEffort =
    body.reasoningEffort ?? last?.reasoningEffort ?? agent?.reasoningEfforts?.[cli] ?? agent?.reasoningEffort;

  try {
    if (isBedrockCli(cli)) {
      await assertBedrockSsoReady();
    }
  } catch (err) {
    if (isBedrockNotReadyError(err)) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }

  let aborted = false;
  if (meta.status === "running" || last?.status === "running") {
    const abortResult = await abortSessionRun(id);
    if (!abortResult.ok) {
      return NextResponse.json({ error: abortResult.error }, { status: abortResult.status });
    }
    meta = abortResult.meta;
    aborted = abortResult.aborted;
    last = meta.turns.at(-1);
    agent = meta.agent_snapshot;
    cli = normalizeCli(body.cli ?? last?.cli ?? agent?.defaultCli ?? agent?.cli ?? DEFAULT_CLI);
    model = body.model ?? last?.model ?? agent?.models?.[cli] ?? agent?.model;
    reasoningEffort =
      body.reasoningEffort ?? last?.reasoningEffort ?? agent?.reasoningEfforts?.[cli] ?? agent?.reasoningEffort;
  }

  const lock = await acquireSessionTurnLock(id, { waitMs: 10_000, retryDelayMs: 150 });
  if (!lock.ok) {
    return NextResponse.json({ error: "previous turn still running" }, { status: 409 });
  }

  const title = titleFromSteerMessage(message);
  try {
    await updateSessionMeta(id, { title_override: title });
    await spawnTurn(id, cli, model, message, agent, body.mcpTools, reasoningEffort, undefined, { steered: true });
    return NextResponse.json({ ok: true, aborted, message, title_override: title });
  } catch (err) {
    await lock.release();
    if (isBedrockNotReadyError(err)) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
