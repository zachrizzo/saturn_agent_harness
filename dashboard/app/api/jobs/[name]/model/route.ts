import { NextRequest, NextResponse } from "next/server";
import { getJob, updateJobModel } from "@/lib/runs";
import { toClaudeAlias } from "@/lib/claude-models";
import { isBedrockCli } from "@/lib/clis";

export const dynamic = "force-dynamic";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;

  const job = await getJob(name);
  if (!job) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const body = await request.json();
  const model = body.model as string;

  if (!model || typeof model !== "string") {
    return NextResponse.json({ error: "Model ID is required" }, { status: 400 });
  }

  // Legacy route: only Bedrock jobs require Anthropic/Claude-shaped model IDs.
  if (isBedrockCli(job.cli) && !model.includes("anthropic") && !model.includes("claude")) {
    return NextResponse.json({ error: "Invalid Bedrock model ID format" }, { status: 400 });
  }

  try {
    const normalizedModel = isBedrockCli(job.cli) ? (toClaudeAlias(model) ?? model) : model;
    await updateJobModel(name, normalizedModel);
    return NextResponse.json({ success: true, model: normalizedModel });
  } catch (error) {
    console.error("Error updating job model:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update model" },
      { status: 500 }
    );
  }
}
