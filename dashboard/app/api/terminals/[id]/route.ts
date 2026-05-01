import { NextRequest, NextResponse } from "next/server";
import { getAgentBashTerminal } from "@/lib/terminal-agent";
import { deletePtyTerminal, getPtyTerminal } from "@/lib/terminal-pty";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const terminal = getPtyTerminal(id) ?? (await getAgentBashTerminal(id))?.record ?? null;
  if (!terminal) return NextResponse.json({ error: "terminal not found" }, { status: 404 });
  return NextResponse.json({ terminal });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (id.startsWith("agent-bash-")) {
    return NextResponse.json({ error: "agent Bash transcripts are read-only" }, { status: 409 });
  }
  const terminal = deletePtyTerminal(id);
  if (!terminal) return NextResponse.json({ error: "terminal not found" }, { status: 404 });
  return NextResponse.json({ terminal });
}
