import { NextRequest, NextResponse } from "next/server";
import { saveDispatchBotUsername } from "@/lib/dispatch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { username?: string };
  try {
    const result = await saveDispatchBotUsername(body.username ?? "");
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "failed to save bot username" },
      { status: 400 },
    );
  }
}
