export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { readBudget } from "@/lib/budget";
import { getSessionMeta } from "@/lib/runs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const [budget, session] = await Promise.all([
    readBudget(id),
    getSessionMeta(id),
  ]);
  const limits = session?.agent_snapshot?.budget ?? {};
  return NextResponse.json({ budget, limits });
}
