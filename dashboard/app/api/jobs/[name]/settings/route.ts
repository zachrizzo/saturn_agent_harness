import { NextRequest, NextResponse } from "next/server";
import { getJob, updateJobSettings } from "@/lib/runs";
import { toClaudeAlias } from "@/lib/claude-models";
import { normalizeReasoningEffortForCli, type ModelReasoningEffort } from "@/lib/models";
import { isCli, normalizeCli, type LegacyCLI } from "@/lib/clis";

export const dynamic = "force-dynamic";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;

  const job = await getJob(name);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const body = await request.json();
  const { model, cli, reasoningEffort } = body as {
    model?: string | null;
    cli?: LegacyCLI;
    reasoningEffort?: ModelReasoningEffort | null;
  };

  if (cli !== undefined && cli !== "claude" && !isCli(cli)) {
    return NextResponse.json({ error: "cli must be 'claude-bedrock', 'claude-personal', 'claude-local', or 'codex'" }, { status: 400 });
  }
  if (
    reasoningEffort !== undefined &&
    reasoningEffort !== null &&
    !["minimal", "low", "medium", "high", "xhigh", "max"].includes(reasoningEffort)
  ) {
    return NextResponse.json({ error: "invalid reasoningEffort" }, { status: 400 });
  }

  // Normalize Bedrock IDs to short aliases before writing to jobs.json so the
  // stored value is always `claude-sonnet-4-6` not `global.anthropic.claude-sonnet-4-6`.
  const normalizedModel = model != null ? (toClaudeAlias(model) ?? model) : model;
  const normalizedCli = cli !== undefined ? normalizeCli(cli) : undefined;
  const normalizedEffort = reasoningEffort === null
    ? null
    : normalizeReasoningEffortForCli(normalizedCli ?? job.cli ?? "claude-bedrock", reasoningEffort);

  try {
    await updateJobSettings(name, { model: normalizedModel, cli: normalizedCli, reasoningEffort: normalizedEffort });
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
