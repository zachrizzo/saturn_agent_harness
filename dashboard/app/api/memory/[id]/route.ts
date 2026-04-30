import { NextRequest, NextResponse } from "next/server";
import { deleteMemoryNote, getMemoryNote, upsertMemoryNote } from "@/lib/memory";
import {
  badRequest,
  cleanString,
  cleanStringList,
  hasOwn,
  parseBodyScope,
  parseJsonObject,
  parseMemoryType,
  serverError,
} from "../_helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function unwrapNote(result: unknown): Record<string, unknown> | undefined {
  const record = parseJsonObject(result);
  if (!record) return undefined;
  return parseJsonObject(record.note) ?? record;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const note = unwrapNote(await getMemoryNote(id));
    if (!note) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ note });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return serverError(err, "failed to load memory");
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    const parsed = parseJsonObject(await req.json());
    if (!parsed) return badRequest("JSON object body is required");
    body = parsed;
  } catch {
    return badRequest("Invalid JSON");
  }

  let existing: Record<string, unknown> | undefined;
  try {
    existing = unwrapNote(await getMemoryNote(id));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return serverError(err, "failed to load memory");
  }
  if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

  const patch: Record<string, unknown> = {};
  if (hasOwn(body, "title")) {
    const title = cleanString(body.title);
    if (!title) return badRequest("title must be a non-empty string");
    patch.title = title;
  }
  if (hasOwn(body, "content")) {
    if (typeof body.content !== "string") return badRequest("content must be a string");
    patch.content = body.content;
  }
  if (hasOwn(body, "type")) {
    const type = parseMemoryType(body.type);
    if (!type) {
      return badRequest("type must be one of Entities, Concepts, Projects, Decisions, Troubleshooting, or Sessions");
    }
    patch.type = type;
  }
  if (hasOwn(body, "tags")) {
    const tags = cleanStringList(body.tags);
    if (tags === undefined) return badRequest("tags must be an array or comma-separated string");
    patch.tags = tags;
  }
  if (hasOwn(body, "aliases")) {
    const aliases = cleanStringList(body.aliases);
    if (aliases === undefined) return badRequest("aliases must be an array or comma-separated string");
    patch.aliases = aliases;
  }
  if (hasOwn(body, "scope") || hasOwn(body, "cwd")) {
    const scope = parseBodyScope(body);
    if ("error" in scope) return badRequest(scope.error);
    Object.assign(patch, scope);
  }

  try {
    const note = await upsertMemoryNote({ ...existing, ...patch, id });
    return NextResponse.json({ note });
  } catch (err) {
    return serverError(err, "failed to update memory");
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await deleteMemoryNote(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return NextResponse.json({ error: "not found" }, { status: 404 });
    return serverError(err, "failed to delete memory");
  }
}
