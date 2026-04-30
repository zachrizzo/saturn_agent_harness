export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import path from "node:path";
import fs from "node:fs";
import { sessionsRoot } from "@/lib/paths";
import { tailSseResponse } from "@/lib/sse-stream";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; run_id: string }> }
) {
  const { id, run_id } = await params;
  const sliceDir = path.join(sessionsRoot(), id, "slices", run_id);

  if (!fs.existsSync(sliceDir)) {
    return new Response("Slice run not found", { status: 404 });
  }

  const streamFile = path.join(sliceDir, "stream.jsonl");
  const metaFile = path.join(sliceDir, "meta.json");

  // Mirror the session stream route: tailSseResponse polls metaFile for terminal status.
  // The slice is terminal when status !== "running".
  // The SSE auto-closes when _slice_done event appears or status goes terminal.
  return tailSseResponse({
    streamFile,
    metaFile,
    liveTail: true,
  });
}
