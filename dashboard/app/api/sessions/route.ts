import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import {
  getAgent,
  listSessions,
  sessionDir,
  type Agent,
  type CLI,
  type SessionMeta,
} from "@/lib/runs";
import { spawnTurn } from "@/lib/turn";
import { DEFAULT_CLI, normalizeCli } from "@/lib/clis";
import type { ModelReasoningEffort } from "@/lib/models";
import { assertBedrockReady, isBedrockNotReadyError } from "@/lib/bedrock-auth";
import { isBedrockCli } from "@/lib/clis";
import { agentSupportedClis } from "@/lib/session-utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type CreateSessionBody = {
  agent_id?: string;
  message?: string;
  cli?: CLI;
  model?: string;
  mcpTools?: boolean;
  reasoningEffort?: ModelReasoningEffort;
  adhoc_config?: {
    cli?: CLI;
    model?: string;
    reasoningEffort?: ModelReasoningEffort;
    prompt?: string;
    cwd?: string;
  };
  overrides?: SessionMeta["overrides"];
};

function adhocAgent(config: CreateSessionBody["adhoc_config"]): Agent {
  const cli = normalizeCli(config?.cli ?? DEFAULT_CLI);
  const now = new Date().toISOString();
  return {
    id: "__adhoc__",
    name: "Ad-hoc",
    prompt: config?.prompt ?? "",
    cwd: config?.cwd,
    cli,
    defaultCli: cli,
    supportedClis: [cli],
    model: config?.model,
    models: config?.model ? { [cli]: config.model } : undefined,
    reasoningEffort: config?.reasoningEffort,
    reasoningEfforts: config?.reasoningEffort ? { [cli]: config.reasoningEffort } : undefined,
    created_at: now,
    updated_at: now,
  };
}

function validatePositiveInteger(value: unknown, field: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return `${field} must be a whole number greater than 0`;
  }
  return null;
}

function validateSessionOverrides(overrides: CreateSessionBody["overrides"]): string | null {
  const budget = overrides?.budget;
  if (!budget) return null;
  return (
    validatePositiveInteger(budget.max_total_tokens, "overrides.budget.max_total_tokens") ??
    validatePositiveInteger(budget.max_wallclock_seconds, "overrides.budget.max_wallclock_seconds") ??
    validatePositiveInteger(budget.max_slice_calls, "overrides.budget.max_slice_calls") ??
    validatePositiveInteger(budget.max_recursion_depth, "overrides.budget.max_recursion_depth")
  );
}

export async function GET() {
  const sessions = await listSessions();
  return NextResponse.json({ sessions });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as CreateSessionBody;
  const message = body.message?.trim();
  if (!message) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  const agent = body.agent_id ? await getAgent(body.agent_id) : adhocAgent(body.adhoc_config);
  if (!agent) {
    return NextResponse.json({ error: `agent not found: ${body.agent_id}` }, { status: 404 });
  }

  const cli = normalizeCli(body.cli ?? body.adhoc_config?.cli ?? agent.defaultCli ?? agent.cli ?? DEFAULT_CLI);
  const model = body.model ?? body.adhoc_config?.model ?? agent.models?.[cli] ?? agent.model;
  const reasoningEffort =
    body.reasoningEffort ?? body.adhoc_config?.reasoningEffort ?? agent.reasoningEfforts?.[cli] ?? agent.reasoningEffort;

  if (body.agent_id && !agentSupportedClis(agent).includes(cli)) {
    return NextResponse.json(
      { error: `${cli} is not enabled for agent ${body.agent_id}` },
      { status: 400 },
    );
  }

  const overrideError = validateSessionOverrides(body.overrides);
  if (overrideError) {
    return NextResponse.json({ error: overrideError }, { status: 400 });
  }

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

  const session_id = randomUUID();
  const dir = sessionDir(session_id);
  const now = new Date().toISOString();
  const meta: SessionMeta = {
    session_id,
    agent_id: body.agent_id,
    agent_snapshot: agent,
    started_at: now,
    status: "running",
    turns: [],
    overrides: body.overrides,
  };

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf8");
  await fs.writeFile(path.join(dir, "stream.jsonl"), "", "utf8");
  await fs.writeFile(path.join(dir, "stderr.log"), "", "utf8");

  await spawnTurn(session_id, cli, model, message, agent, body.mcpTools, reasoningEffort);

  return NextResponse.json({ session_id });
}
