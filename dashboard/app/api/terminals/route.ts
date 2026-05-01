import { NextRequest, NextResponse } from "next/server";
import { listAllTerminals } from "@/lib/terminals";
import { startPtyTerminal } from "@/lib/terminal-pty";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type CreateTerminalBody = {
  cwd?: unknown;
  cols?: unknown;
  rows?: unknown;
  title?: unknown;
  sessionId?: unknown;
};

function intOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : undefined;
}

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("sessionId")?.trim();
  return NextResponse.json(await listAllTerminals({ sessionId }));
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as CreateTerminalBody;
  const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
  if (!cwd) {
    return NextResponse.json({ error: "cwd is required" }, { status: 400 });
  }

  try {
    const terminal = await startPtyTerminal({
      cwd,
      cols: intOrUndefined(body.cols),
      rows: intOrUndefined(body.rows),
      title: typeof body.title === "string" ? body.title : undefined,
      sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
    });
    return NextResponse.json({ terminal }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "failed to create terminal" },
      { status: 400 },
    );
  }
}
