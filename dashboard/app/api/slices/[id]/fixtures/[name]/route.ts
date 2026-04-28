import { NextRequest, NextResponse } from "next/server";
import { getFixture, deleteFixture, evaluateAssertions } from "@/lib/slice-fixtures";
import { executeSlice } from "@/lib/slice-executor";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  const { id, name } = await params;
  const fixture = await getFixture(id, name);
  if (!fixture) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ fixture });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  const { id, name } = await params;
  await deleteFixture(id, name);
  return NextResponse.json({ deleted: true });
}

// POST /api/slices/[id]/fixtures/[name]/run
// Actually runs the slice with this fixture's inputs and evaluates the
// assertions. Returns { result, outcomes, all_passed }.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  const { id, name } = await params;
  const fixture = await getFixture(id, name);
  if (!fixture) return NextResponse.json({ error: "fixture not found" }, { status: 404 });

  const result = await executeSlice({
    sessionId: `fixture-${id}-${name}-${Date.now()}`,
    sliceId: id,
    inputs: fixture.inputs,
  });

  const outcomes = evaluateAssertions(
    {
      status: result.status,
      output: result.output,
      tokens: { total: result.tokens.total },
      duration_ms: result.duration_ms,
    },
    fixture.assertions ?? [],
  );
  const all_passed = outcomes.every((o) => o.passed);

  return NextResponse.json({
    fixture_name: fixture.name,
    all_passed,
    outcomes,
    result,
  });
}
