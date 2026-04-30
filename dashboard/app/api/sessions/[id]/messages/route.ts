import { NextRequest, NextResponse } from "next/server";
import { getSession, type CLI, type PlanAction } from "@/lib/runs";
import { spawnTurn } from "@/lib/turn";
import { DEFAULT_CLI, normalizeCli } from "@/lib/clis";
import type { ModelReasoningEffort } from "@/lib/models";
import { assertBedrockReady, isBedrockNotReadyError } from "@/lib/bedrock-auth";
import { isBedrockCli } from "@/lib/clis";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = {
  message?: string;
  cli?: CLI;
  model?: string;
  mcpTools?: boolean;
  reasoningEffort?: ModelReasoningEffort;
  planAction?: PlanAction;
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json()) as Body;
  const message = body.message?.trim();
  if (!message) return NextResponse.json({ error: "message is required" }, { status: 400 });

  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: "not found" }, { status: 404 });
  const last = session.meta.turns.at(-1);
  const agent = session.meta.agent_snapshot;
  const cli = normalizeCli(body.cli ?? last?.cli ?? agent?.defaultCli ?? agent?.cli ?? DEFAULT_CLI);
  const model = body.model ?? last?.model ?? agent?.models?.[cli] ?? agent?.model;
  const reasoningEffort = body.reasoningEffort ?? last?.reasoningEffort ?? agent?.reasoningEfforts?.[cli] ?? agent?.reasoningEffort;

  if (isBedrockCli(cli)) {
    try {
      await assertBedrockReady();
    } catch (err) {
      if (isBedrockNotReadyError(err)) {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
      throw err;
    }
  }

  await spawnTurn(id, cli, model, message, agent, body.mcpTools, reasoningEffort, body.planAction);
  return NextResponse.json({ ok: true });
}
