export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { readBudget } from "@/lib/budget";
import { getSession } from "@/lib/runs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const [budget, session] = await Promise.all([
    readBudget(id),
    getSession(id),
  ]);
  const limits = session?.meta.agent_snapshot?.budget ?? {};
  return NextResponse.json({ budget, limits });
}
