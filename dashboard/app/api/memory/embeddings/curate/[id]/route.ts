import { NextRequest, NextResponse } from "next/server";
import { readAppSettings } from "@/lib/settings";
import { badRequest, parseJsonObject, serverError } from "../../../_helpers";
import { findExport, loadEmbeddingsModule, memoryRetrievalSettings } from "../../_helpers";

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

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await readOptionalJson(req);
  if (body === "invalid") return badRequest("Invalid JSON");

  try {
    const settings = await readAppSettings();
    const loaded = await loadEmbeddingsModule();
    if (!loaded.available) {
      return NextResponse.json(
        {
          error: "memory curator is unavailable",
          reason: loaded.reason,
          settings: memoryRetrievalSettings(settings),
        },
        { status: 501 },
      );
    }

    const fn = findExport(loaded.module, [
      "curateMemorySession",
      "curateSessionMemory",
      "curateMemory",
    ]);
    if (!fn) {
      return NextResponse.json(
        {
          error: "embeddings module does not export a curator function",
          settings: memoryRetrievalSettings(settings),
        },
        { status: 501 },
      );
    }

    const payload = { sessionId: id, settings, ...(body ?? {}) };
    const result = fn.length >= 2 ? await fn(id, payload) : await fn(payload);
    return NextResponse.json({ ok: true, session_id: id, result });
  } catch (err) {
    return serverError(err, "failed to curate memory");
  }
}
