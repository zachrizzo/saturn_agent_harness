import { NextRequest, NextResponse } from "next/server";
import {
  listAgents,
  createAgent,
  type Agent,
  type MutationTier,
} from "@/lib/runs";
import { isPlainObject, normalizeAgentCliFields, normalizeAgentModelFields } from "@/lib/agent-request";

export const dynamic = "force-dynamic";

/**
 * Apply orchestrator-specific defaults + validation in place. Returns an error
 * string when validation fails, else null.
 */
function applyOrchestratorDefaults(body: Partial<Agent>): string | null {
  if (body.kind !== "orchestrator") return null;
  if (!isPlainObject(body.budget)) {
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
  const body = (await req.json().catch(() => null)) as Partial<Agent> | null;
  if (!body || !isPlainObject(body)) {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const { id, name, prompt } = body;

  if (!id || !name || !prompt) {
    return NextResponse.json({ error: "id, name, prompt are required" }, { status: 400 });
  }
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(id)) {
    return NextResponse.json({ error: "id must be alphanumeric with - or _" }, { status: 400 });
  }

  const cliFields = normalizeAgentCliFields(body as Partial<Agent> & Record<string, unknown>);
  if (!cliFields.ok) {
    return NextResponse.json({ error: cliFields.error }, { status: 400 });
  }

  const orchestratorError = applyOrchestratorDefaults(body);
  if (orchestratorError) {
    return NextResponse.json({ error: orchestratorError }, { status: 400 });
  }

  const modelError = normalizeAgentModelFields(body as Partial<Agent> & Record<string, unknown>);
  if (modelError) {
    return NextResponse.json({ error: modelError }, { status: 400 });
  }

  try {
    const agent = await createAgent({
      ...body,
      id,
      name,
      prompt,
      supportedClis: cliFields.supportedClis,
      defaultCli: cliFields.defaultCli,
      // Keep legacy cli field for backward compat
      cli: cliFields.defaultCli,
    } as Omit<Agent, "created_at">);
    return NextResponse.json({ agent });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "failed" }, { status: 500 });
  }
}
