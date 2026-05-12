import { NextResponse } from "next/server";
import { listNativeAgents } from "@/lib/native/native-agents";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const agents = await listNativeAgents(id);
    return NextResponse.json({
      agents,
      visibility: {
        source: "session stream + native CLI metadata",
        count: agents.length,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.includes("not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
