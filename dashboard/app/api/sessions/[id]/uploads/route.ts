import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/runs";
import { saveSessionUploads } from "@/lib/session-uploads";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession(id);
  if (!session) return NextResponse.json({ error: "not found" }, { status: 404 });

  const form = await req.formData();
  const files = form.getAll("files").filter((v): v is File => v instanceof File);
  const saved = await saveSessionUploads(id, files);

  return NextResponse.json({ files: saved });
}
