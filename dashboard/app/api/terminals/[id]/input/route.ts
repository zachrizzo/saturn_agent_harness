import { NextRequest, NextResponse } from "next/server";
import { writePtyTerminal } from "@/lib/terminal-pty";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (id.startsWith("agent-bash-")) {
    return NextResponse.json({ error: "agent Bash transcripts are read-only" }, { status: 409 });
  }
  const body = await req.json().catch(() => ({})) as { data?: unknown };
  if (typeof body.data !== "string") {
    return NextResponse.json({ error: "data must be a string" }, { status: 400 });
  }
  const terminal = writePtyTerminal(id, body.data);
  if (!terminal) return NextResponse.json({ error: "terminal not found" }, { status: 404 });
  return NextResponse.json({ terminal });
}
