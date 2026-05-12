import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { sessionDir, type PinnedContextItem, type SessionMeta } from "@/lib/runs";
import { withSessionMetaLock } from "@/lib/session-meta-lock";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type PinBody = {
  id?: string;
  text?: string;
  role?: PinnedContextItem["role"];
  label?: string;
  source_turn?: number;
};

function cleanText(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function cleanRole(value: unknown): PinnedContextItem["role"] {
  return value === "user" || value === "assistant" || value === "tool" || value === "context"
    ? value
    : "context";
}

function pinKey(pin: Pick<PinnedContextItem, "role" | "text" | "source_turn">): string {
  return [
    pin.role ?? "context",
    pin.source_turn ?? "",
    pin.text.replace(/\s+/g, " ").trim(),
  ].join("\u0000");
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as PinBody;
  const text = cleanText(body.text, 12_000);
  if (!text) return NextResponse.json({ error: "text is required" }, { status: 400 });

  const item: PinnedContextItem = {
    id: randomUUID(),
    text,
    role: cleanRole(body.role),
    label: cleanText(body.label, 80) || undefined,
    source_turn: typeof body.source_turn === "number" && Number.isInteger(body.source_turn)
      ? Math.max(0, body.source_turn)
      : undefined,
    created_at: new Date().toISOString(),
  };

  try {
    const meta = await withSessionMetaLock(id, async () => {
      const metaPath = path.join(sessionDir(id), "meta.json");
      const meta = JSON.parse(await fs.readFile(metaPath, "utf8")) as SessionMeta;
      const existing = meta.pinned_context ?? [];
      const keys = new Set(existing.map(pinKey));
      const next = keys.has(pinKey(item)) ? existing : [item, ...existing].slice(0, 30);
      meta.pinned_context = next;
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");
      return meta;
    });
    return NextResponse.json({ ok: true, item, meta });
  } catch (err) {
    const message = err instanceof Error ? err.message : "pin failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as PinBody;
  const pinId = cleanText(body.id, 200);
  if (!pinId) return NextResponse.json({ error: "id is required" }, { status: 400 });

  try {
    const meta = await withSessionMetaLock(id, async () => {
      const metaPath = path.join(sessionDir(id), "meta.json");
      const meta = JSON.parse(await fs.readFile(metaPath, "utf8")) as SessionMeta;
      meta.pinned_context = (meta.pinned_context ?? []).filter((item) => item.id !== pinId);
      if (meta.pinned_context.length === 0) delete meta.pinned_context;
      await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), "utf8");
      return meta;
    });
    return NextResponse.json({ ok: true, meta });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unpin failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
