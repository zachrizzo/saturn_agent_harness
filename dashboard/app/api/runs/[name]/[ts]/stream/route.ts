import { NextRequest } from "next/server";
import path from "node:path";
import fs from "node:fs";
import { runsRoot } from "@/lib/paths";
import { tailSseResponse } from "@/lib/sse-stream";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ name: string; ts: string }> }
) {
  const { name, ts } = await params;
  const runDir = path.join(runsRoot(), name, ts);
  if (!fs.existsSync(runDir)) {
    return new Response("Run not found", { status: 404 });
  }
  return tailSseResponse({
    streamFile: path.join(runDir, "stream.jsonl"),
    metaFile: path.join(runDir, "meta.json"),
  });
}
