import { NextRequest, NextResponse } from "next/server";
import { getSlice, updateSlice, deleteSlice, type Slice } from "@/lib/slices";
import { toClaudeAlias } from "@/lib/claude-models";
import { normalizeCli } from "@/lib/clis";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const slice = await getSlice(id);
  if (!slice) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ slice });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const patch = (await req.json()) as Partial<Slice> & Record<string, unknown>;
  delete patch.id;
  delete patch.created_at;
  delete patch.version;
  // Normalize Bedrock IDs to short aliases before writing to slices.json.
  if (patch.model) patch.model = toClaudeAlias(patch.model as string) ?? (patch.model as string);
  if (patch.cli) patch.cli = normalizeCli(patch.cli);
  try {
    const slice = await updateSlice(id, patch);
    return NextResponse.json({ slice });
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed";
    if (message.startsWith("Slice not found")) {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await deleteSlice(id);
    return new NextResponse(null, { status: 204 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed";
    if (message.startsWith("Slice not found")) {
      return NextResponse.json({ error: message }, { status: 404 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
