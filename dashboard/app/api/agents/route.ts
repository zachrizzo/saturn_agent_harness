import { NextRequest, NextResponse } from "next/server";
import {
  listAgents,
  createAgent,
  type CLI,
  type Agent,
  type MutationTier,
} from "@/lib/runs";
import { toClaudeAlias } from "@/lib/claude-models";
import { DEFAULT_CLI, normalizeCli } from "@/lib/clis";

export const dynamic = "force-dynamic";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Apply orchestrator-specific defaults + validation in place. Returns an error
 * string when validation fails, else null.
 */
function applyOrchestratorDefaults(body: Partial<Agent>): string | null {
  if (body.kind !== "orchestrator") return null;
  if (!isObject(body.budget)) {
    return "budget must be an object when kind is 'orchestrator'";
  }
  if (body.can_create_custom_slices === undefined) {
    body.can_create_custom_slices = false;
  }
  if (body.allowed_mutations === undefined) {
    body.allowed_mutations = ["read-only"] as MutationTier[];
  }
  if (body.on_budget_exceeded === undefined) {
    body.on_budget_exceeded = "report-partial";
  }
  if (body.on_slice_failure === undefined) {
    body.on_slice_failure = "continue";
  }
  return null;
}

export async function GET() {
  const agents = await listAgents();
  return NextResponse.json({ agents });
}

export async function POST(req: NextRequest) {
  const body = (await req.json()) as Partial<Agent>;
  const { id, name, prompt } = body;

  if (!id || !name || !prompt) {
    return NextResponse.json({ error: "id, name, prompt are required" }, { status: 400 });
  }
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(id)) {
    return NextResponse.json({ error: "id must be alphanumeric with - or _" }, { status: 400 });
  }

  // Support both old (cli) and new (supportedClis/defaultCli) schema
  const supportedClis = (body.supportedClis ?? (body.cli ? [body.cli] : [DEFAULT_CLI]))
    .map((cli) => normalizeCli(cli));
  const defaultCli: CLI = normalizeCli(body.defaultCli ?? body.cli ?? DEFAULT_CLI);

  const orchestratorError = applyOrchestratorDefaults(body);
  if (orchestratorError) {
    return NextResponse.json({ error: orchestratorError }, { status: 400 });
  }

  // Normalize Bedrock IDs to short aliases before writing to agents.json so
  // stored values are always `claude-sonnet-4-6` not `global.anthropic.claude-sonnet-4-6`.
  if (body.model) body.model = toClaudeAlias(body.model) ?? body.model;
  if (body.models) {
    body.models = Object.fromEntries(
      Object.entries(body.models).map(([cli, m]) => [normalizeCli(cli), m ? (toClaudeAlias(m) ?? m) : m])
    ) as typeof body.models;
  }

  try {
    const agent = await createAgent({
      ...body,
      id,
      name,
      prompt,
      supportedClis,
      defaultCli,
      // Keep legacy cli field for backward compat
      cli: defaultCli,
    } as Omit<Agent, "created_at">);
    return NextResponse.json({ agent });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "failed" }, { status: 500 });
  }
}
