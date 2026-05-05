import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { spawn } from "child_process";
import parser from "cron-parser";
import { deleteJob, getJob, updateJob } from "@/lib/runs";
import { binDir } from "@/lib/paths";
import { toClaudeAlias } from "@/lib/claude-models";
import { isModelReasoningEffort, normalizeReasoningEffortForCli, type ModelReasoningEffort } from "@/lib/models";
import { isCli, normalizeCli, type LegacyCLI } from "@/lib/clis";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function syncCron(name: string) {
  const register = path.join(binDir(), "register-job.sh");
  const proc = spawn(register, [name], { detached: true, stdio: "ignore" });
  proc.on("error", () => {});
  proc.unref();
}

function parseAllowedTools(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.filter((tool): tool is string => typeof tool === "string").map((tool) => tool.trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((tool) => tool.trim()).filter(Boolean);
  }
  return undefined;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const job = await getJob(name);
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });
  return NextResponse.json({ job });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const existing = await getJob(name);
  if (!existing) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch: Parameters<typeof updateJob>[1] = {};

  if (body.cron !== undefined) {
    const cron = typeof body.cron === "string" ? body.cron.trim() : "";
    if (!cron) {
      return NextResponse.json({ error: "cron is required" }, { status: 400 });
    }
    try {
      parser.parseExpression(cron);
    } catch {
      return NextResponse.json({ error: "Invalid cron expression" }, { status: 400 });
    }
    patch.cron = cron;
  }

  if (body.prompt !== undefined) {
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (!prompt) {
      return NextResponse.json({ error: "prompt must be a non-empty string" }, { status: 400 });
    }
    patch.prompt = prompt;
  }

  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== "string") {
      return NextResponse.json({ error: "description must be a string or null" }, { status: 400 });
    }
    patch.description = body.description === null ? null : body.description.trim();
  }

  if (body.cwd !== undefined) {
    if (body.cwd !== null && typeof body.cwd !== "string") {
      return NextResponse.json({ error: "cwd must be a string or null" }, { status: 400 });
    }
    patch.cwd = body.cwd === null ? null : body.cwd.trim();
  }

  const allowedTools = parseAllowedTools(body.allowedTools);
  if (body.allowedTools !== undefined && allowedTools === undefined) {
    return NextResponse.json({ error: "allowedTools must be an array, comma-separated string, or null" }, { status: 400 });
  }
  if (allowedTools !== undefined) patch.allowedTools = allowedTools;

  const cliValue = body.cli;
  if (cliValue !== undefined) {
    if (cliValue !== null && cliValue !== "claude" && !isCli(cliValue)) {
      return NextResponse.json({ error: "cli must be 'claude-bedrock', 'claude-personal', 'claude-local', 'codex', or null" }, { status: 400 });
    }
    patch.cli = cliValue === null ? null : normalizeCli(cliValue as LegacyCLI);
  }

  if (body.model !== undefined) {
    if (body.model !== null && typeof body.model !== "string") {
      return NextResponse.json({ error: "model must be a string or null" }, { status: 400 });
    }
    patch.model = body.model === null ? null : (toClaudeAlias(body.model) ?? body.model);
  }

  if (body.reasoningEffort !== undefined) {
    const effort = body.reasoningEffort as ModelReasoningEffort | null;
    if (effort !== null && !isModelReasoningEffort(effort)) {
      return NextResponse.json({ error: "invalid reasoningEffort" }, { status: 400 });
    }
    const cli = patch.cli ?? existing.cli ?? "claude-bedrock";
    patch.reasoningEffort = effort === null ? null : normalizeReasoningEffortForCli(cli, effort);
  }

  if (body.timeout_seconds !== undefined) {
    if (body.timeout_seconds === null) {
      patch.timeout_seconds = null;
    } else {
      const timeout = Number(body.timeout_seconds);
      if (!Number.isInteger(timeout) || timeout <= 0) {
        return NextResponse.json({ error: "timeout_seconds must be a positive integer or null" }, { status: 400 });
      }
      patch.timeout_seconds = timeout;
    }
  }

  if (body.catchUpMissedRuns !== undefined) {
    if (typeof body.catchUpMissedRuns !== "boolean") {
      return NextResponse.json({ error: "catchUpMissedRuns must be a boolean" }, { status: 400 });
    }
    patch.catchUpMissedRuns = body.catchUpMissedRuns;
  }

  try {
    const job = await updateJob(name, patch);
    if (patch.cron !== undefined && patch.cron !== existing.cron) syncCron(name);
    return NextResponse.json({ job });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const existing = await getJob(name);
  if (!existing) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  try {
    const job = await deleteJob(name);
    syncCron(name);
    return NextResponse.json({ deleted: true, job });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed" }, { status: 500 });
  }
}
