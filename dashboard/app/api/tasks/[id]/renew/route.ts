import { NextRequest, NextResponse } from "next/server";
import { renewTaskClaim } from "@/lib/tasks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const claimedBy = typeof body.claimed_by === "string" && body.claimed_by.trim()
    ? body.claimed_by.trim()
    : "";
  const ttlMinutes = body.ttl_minutes === undefined ? undefined : Number(body.ttl_minutes);

  if (!claimedBy) {
    return NextResponse.json({ error: "claimed_by is required" }, { status: 400 });
  }
  if (ttlMinutes !== undefined && (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0)) {
    return NextResponse.json({ error: "ttl_minutes must be a positive number" }, { status: 400 });
  }

  try {
    const result = await renewTaskClaim(id, claimedBy, ttlMinutes);
    if (!result.ok) {
      return NextResponse.json({ error: "forbidden: claimed_by mismatch" }, { status: 403 });
    }
    return NextResponse.json({ ok: true, expires_at: result.expires_at });
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed";
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
