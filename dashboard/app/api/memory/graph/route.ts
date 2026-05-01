import { NextRequest, NextResponse } from "next/server";
import { getMemoryGraph } from "@/lib/memory";
import { badRequest, cleanString, parseQueryFilters, serverError } from "../_helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const filters = parseQueryFilters(req.nextUrl.searchParams);
  if ("error" in filters) return badRequest(filters.error);

  try {
    const graph = await getMemoryGraph({
      ...filters,
      ...(cleanString(req.nextUrl.searchParams.get("q")) ? { q: cleanString(req.nextUrl.searchParams.get("q")) } : {}),
      semantic: req.nextUrl.searchParams.get("semantic") === "1" || req.nextUrl.searchParams.get("semantic") === "true",
    });
    return NextResponse.json(graph);
  } catch (err) {
    return serverError(err, "failed to load memory graph");
  }
}
