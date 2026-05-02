import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { sessionDir } from "@/lib/runs";
import { tailSseResponse } from "@/lib/sse-stream";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const dir = sessionDir(id);
  const replay = req.nextUrl.searchParams.get("replay");
  const fromTurnId = req.nextUrl.searchParams.get("from_turn_id") ?? undefined;
  const afterTurnId = req.nextUrl.searchParams.get("after_turn_id") ?? undefined;
  const afterTurnsParam = req.nextUrl.searchParams.get("after_turns");
  const afterTurns = afterTurnsParam === null ? undefined : Number(afterTurnsParam);
  const startAfterResultCount =
    typeof afterTurns === "number" && Number.isInteger(afterTurns) && afterTurns >= 0
      ? afterTurns
      : undefined;
  return tailSseResponse({
    streamFile: path.join(dir, "stream.jsonl"),
    metaFile: path.join(dir, "meta.json"),
    startAtEnd: replay === "0",
    startAfterResultCount,
    startAtTurnId: fromTurnId,
    startAfterTurnId: afterTurnId,
  });
}
