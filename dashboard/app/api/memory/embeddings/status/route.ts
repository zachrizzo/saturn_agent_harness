import { NextResponse } from "next/server";
import { readAppSettings } from "@/lib/settings";
import { findExport, loadEmbeddingsModule, memoryRetrievalSettings } from "../_helpers";
import { serverError } from "../../_helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const settings = await readAppSettings();
    const loaded = await loadEmbeddingsModule();
    if (!loaded.available) {
      return NextResponse.json({
        available: false,
        reason: loaded.reason,
        settings: memoryRetrievalSettings(settings),
      });
    }

    const fn = findExport(loaded.module, [
      "getMemoryEmbeddingsStatus",
      "getEmbeddingsStatus",
      "getEmbeddingStatus",
      "memoryEmbeddingsStatus",
    ]);
    if (!fn) {
      return NextResponse.json({
        available: true,
        status: "unavailable",
        reason: "embeddings module does not export a status function",
        settings: memoryRetrievalSettings(settings),
      });
    }

    const status = await fn({ settings });
    return NextResponse.json({
      available: true,
      settings: memoryRetrievalSettings(settings),
      status,
    });
  } catch (err) {
    return serverError(err, "failed to load embeddings status");
  }
}
