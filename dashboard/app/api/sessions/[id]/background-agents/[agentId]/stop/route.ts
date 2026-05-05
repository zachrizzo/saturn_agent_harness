import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { toBedrockId } from "@/lib/claude-models";
import { isBedrockCli, isPersonalClaudeCli, normalizeCli } from "@/lib/clis";
import { parseStreamJsonl } from "@/lib/events";
import { readBedrockConfig } from "@/lib/bedrock-auth";
import { getSessionMeta, sessionDir } from "@/lib/runs";
import { binDir } from "@/lib/paths";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type StopTarget = {
  kind: "claude-task" | "codex-agent";
  id: string;
  description?: string;
  cliSessionId?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function eventRaw(event: { raw: unknown }): Record<string, unknown> {
  return asRecord(event.raw);
}

function isMissingClaudeConversationError(message: string): boolean {
  return /No conversation found with session ID/i.test(message);
}

async function appendStreamEvent(sessionId: string, event: Record<string, unknown>): Promise<void> {
  await fs.appendFile(
    path.join(sessionDir(sessionId), "stream.jsonl"),
    `${JSON.stringify(event)}\n`,
    "utf8",
  ).catch(() => {});
}

async function readTarget(sessionId: string, agentId: string): Promise<StopTarget | null> {
  const raw = await fs.readFile(path.join(sessionDir(sessionId), "stream.jsonl"), "utf8").catch(() => "");
  const events = parseStreamJsonl(raw);

  for (const event of events) {
    if (event.kind !== "tool_use" || event.id !== agentId || event.name !== "Agent") continue;
    const rawEvent = eventRaw(event);
    const input = asRecord(event.input);
    if (rawEvent.type === "system" && rawEvent.subtype === "task_started") {
      return {
        kind: "claude-task",
        id: agentId,
        description: stringValue(input.description),
        cliSessionId: stringValue(rawEvent.session_id),
      };
    }
    const receiverThreadId = stringValue(input.receiver_thread_id) ?? agentId;
    return {
      kind: "codex-agent",
      id: receiverThreadId,
      description: stringValue(input.description),
    };
  }

  return null;
}

function runCommand(
  command: string,
  args: string[],
  input: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = 30_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1500).unref?.();
    }, timeoutMs);
    timer.unref?.();

    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr });
    });
    child.stdin.end(input);
  });
}

async function runClaudeTaskStop(args: {
  cliSessionId: string;
  taskId: string;
  cli: string;
  model?: string;
  reasoningEffort?: string | null;
}): Promise<void> {
  const cli = normalizeCli(args.cli);
  const isBedrock = isBedrockCli(cli);
  const isPersonal = isPersonalClaudeCli(cli);
  const bedrock = isBedrock ? await readBedrockConfig() : undefined;
  const commandArgs = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--dangerously-skip-permissions",
    "--resume",
    args.cliSessionId,
    "--allowedTools",
    "TaskStop",
  ];
  const model = isBedrock ? toBedrockId(args.model) : args.model;
  if (model) commandArgs.push("--model", model);
  if (args.reasoningEffort) commandArgs.push("--effort", args.reasoningEffort);
  if (isBedrock && bedrock) {
    commandArgs.push("--settings", JSON.stringify({
      awsAuthRefresh: [
        path.join(binDir(), "bedrock-auth-refresh.sh"),
        bedrock.profile,
        bedrock.region,
      ].map(shellQuote).join(" "),
      env: {
        CLAUDE_CODE_USE_BEDROCK: "1",
        AWS_PROFILE: bedrock.profile,
        AWS_REGION: bedrock.region,
        AWS_DEFAULT_REGION: bedrock.region,
        AWS_SDK_LOAD_CONFIG: "1",
      },
    }));
  }
  if (isPersonal) commandArgs.push("--setting-sources", "project,local");

  const prompt = `Stop the background task now. Use TaskStop with task_id ${JSON.stringify(args.taskId)}. Do not perform any other work.`;
  const result = await runCommand("claude", commandArgs, prompt, {
    ...process.env,
    ...(isBedrock && bedrock ? {
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_PROFILE: bedrock.profile,
      AWS_REGION: bedrock.region,
      AWS_DEFAULT_REGION: bedrock.region,
      AWS_SDK_LOAD_CONFIG: "1",
    } : {}),
    ...(isPersonal ? {
      CLAUDE_CODE_USE_BEDROCK: "",
      CLAUDE_CODE_USE_VERTEX: "",
      ANTHROPIC_BASE_URL: "",
      ANTHROPIC_AUTH_TOKEN: "",
    } : {}),
  });
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `claude exited ${result.signal ?? result.code}`);
  }
}

