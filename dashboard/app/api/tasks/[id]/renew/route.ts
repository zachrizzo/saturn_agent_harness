import { NextRequest, NextResponse } from "next/server";
import { renewTaskClaim } from "@/lib/tasks";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json() as { claimed_by?: string; ttl_minutes?: number };
  if (!body.claimed_by?.trim()) {
    return NextResponse.json({ error: "claimed_by is required" }, { status: 400 });
  }

  const result = await renewTaskClaim(params.id, body.claimed_by, body.ttl_minutes);
  if (!result.ok) {
    return NextResponse.json({ error: "forbidden: claimed_by mismatch" }, { status: 403 });
  }
  return NextResponse.json({ ok: true, expires_at: result.expires_at });
}
