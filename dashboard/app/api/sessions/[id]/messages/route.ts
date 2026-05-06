import { NextRequest, NextResponse } from "next/server";
import { getSessionMeta, type CLI, type PlanAction } from "@/lib/runs";
import { spawnTurn } from "@/lib/turn";
import { DEFAULT_CLI, normalizeCli } from "@/lib/clis";
import type { ModelReasoningEffort } from "@/lib/models";
import { assertBedrockSsoReady, isBedrockNotReadyError } from "@/lib/bedrock-auth";
import { isBedrockCli } from "@/lib/clis";
import { acquireSessionTurnLock } from "@/lib/session-turn-lock";
import { appendUploadReferences, isSessionUploadLimitError, saveSessionUploads } from "@/lib/session-uploads";

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

type MessageRequest = {
  body: Body;
  files: File[];
};

class BadRequestError extends Error {}

async function readMessageRequest(req: NextRequest): Promise<MessageRequest> {
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    try {
      return { body: (await req.json()) as Body, files: [] };
    } catch {
      throw new BadRequestError("Invalid JSON");
    }
  }

  const form = await req.formData();
  const payload = form.get("payload");
  if (typeof payload !== "string") {
    throw new BadRequestError("multipart message requires a JSON payload field");
  }
  let parsed: Body;
  try {
    parsed = JSON.parse(payload) as Body;
  } catch {
    throw new BadRequestError("Invalid JSON payload");
  }
  const files = form.getAll("files").filter((value): value is File => value instanceof File);
  return { body: parsed, files };
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: Body;
  let files: File[];
  try {
    ({ body, files } = await readMessageRequest(req));
  } catch (err) {
    if (err instanceof BadRequestError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
  const message = body.message?.trim();
  if (!message) return NextResponse.json({ error: "message is required" }, { status: 400 });

  const meta = await getSessionMeta(id);
  if (!meta) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (meta.status === "running") {
    return NextResponse.json({ error: "previous turn still running" }, { status: 409 });
  }
  const lock = await acquireSessionTurnLock(id, { waitMs: 10_000, retryDelayMs: 150 });
  if (!lock.ok) {
    return NextResponse.json({ error: "previous turn still running" }, { status: 409 });
  }

  const last = meta.turns.at(-1);
  const agent = meta.agent_snapshot;
  const cli = normalizeCli(body.cli ?? last?.cli ?? agent?.defaultCli ?? agent?.cli ?? DEFAULT_CLI);
  const model = body.model ?? last?.model ?? agent?.models?.[cli] ?? agent?.model;
  const reasoningEffort = body.reasoningEffort ?? last?.reasoningEffort ?? agent?.reasoningEfforts?.[cli] ?? agent?.reasoningEffort;

  try {
    if (isBedrockCli(cli)) {
      await assertBedrockSsoReady();
    }

    const uploads = await saveSessionUploads(id, files);
    const messageWithUploads = appendUploadReferences(message, uploads);
    await spawnTurn(id, cli, model, messageWithUploads, agent, body.mcpTools, reasoningEffort, body.planAction);
    return NextResponse.json({ ok: true, message: messageWithUploads });
  } catch (err) {
    await lock.release();
    if (isBedrockNotReadyError(err)) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (isSessionUploadLimitError(err)) {
      return NextResponse.json({ error: err.message }, { status: 413 });
    }
    throw err;
  }
}
