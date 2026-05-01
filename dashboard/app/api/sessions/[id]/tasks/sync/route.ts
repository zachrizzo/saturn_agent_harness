import { NextRequest, NextResponse } from "next/server";
import { syncTodoListTasks } from "@/lib/task-todos";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as { turn_id?: unknown };
  const turnId = typeof body.turn_id === "string" && body.turn_id.trim() ? body.turn_id.trim() : undefined;

  try {
    const result = await syncTodoListTasks(id, turnId);
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to sync task todos";
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
