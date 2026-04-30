export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sessionsRoot } from "@/lib/paths";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const indexPath = path.join(sessionsRoot(), id, "slices", "index.jsonl");
  let raw: string;
  try {
    raw = await fs.readFile(indexPath, "utf8");
  } catch {
    return NextResponse.json({ slices: [] });
  }

  const slices: unknown[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      slices.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return NextResponse.json({ slices });
}
