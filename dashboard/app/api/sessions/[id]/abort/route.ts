import { NextRequest, NextResponse } from "next/server";
import { abortSessionRun } from "@/lib/session-abort";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await abortSessionRun(id);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({ ok: true, aborted: result.aborted });
}
