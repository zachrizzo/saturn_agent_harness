import { NextRequest, NextResponse } from "next/server";
import { removeDispatchConnection } from "@/lib/dispatch";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ chatId: string }> },
) {
  const { chatId } = await params;
  const result = await removeDispatchConnection(chatId);

  if (!result.removed) {
    return NextResponse.json({ error: "connection not found" }, { status: 404 });
  }

  return NextResponse.json(result);
}
