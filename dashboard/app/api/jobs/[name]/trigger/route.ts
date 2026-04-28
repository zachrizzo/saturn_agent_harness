import { NextRequest, NextResponse } from "next/server";
import { getJob, triggerJob } from "@/lib/runs";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;

  const job = await getJob(name);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const model = body.model as string | undefined;

  try {
    const runSlug = await triggerJob(name, model);
    return NextResponse.json({ runSlug });
  } catch (error) {
    console.error("Error triggering job:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to trigger job" },
      { status: 500 }
    );
  }
}
