import { NextRequest, NextResponse } from "next/server";
import { buildMemoryRecallBlock, searchMemory } from "@/lib/memory";
import { readAppSettings } from "@/lib/settings";
import { badRequest, cleanString, parseJsonObject, parseLimit, projectScopeForCwd, serverError } from "../_helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function callSearchMemory(q: string, filters: Record<string, unknown>) {
  const fn = searchMemory as unknown as (...args: unknown[]) => Promise<unknown>;
  return fn.length >= 2 ? fn(q, filters) : fn({ q, query: q, ...filters });
}

async function callBuildMemoryRecallBlock(message: string, options: Record<string, unknown>) {
  const fn = buildMemoryRecallBlock as unknown as (...args: unknown[]) => Promise<unknown>;
  return fn.length >= 2 ? fn(message, options) : fn({ message, ...options });
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

  const message = cleanString(body.message);
  if (!message) return badRequest("message is required");

  const settings = await readAppSettings();
  const limit = parseLimit(body.limit, settings.memoryRecallLimit);
  if (body.limit !== undefined && limit === undefined) {
    return badRequest("limit must be an integer from 1 to 100");
  }

  const cwd = cleanString(body.cwd);
  const options = {
    ...(cwd ? { cwd, projectScope: projectScopeForCwd(cwd) } : {}),
    ...(limit ? { limit } : {}),
  };

  try {
    const [blockResult, searchResult] = await Promise.all([
      callBuildMemoryRecallBlock(message, options),
      callSearchMemory(message, { scope: "all", ...options }),
    ]);
    const blockRecord = parseJsonObject(blockResult);
    const searchRecord = parseJsonObject(searchResult);
    const results = Array.isArray(searchResult)
      ? searchResult
      : searchRecord?.results ?? searchRecord?.notes ?? [];

    return NextResponse.json({
      block: typeof blockResult === "string" ? blockResult : blockRecord?.block ?? "",
      results,
    });
  } catch (err) {
    return serverError(err, "failed to recall memory");
  }
}
