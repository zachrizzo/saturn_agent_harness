import { NextRequest, NextResponse } from "next/server";
import { captureMemoryFromTurn } from "@/lib/memory";
import { getSession, type TurnRecord } from "@/lib/runs";
import { badRequest, cleanString, parseJsonObject, serverError } from "../../../_helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function readOptionalBody(req: NextRequest): Promise<Record<string, unknown> | undefined | "invalid"> {
  const raw = await req.text();
  if (!raw.trim()) return undefined;
  try {
    return parseJsonObject(JSON.parse(raw)) ?? "invalid";
  } catch {
    return "invalid";
  }
}

async function callCaptureMemoryFromTurn(input: {
  session: NonNullable<Awaited<ReturnType<typeof getSession>>>;
  turn: TurnRecord;
}) {
  const fn = captureMemoryFromTurn as unknown as (...args: unknown[]) => Promise<unknown>;
  if (fn.length >= 3) {
    return fn(input.session, input.turn, { events: input.session.events, stderr: input.session.stderr });
  }
  if (fn.length >= 2) return fn(input.session, input.turn);
  return fn({
    session: input.session,
    meta: input.session.meta,
    events: input.session.events,
    stderr: input.session.stderr,
    turn: input.turn,
    turn_id: input.turn.turn_id,
    cwd: input.session.meta.agent_snapshot?.cwd,
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readOptionalBody(req);
  if (body === "invalid") return badRequest("Invalid JSON");

  const turnId = cleanString(body?.turn_id);
  if (body && "turn_id" in body && !turnId) return badRequest("turn_id must be a non-empty string");

  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: "not found" }, { status: 404 });

  const turns = session.meta.turns ?? [];
  const turn = turnId
    ? turns.find((item) => item.turn_id === turnId)
    : turns.at(-1);
  if (!turn) {
    return NextResponse.json(
      { error: turnId ? "turn not found" : "session has no turns" },
      { status: turnId ? 404 : 400 },
    );
  }

  try {
    const result = await callCaptureMemoryFromTurn({ session, turn });
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return serverError(err, "failed to capture memory");
  }
}
