import { NextRequest, NextResponse } from "next/server";
import { normalizeAppSettings, readAppSettings, writeAppSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export async function GET() {
  const settings = await readAppSettings();
  return NextResponse.json({ settings });
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const settings = await writeAppSettings(normalizeAppSettings(body?.settings ?? body));
    return NextResponse.json({ settings });
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to save settings";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
