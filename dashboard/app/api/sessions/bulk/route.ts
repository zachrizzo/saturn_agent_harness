import { NextRequest, NextResponse } from "next/server";
import { updateSessionMeta, type SessionTriagePatch } from "@/lib/runs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function PATCH(req: NextRequest) {
  const body = (await req.json()) as { ids?: string[]; patch?: unknown };
  const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];
  const results = await Promise.allSettled(ids.map((id) => updateSessionMeta(id, body.patch as SessionTriagePatch)));
  return NextResponse.json({
    updated: results.filter((r) => r.status === "fulfilled").length,
  });
}
