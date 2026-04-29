import { NextRequest, NextResponse } from "next/server";
import { importShareBundle, normalizeShareBundle, type ImportConflictMode } from "@/lib/share";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isConflictMode(value: unknown): value is ImportConflictMode {
  return value === "rename" || value === "skip" || value === "overwrite";
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const conflictMode = isConflictMode(body.conflict) ? body.conflict : "rename";

  try {
    const bundle = normalizeShareBundle(body.bundle ?? body);
    const summary = await importShareBundle(bundle, conflictMode);
    return NextResponse.json({ summary });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Import failed" },
      { status: 400 },
    );
  }
}
