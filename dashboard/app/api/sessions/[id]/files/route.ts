import { promises as fs } from "node:fs";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/runs";
import { mimeTypeFor, resolveSessionFile } from "@/lib/session-files";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: "not found" }, { status: 404 });

  const rawPath = req.nextUrl.searchParams.get("path");
  if (!rawPath) return NextResponse.json({ error: "missing path" }, { status: 400 });

  const filePath = await resolveSessionFile(id, session.meta.agent_snapshot?.cwd, rawPath);
  if (!filePath) return NextResponse.json({ error: "file not found" }, { status: 404 });

  const body = await fs.readFile(filePath);
  return new NextResponse(body, {
    headers: {
      "content-type": mimeTypeFor(filePath),
      "cache-control": "private, max-age=60",
    },
  });
}
