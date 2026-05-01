import { NextRequest, NextResponse } from "next/server";
import { resizePtyTerminal } from "@/lib/terminal-pty";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (id.startsWith("agent-bash-")) {
    return NextResponse.json({ error: "agent Bash transcripts are read-only" }, { status: 409 });
  }
  const body = await req.json().catch(() => ({})) as { cols?: unknown; rows?: unknown };
  const cols = typeof body.cols === "number" ? body.cols : Number(body.cols);
  const rows = typeof body.rows === "number" ? body.rows : Number(body.rows);
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
    return NextResponse.json({ error: "cols and rows must be numbers" }, { status: 400 });
  }
  const terminal = resizePtyTerminal(id, cols, rows);
  if (!terminal) return NextResponse.json({ error: "terminal not found" }, { status: 404 });
  return NextResponse.json({ terminal });
}
