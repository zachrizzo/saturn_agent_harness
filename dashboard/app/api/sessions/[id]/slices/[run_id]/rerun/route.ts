export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sessionsRoot } from "@/lib/paths";
import { executeSlice } from "@/lib/slice-executor";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string; run_id: string }> }
) {
  const { id, run_id } = await params;
  const metaPath = path.join(sessionsRoot(), id, "slices", run_id, "meta.json");
  try {
    const raw = await fs.readFile(metaPath, "utf8");
    const meta = JSON.parse(raw) as {
      slice_id?: string;
      inputs?: Record<string, unknown>;
    };
    const result = await executeSlice({
      sessionId: id,
      sliceId: meta.slice_id ?? "",
      inputs: meta.inputs ?? {},
    });
    return NextResponse.json({
      slice_run_id: result.slice_run_id,
      status: result.status,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "rerun failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
