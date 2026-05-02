import { NextRequest, NextResponse } from "next/server";
import { saveDispatchSetupSettings } from "@/lib/dispatch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  try {
    const result = await saveDispatchSetupSettings(body);
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "failed to save Dispatch setup values" },
      { status: 400 },
    );
  }
}
