import { NextResponse } from "next/server";
import { readNativeAgentTranscript } from "@/lib/native/native-agents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; agentId: string }> },
) {
  const { id, agentId } = await params;
  try {
    const transcript = await readNativeAgentTranscript(id, agentId);
    return NextResponse.json(transcript);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes("not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
