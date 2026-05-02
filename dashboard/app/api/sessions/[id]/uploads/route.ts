import { NextRequest, NextResponse } from "next/server";
import { getSessionMeta } from "@/lib/runs";
import { isSessionUploadLimitError, saveSessionUploads } from "@/lib/session-uploads";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSessionMeta(id);
  if (!session) return NextResponse.json({ error: "not found" }, { status: 404 });

  const form = await req.formData();
  const files = form.getAll("files").filter((v): v is File => v instanceof File);
  try {
    const saved = await saveSessionUploads(id, files);
    return NextResponse.json({ files: saved });
  } catch (err) {
    if (isSessionUploadLimitError(err)) {
      return NextResponse.json({ error: err.message }, { status: 413 });
    }
    throw err;
  }
}
