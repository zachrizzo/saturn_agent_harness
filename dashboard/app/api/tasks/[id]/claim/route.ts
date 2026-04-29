import { NextRequest, NextResponse } from "next/server";
import { claimTask } from "@/lib/tasks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const claimedBy = typeof body.claimed_by === "string" && body.claimed_by.trim()
    ? body.claimed_by.trim()
    : "saturn-cli";
  const ttlMinutes = body.ttl_minutes === undefined ? undefined : Number(body.ttl_minutes);

  if (ttlMinutes !== undefined && (!Number.isFinite(ttlMinutes) || ttlMinutes <= 0)) {
    return NextResponse.json({ error: "ttl_minutes must be a positive number" }, { status: 400 });
  }

  try {
    const result = await claimTask(id, claimedBy, ttlMinutes);
    if (!result.ok) {
      return NextResponse.json(
        { error: "task already claimed", claimed_by: result.claimed_by, expires_at: result.expires_at },
        { status: 409 },
      );
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed";
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
