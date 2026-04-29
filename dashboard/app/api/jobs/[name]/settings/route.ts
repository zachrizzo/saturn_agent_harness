import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { spawn } from "child_process";
import { getJob, updateJobSettings } from "@/lib/runs";
import { binDir } from "@/lib/paths";
import { toClaudeAlias } from "@/lib/claude-models";
import { normalizeReasoningEffortForCli, type ModelReasoningEffort } from "@/lib/models";
import { isCli, normalizeCli, type LegacyCLI } from "@/lib/clis";
import parser from "cron-parser";

export const dynamic = "force-dynamic";

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const { name } = await params;

  const job = await getJob(name);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { model, cli, reasoningEffort, cron } = body as {
    model?: string | null;
    cli?: LegacyCLI;
    reasoningEffort?: ModelReasoningEffort | null;
    cron?: unknown;
  };

  const normalizedCron = typeof cron === "string" ? cron.trim() : undefined;
  if (cron !== undefined) {
    if (typeof cron !== "string") {
      return NextResponse.json({ error: "cron must be a string" }, { status: 400 });
    }
    if (!normalizedCron) {
      return NextResponse.json({ error: "cron is required" }, { status: 400 });
    }
    try {
      parser.parseExpression(normalizedCron);
    } catch {
      return NextResponse.json({ error: "Invalid cron expression" }, { status: 400 });
    }
  }

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
    await updateJobSettings(name, {
      model: normalizedModel,
      cli: normalizedCli,
      reasoningEffort: normalizedEffort,
      cron: normalizedCron,
    });

    if (normalizedCron !== undefined && normalizedCron !== job.cron) {
      const register = path.join(binDir(), "register-job.sh");
      const proc = spawn(register, [name], { detached: true, stdio: "ignore" });
      proc.on("error", () => {});
      proc.unref();
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
