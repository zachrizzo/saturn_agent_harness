import { NextRequest, NextResponse } from "next/server";
import { getSessionMeta, updateSessionMeta, type SessionMeta, type SessionTriagePatch } from "@/lib/runs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BULK_SESSION_READS = 100;

type BackgroundSessionSummary = {
  session_id: string;
  status: SessionMeta["status"];
  finished_at?: string;
  latestTurnStatus?: SessionMeta["turns"][number]["status"];
};

function requestedIds(req: NextRequest): string[] {
  const rawIds = [
    ...req.nextUrl.searchParams.getAll("id"),
    ...req.nextUrl.searchParams.getAll("ids").flatMap((value) => value.split(",")),
  ];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const raw of rawIds) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= MAX_BULK_SESSION_READS) break;
  }
  return ids;
}

function backgroundSummary(meta: SessionMeta): BackgroundSessionSummary {
  return {
    session_id: meta.session_id,
    status: meta.status,
    finished_at: meta.finished_at,
    latestTurnStatus: meta.turns.at(-1)?.status,
  };
}

export async function GET(req: NextRequest) {
  const ids = requestedIds(req);
  if (ids.length === 0) return NextResponse.json({ sessions: [] });

  const summary = req.nextUrl.searchParams.get("summary");
  const results = await Promise.all(ids.map(async (id) => getSessionMeta(id).catch(() => null)));
  const sessions = results
    .filter((meta): meta is SessionMeta => meta !== null)
    .map((meta) => summary === "background" ? backgroundSummary(meta) : meta);

  return NextResponse.json({ sessions });
}

export async function PATCH(req: NextRequest) {
  const body = (await req.json()) as { ids?: string[]; patch?: unknown };
  const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : [];
  const results = await Promise.allSettled(ids.map((id) => updateSessionMeta(id, body.patch as SessionTriagePatch)));
  return NextResponse.json({
    updated: results.filter((r) => r.status === "fulfilled").length,
  });
}
