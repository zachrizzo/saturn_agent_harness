export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sessionsRoot } from "@/lib/paths";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; run_id: string }> }
) {
  const { id, run_id } = await params;
  const metaPath = path.join(sessionsRoot(), id, "slices", run_id, "meta.json");
  try {
    const raw = await fs.readFile(metaPath, "utf8");
    return NextResponse.json(JSON.parse(raw));
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}