async function runCodexCloseAgent(args: {
  threadId: string;
  agentId: string;
  model?: string;
  reasoningEffort?: string | null;
  cwd?: string;
}): Promise<void> {
  const commandArgs = [
    path.join(binDir(), "codex-app-server-turn.mjs"),
    "--mode",
    "default",
    "--thread-id",
    args.threadId,
  ];
  if (args.model) commandArgs.push("--model", args.model);
  if (args.reasoningEffort) commandArgs.push("--effort", args.reasoningEffort);
  if (args.cwd) commandArgs.push("--cwd", args.cwd);

  const prompt = `Close the background agent with id ${JSON.stringify(args.agentId)} now. Use close_agent. Do not perform any other work.`;
  const result = await runCommand("node", commandArgs, prompt, process.env, 30_000);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `codex close_agent exited ${result.signal ?? result.code}`);
  }
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; agentId: string }> },
) {
  const { id, agentId } = await params;
  const meta = await getSessionMeta(id);
  if (!meta) return NextResponse.json({ error: "not found" }, { status: 404 });

  const target = await readTarget(id, agentId);
  if (!target) return NextResponse.json({ error: "background agent not found" }, { status: 404 });

  const last = meta.turns.at(-1);
  const cli = normalizeCli(last?.cli ?? meta.agent_snapshot?.cli ?? "claude-bedrock");
  const model = last?.model ?? meta.agent_snapshot?.model;
  const reasoningEffort = last?.reasoningEffort ?? meta.agent_snapshot?.reasoningEffort;
  const now = new Date().toISOString();

  await appendStreamEvent(id, {
    type: "system",
    subtype: "task_progress",
    task_id: target.id,
    description: `Stopping ${target.description ?? "background agent"}`,
    last_tool_name: "TaskStop",
    at: now,
  });

  try {
    if (target.kind === "claude-task") {
      const cliSessionId = target.cliSessionId ?? last?.cli_session_id;
      if (!cliSessionId) throw new Error("missing Claude session id for background task");
      await runClaudeTaskStop({
        cliSessionId,
        taskId: target.id,
        cli,
        model,
        reasoningEffort,
      });
    } else {
      const threadId = last?.cli_session_id;
      if (!threadId) throw new Error("missing Codex thread id for background agent");
      await runCodexCloseAgent({
        threadId,
        agentId: target.id,
        model,
        reasoningEffort,
        cwd: meta.agent_snapshot?.cwd,
      });
    }

    await appendStreamEvent(id, {
      type: "system",
      subtype: "task_notification",
      task_id: target.id,
      status: "canceled",
      summary: target.description ?? "Background agent",
      at: new Date().toISOString(),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (target.kind === "claude-task" && isMissingClaudeConversationError(message)) {
      await appendStreamEvent(id, {
        type: "system",
        subtype: "task_notification",
        task_id: target.id,
        status: "canceled",
        summary: `${target.description ?? "Background agent"} stopped locally; Claude control session was already gone.`,
        at: new Date().toISOString(),
      });
      return NextResponse.json({ ok: true, markedStopped: true, warning: message });
    }

    await appendStreamEvent(id, {
      type: "system",
      subtype: "task_notification",
      task_id: target.id,
      status: "failed",
      summary: `Failed to stop: ${message}`,
      at: new Date().toISOString(),
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
