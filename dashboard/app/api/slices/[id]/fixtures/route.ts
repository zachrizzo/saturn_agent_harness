import { NextRequest, NextResponse } from "next/server";
import { listFixtures, saveFixture, type SliceFixture } from "@/lib/slice-fixtures";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const fixtures = await listFixtures(id);
  return NextResponse.json({ fixtures });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = (await req.json()) as SliceFixture;
  if (!body.name) {
    return NextResponse.json({ error: "name required" }, { status: 400 });
  }
  await saveFixture(id, body);
  return NextResponse.json({ saved: true });
}
