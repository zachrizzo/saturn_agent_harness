import { NextRequest, NextResponse } from "next/server";
import { releaseTask, type TaskStatus } from "@/lib/tasks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const RELEASE_STATUSES = ["open", "done", "cancelled"] as const satisfies readonly TaskStatus[];

function isReleaseStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (RELEASE_STATUSES as readonly string[]).includes(value);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const claimedBy = typeof body.claimed_by === "string" && body.claimed_by.trim()
    ? body.claimed_by.trim()
    : "saturn-cli";
  const status = body.status === undefined ? undefined : body.status;

  if (status !== undefined && !isReleaseStatus(status)) {
    return NextResponse.json({ error: "status must be open, done, or cancelled" }, { status: 400 });
  }

  try {
    const result = await releaseTask(id, claimedBy, status);
    if (!result.ok) {
      return NextResponse.json({ error: "task is not claimed by this actor" }, { status: 403 });
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
