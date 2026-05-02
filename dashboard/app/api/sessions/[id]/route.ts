import { NextRequest, NextResponse } from "next/server";
import { getSession, updateSessionMeta } from "@/lib/runs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const eventMode = req.nextUrl.searchParams.get("events") === "recent" ? "recent" : "all";
  const compactEvents = req.nextUrl.searchParams.get("compact") === "1";
  const compactMeta = req.nextUrl.searchParams.get("meta") === "full" ? false : undefined;
  const session = await getSession(id, { eventMode, compactEvents, compactMeta });
  if (!session) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(session);
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const meta = await updateSessionMeta(id, await req.json());
    return NextResponse.json({ meta });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "failed" }, { status: 500 });
  }
}
