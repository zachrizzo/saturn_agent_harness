import { NextRequest, NextResponse } from "next/server";
import {
  getAgent,
  updateAgent,
  deleteAgent,
  type Agent,
  type MutationTier,
} from "@/lib/runs";
import {
  isPlainObject,
  normalizeAgentCliFields,
  normalizeAgentModelFields,
  shouldNormalizeAgentCliFields,
} from "@/lib/agent-request";

export const dynamic = "force-dynamic";

/**
 * Apply orchestrator-specific defaults + validation on a PUT patch. The patch
 * only gets orchestrator treatment when the patch itself declares
 * `kind === "orchestrator"` (mirrors POST behavior; avoids silently upgrading
 * an existing chat agent).
 */
function applyOrchestratorDefaultsForPatch(patch: Partial<Agent>): string | null {
  if (patch.kind !== "orchestrator") return null;
  if (!isPlainObject(patch.budget)) {
    return "budget must be an object when kind is 'orchestrator'";
  }
  if (patch.can_create_custom_slices === undefined) {
    patch.can_create_custom_slices = false;
  }
  if (patch.allowed_mutations === undefined) {
    patch.allowed_mutations = ["read-only"] as MutationTier[];
  }
  if (patch.on_budget_exceeded === undefined) {
    patch.on_budget_exceeded = "report-partial";
  }
  if (patch.on_slice_failure === undefined) {
    patch.on_slice_failure = "continue";
  }
  return null;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const agent = await getAgent(id);
  if (!agent) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ agent });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const patch = (await req.json().catch(() => null)) as (Partial<Agent> & Record<string, unknown>) | null;
  if (!patch || !isPlainObject(patch)) {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  // Forbid id rewrites
  delete patch.id;
  delete patch.created_at;
  // Normalize multi-CLI fields
  if (shouldNormalizeAgentCliFields(patch)) {
    const cliFields = normalizeAgentCliFields(patch);
    if (!cliFields.ok) {
      return NextResponse.json({ error: cliFields.error }, { status: 400 });
    }
    patch.supportedClis = cliFields.supportedClis;
    patch.defaultCli = cliFields.defaultCli;
    patch.cli = cliFields.defaultCli; // keep legacy field in sync
  }

  const orchestratorError = applyOrchestratorDefaultsForPatch(patch);
  if (orchestratorError) {
    return NextResponse.json({ error: orchestratorError }, { status: 400 });
  }

  const modelError = normalizeAgentModelFields(patch);
  if (modelError) {
    return NextResponse.json({ error: modelError }, { status: 400 });
  }

  try {
    const agent = await updateAgent(id, patch);
    return NextResponse.json({ agent });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "failed" }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await deleteAgent(id);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "failed" }, { status: 500 });
  }
}
