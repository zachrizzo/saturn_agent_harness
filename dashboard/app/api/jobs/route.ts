import { NextResponse } from "next/server";
import path from "node:path";
import { spawn } from "child_process";
import { createJob, listJobs, type Job } from "@/lib/runs";
import { binDir } from "@/lib/paths";
import { toClaudeAlias } from "@/lib/claude-models";
import { normalizeCli, isCli } from "@/lib/clis";
import { isModelReasoningEffort, normalizeReasoningEffortForCli, type ModelReasoningEffort } from "@/lib/models";
import parser from "cron-parser";

export const dynamic = "force-dynamic";

export async function GET() {
  const jobs = await listJobs();
  return NextResponse.json({ jobs });
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = (body.name as string | undefined)?.trim();
  const cron = (body.cron as string | undefined)?.trim();
  const prompt = (body.prompt as string | undefined)?.trim();

  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });
  if (!cron) return NextResponse.json({ error: "cron is required" }, { status: 400 });
  if (!prompt) return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name))
    return NextResponse.json({ error: "name must be lowercase alphanumeric with hyphens" }, { status: 400 });

  try {
    parser.parseExpression(cron);
  } catch {
    return NextResponse.json({ error: "Invalid cron expression" }, { status: 400 });
  }

  if (body.cli !== undefined && body.cli !== "claude" && !isCli(body.cli as string)) {
    return NextResponse.json({ error: "cli must be 'claude-bedrock', 'claude-personal', 'claude-local', or 'codex'" }, { status: 400 });
  }
  if (
    body.reasoningEffort !== undefined &&
    !isModelReasoningEffort(body.reasoningEffort)
  ) {
    return NextResponse.json({ error: "invalid reasoningEffort" }, { status: 400 });
  }
  const timeoutSeconds = body.timeout_seconds === undefined ? undefined : Number(body.timeout_seconds);
  if (timeoutSeconds !== undefined && (!Number.isInteger(timeoutSeconds) || timeoutSeconds <= 0)) {
    return NextResponse.json({ error: "timeout_seconds must be a positive integer" }, { status: 400 });
  }
  if (body.catchUpMissedRuns !== undefined && typeof body.catchUpMissedRuns !== "boolean") {
    return NextResponse.json({ error: "catchUpMissedRuns must be a boolean" }, { status: 400 });
  }

  const allowedTools = (() => {
    if (body.allowedTools === undefined) return undefined;
    if (Array.isArray(body.allowedTools)) {
      return body.allowedTools
        .filter((tool): tool is string => typeof tool === "string")
        .map((tool) => tool.trim())
        .filter(Boolean);
    }
    if (typeof body.allowedTools === "string") {
      return body.allowedTools.split(",").map((tool) => tool.trim()).filter(Boolean);
    }
    return null;
  })();
  if (allowedTools === null) {
    return NextResponse.json({ error: "allowedTools must be an array or comma-separated string" }, { status: 400 });
  }

  const cli = body.cli && isCli(body.cli as string) ? normalizeCli(body.cli as string) : undefined;
  const reasoningEffort = body.reasoningEffort
    ? normalizeReasoningEffortForCli(cli ?? "claude-bedrock", body.reasoningEffort as ModelReasoningEffort)
    : undefined;

  const job: Job = {
    name,
    cron,
    prompt,
    ...(body.description ? { description: body.description as string } : {}),
    ...(body.cwd ? { cwd: body.cwd as string } : {}),
    ...(allowedTools ? { allowedTools } : {}),
    ...(cli ? { cli } : {}),
    ...(body.model ? { model: toClaudeAlias(body.model as string) ?? (body.model as string) } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(timeoutSeconds ? { timeout_seconds: timeoutSeconds } : {}),
    ...(body.catchUpMissedRuns === true ? { catchUpMissedRuns: true } : {}),
  };

  try {
    const created = await createJob(job);
    const register = path.join(binDir(), "register-job.sh");
    const proc = spawn(register, [name], { detached: true, stdio: "ignore" });
    proc.on("error", () => {});
    proc.unref();
    return NextResponse.json({ job: created }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed";
    if (message.startsWith("Job already exists")) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
