import { NextRequest, NextResponse } from "next/server";
import { readAppSettings } from "@/lib/settings";
import { badRequest, parseJsonObject, serverError } from "../../_helpers";
import { findExport, loadEmbeddingsModule, memoryRetrievalSettings } from "../_helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function readOptionalJson(req: NextRequest): Promise<Record<string, unknown> | undefined | "invalid"> {
  const raw = await req.text();
  if (!raw.trim()) return undefined;
  try {
    return parseJsonObject(JSON.parse(raw)) ?? "invalid";
  } catch {
    return "invalid";
  }
}

export async function POST(req: NextRequest) {
  const body = await readOptionalJson(req);
  if (body === "invalid") return badRequest("Invalid JSON");

  try {
    const settings = await readAppSettings();
    const loaded = await loadEmbeddingsModule();
    if (!loaded.available) {
      return NextResponse.json(
        {
          error: "memory embeddings are unavailable",
          reason: loaded.reason,
          settings: memoryRetrievalSettings(settings),
        },
        { status: 501 },
      );
    }

    const fn = findExport(loaded.module, [
      "rebuildMemoryEmbeddings",
      "rebuildEmbeddings",
      "rebuildMemoryEmbeddingIndex",
    ]);
    if (!fn) {
      return NextResponse.json(
        {
          error: "embeddings module does not export a rebuild function",
          settings: memoryRetrievalSettings(settings),
        },
        { status: 501 },
      );
    }

    const result = await fn({ settings, ...(body ?? {}) });
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    return serverError(err, "failed to rebuild memory embeddings");
  }
}
