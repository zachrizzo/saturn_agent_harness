import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { getSession, sessionDir } from "@/lib/runs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+/, "") || "attachment";
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: "not found" }, { status: 404 });

  const form = await req.formData();
  const files = form.getAll("files").filter((v): v is File => v instanceof File);
  const uploadDir = path.join(sessionDir(id), "uploads");
  await fs.mkdir(uploadDir, { recursive: true });

  const saved = [];
  for (const file of files) {
    const name = `${Date.now()}-${safeName(file.name)}`;
    const abs = path.join(uploadDir, name);
    await fs.writeFile(abs, Buffer.from(await file.arrayBuffer()));
    saved.push({ name: file.name, path: abs });
  }

  return NextResponse.json({ files: saved });
}
