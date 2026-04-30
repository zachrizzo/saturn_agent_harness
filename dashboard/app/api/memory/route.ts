import { NextRequest, NextResponse } from "next/server";
import { listMemoryNotes, searchMemory, upsertMemoryNote } from "@/lib/memory";
import {
  badRequest,
  cleanString,
  cleanStringList,
  parseBodyScope,
  parseJsonObject,
  parseMemoryType,
  parseQueryFilters,
  serverError,
} from "./_helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function callSearchMemory(q: string, filters: Record<string, unknown>) {
  const fn = searchMemory as unknown as (...args: unknown[]) => Promise<unknown>;
  return fn.length >= 2 ? fn(q, filters) : fn({ q, query: q, ...filters });
}

export async function GET(req: NextRequest) {
  const q = cleanString(req.nextUrl.searchParams.get("q"));
  const filters = parseQueryFilters(req.nextUrl.searchParams);
  if ("error" in filters) return badRequest(filters.error);

  try {
    if (q) {
      const result = await callSearchMemory(q, filters);
      const results = Array.isArray(result)
        ? result
        : parseJsonObject(result)?.results ?? parseJsonObject(result)?.notes ?? [];
      return NextResponse.json({
        results,
        notes: results,
        index: parseJsonObject(result)?.index,
      });
    }

    const notes = await listMemoryNotes(filters);
    return NextResponse.json({
      notes: Array.isArray(notes) ? notes : parseJsonObject(notes)?.notes ?? [],
      index: parseJsonObject(notes)?.index,
    });
  } catch (err) {
    return serverError(err, "failed to load memory");
  }
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    const parsed = parseJsonObject(await req.json());
    if (!parsed) return badRequest("JSON object body is required");
    body = parsed;
  } catch {
    return badRequest("Invalid JSON");
  }

  const title = cleanString(body.title);
  const content = typeof body.content === "string" ? body.content : "";
  if (!title) return badRequest("title is required");
  if (body.content !== undefined && typeof body.content !== "string") {
    return badRequest("content must be a string");
  }

  const type = parseMemoryType(body.type);
  if (body.type !== undefined && !type) {
    return badRequest("type must be one of Entities, Concepts, Projects, Decisions, Troubleshooting, or Sessions");
  }

  const tags = cleanStringList(body.tags);
  if (body.tags !== undefined && tags === undefined) {
    return badRequest("tags must be an array or comma-separated string");
  }

  const aliases = cleanStringList(body.aliases);
  if (body.aliases !== undefined && aliases === undefined) {
    return badRequest("aliases must be an array or comma-separated string");
  }

  const scope = parseBodyScope(body);
  if ("error" in scope) return badRequest(scope.error);

  try {
    const note = await upsertMemoryNote({
      ...(cleanString(body.id) ? { id: cleanString(body.id) } : {}),
      title,
      content,
      ...(type ? { type } : {}),
      ...scope,
      ...(tags ? { tags } : {}),
      ...(aliases ? { aliases } : {}),
    });
    return NextResponse.json({ note });
  } catch (err) {
    return serverError(err, "failed to save memory");
  }
}
