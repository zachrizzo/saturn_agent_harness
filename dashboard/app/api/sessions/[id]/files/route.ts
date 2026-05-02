import { createReadStream, promises as fs } from "node:fs";
import { Readable } from "node:stream";
import { NextRequest, NextResponse } from "next/server";
import { getSessionMeta } from "@/lib/runs";
import { mimeTypeFor, resolveSessionFile } from "@/lib/session-files";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSessionMeta(id);
  if (!session) return NextResponse.json({ error: "not found" }, { status: 404 });

  const rawPath = req.nextUrl.searchParams.get("path");
  if (!rawPath) return NextResponse.json({ error: "missing path" }, { status: 400 });

  const filePath = await resolveSessionFile(id, session.agent_snapshot?.cwd, rawPath);
  if (!filePath) return NextResponse.json({ error: "file not found" }, { status: 404 });

  const stats = await fs.stat(filePath);
  const body = Readable.toWeb(createReadStream(filePath)) as ReadableStream<Uint8Array>;
  return new Response(body, {
    headers: {
      "content-type": mimeTypeFor(filePath),
      "content-length": String(stats.size),
      "cache-control": "private, max-age=60",
    },
  });
}
