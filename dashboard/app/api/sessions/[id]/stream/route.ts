import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { sessionDir } from "@/lib/runs";
import { tailSseResponse } from "@/lib/sse-stream";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const dir = sessionDir(id);
  return tailSseResponse({
    streamFile: path.join(dir, "stream.jsonl"),
    metaFile: path.join(dir, "meta.json"),
  });
}
