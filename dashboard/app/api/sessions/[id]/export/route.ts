import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sessionsRoot } from "@/lib/paths";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET /api/sessions/[id]/export
// Bundles session meta + all slice metas + outputs into a single JSON response.
// Shape: { session: SessionMeta, slices: Array<{ run_id, meta, output, raw_output }> }
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const sessionDir = path.join(sessionsRoot(), id);

  // Read session meta.json
  let session: unknown;
  try {
    session = JSON.parse(await fs.readFile(path.join(sessionDir, "meta.json"), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json({ error: "session not found" }, { status: 404 });
    }
    throw err;
  }

  // Read slices/index.jsonl to get ordered list of dispatch entries
  const indexPath = path.join(sessionDir, "slices", "index.jsonl");
  const indexEntries: Record<string, unknown>[] = [];
  try {
    const raw = await fs.readFile(indexPath, "utf8");
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        indexEntries.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // No slices dir yet — fall through with empty array
  }

  // For each slice run, read meta.json + output.json
  const slices: unknown[] = [];
  for (const entry of indexEntries) {
    const runId = entry.slice_run_id as string | undefined;
    if (!runId) continue;

    const runDir = path.join(sessionDir, "slices", runId);

    let meta: unknown = entry; // fall back to index entry if meta.json missing
    try {
      const raw = await fs.readFile(path.join(runDir, "meta.json"), "utf8");
      meta = JSON.parse(raw);
    } catch {
      // use index entry as meta
    }

    let output: unknown = null;
    try {
      const raw = await fs.readFile(path.join(runDir, "output.json"), "utf8");
      output = JSON.parse(raw);
    } catch {
      // no structured output
    }

    let raw_output = "";
    try {
      raw_output = await fs.readFile(path.join(runDir, "output.raw.txt"), "utf8");
    } catch {
      // no raw output
    }

    slices.push({ run_id: runId, meta, output, raw_output });
  }

  return NextResponse.json({ session, slices });
}
