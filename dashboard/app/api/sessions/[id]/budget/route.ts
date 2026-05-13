export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { readBudget } from "@/lib/budget";
import { getSessionMeta } from "@/lib/runs";
import { effectiveOrchestratorLimits, effectiveSwarmAgent } from "@/lib/session-utils";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const [budget, session] = await Promise.all([
    readBudget(id),
    getSessionMeta(id),
  ]);
  const limits = session?.agent_snapshot
    ? effectiveOrchestratorLimits(effectiveSwarmAgent(session.agent_snapshot, session), session.overrides?.budget)
    : {};
  return NextResponse.json({ budget, limits });
}
