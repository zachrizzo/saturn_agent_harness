// Server-only helper to spawn run-turn.sh for a session.
import { createWriteStream } from "node:fs";
import type { WriteStream } from "node:fs";
import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn } from "child_process";
import { binDir, sessionsRoot } from "./paths";
import { isOrchestrator } from "./session-utils";
import { mintToken } from "./mcp/auth";
import { toBedrockId } from "./claude-models";
import type { CLI, Agent, PlanAction } from "./runs";
import type { ModelReasoningEffort } from "./models";
import { resolveReasoningEffortForCliModel } from "./model-capabilities";
import { isBedrockCli, isLocalClaudeCli, isPersonalClaudeCli, normalizeCli } from "./clis";
import { readBedrockConfig } from "./bedrock-auth";
import { readAppSettings, type AppSettings } from "./settings";
import { markSessionIfRunnerExited, markSessionRunnerFailed } from "./session-lifecycle";

// MCP tools added to allowedTools when a session has an explicit tool allow-list.
const ORCHESTRATOR_MCP_TOOLS = [
  "mcp__orchestrator__list_swarms",
  "mcp__orchestrator__dispatch_swarm",
  "mcp__orchestrator__list_jobs",
  "mcp__orchestrator__delete_job",
  "mcp__orchestrator__list_slices",
  "mcp__orchestrator__dispatch_slice",
  "mcp__orchestrator__run_slice_graph",
  "mcp__orchestrator__get_slice_graph_run",
  "mcp__orchestrator__dispatch_custom_slice",
  "mcp__orchestrator__get_budget",
  "mcp__orchestrator__stop",
];

type MemorySettings = AppSettings & {
  memoryEnabled?: boolean;
  memoryRecallLimit?: number;
  memoryAutoCapture?: boolean;
};

type MemoryModule = {
  buildMemoryRecallBlock?: (args: {
    query?: string;
    message: string;
    cwd?: string;
    limit?: number;
    sessionId: string;
    agentId?: string;
    agentName?: string;
  }) => string | Promise<string>;
};

async function loadMemoryModule(): Promise<MemoryModule | undefined> {
  try {
    return await import("./memory") as MemoryModule;
  } catch {
    return undefined;
  }
}

async function prepareMemoryEnv(
  sessionId: string,
  message: string,
  agentSnapshot?: Agent,
): Promise<Record<string, string>> {
  const extraEnv: Record<string, string> = {};
  let settings: MemorySettings | undefined;

  try {
    settings = await readAppSettings() as MemorySettings;
  } catch {
    return extraEnv;
  }

  if (typeof settings.memoryAutoCapture === "boolean") {
    extraEnv.SATURN_MEMORY_AUTO_CAPTURE = settings.memoryAutoCapture ? "1" : "0";
  }

  if (!settings.memoryEnabled) return extraEnv;

  try {
    const memory = await loadMemoryModule();
    const block = await memory?.buildMemoryRecallBlock?.({
      query: message,
      message,
      cwd: agentSnapshot?.cwd,
      limit: settings.memoryRecallLimit,
      sessionId,
      agentId: agentSnapshot?.id,
      agentName: agentSnapshot?.name,
    });

    if (typeof block !== "string" || !block.trim()) return extraEnv;

    const contextPath = path.join(sessionsRoot(), sessionId, "memory-context.txt");
    await fs.mkdir(path.dirname(contextPath), { recursive: true });
    await fs.writeFile(contextPath, block.trim(), "utf8");
    extraEnv.SATURN_MEMORY_CONTEXT_FILE = contextPath;
  } catch {
    // Memory recall is best-effort; turns must continue without it.
  }

  return extraEnv;
}

async function createReadyAppendStream(filePath: string): Promise<WriteStream> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const stream = createWriteStream(filePath, { flags: "a" });
  if (typeof (stream as { fd?: unknown }).fd === "number") return stream;

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      stream.off("open", onOpen);
      stream.off("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    stream.once("open", onOpen);
    stream.once("error", onError);
  });

  return stream;
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function removeTomlTable(source: string, tableName: string): string {
  const header = `[${tableName}]`;
  const lines = source.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === header) {
      skipping = true;
      continue;
    }
    if (skipping && trimmed.startsWith("[") && trimmed.endsWith("]")) {
      skipping = false;
    }
    if (!skipping) kept.push(line);
  }
  return kept.join("\n").trimEnd();
}

async function createCodexHomeWithMcp(sessionId: string, orchestratorUrl: string): Promise<string> {
  const sourceHome = process.env.CODEX_HOME ?? (process.env.HOME ? path.join(process.env.HOME, ".codex") : "");
  if (!sourceHome) throw new Error("CODEX_HOME or HOME is required for Codex orchestrator MCP");

  const codexHome = path.join(sessionsRoot(), sessionId, "codex-home");
  await fs.mkdir(codexHome, { recursive: true });
  const entries = await fs.readdir(sourceHome, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === "config.toml") continue;
    const src = path.join(sourceHome, entry.name);
    const dest = path.join(codexHome, entry.name);
    try {
      await fs.symlink(src, dest, entry.isDirectory() ? "dir" : "file");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }

  const baseConfig = await fs.readFile(path.join(sourceHome, "config.toml"), "utf8").catch(() => "");
  const config = `${removeTomlTable(baseConfig, "mcp_servers.orchestrator")}

[mcp_servers.orchestrator]
url = ${tomlString(orchestratorUrl)}
`;
  await fs.writeFile(path.join(codexHome, "config.toml"), config, { mode: 0o600 });
  return codexHome;
}

export async function spawnTurn(
  sessionId: string,
  cli: CLI,
  model: string | undefined,
  message: string,
  agentSnapshot?: Agent,
  mcpTools?: boolean,
  reasoningEffort?: ModelReasoningEffort,
  planAction?: PlanAction,
): Promise<void> {
  const script = path.join(binDir(), "run-turn.sh");
  const baseTools = agentSnapshot?.allowedTools ?? [];
  const normalizedCli = normalizeCli(cli);

  const isLocal = isLocalClaudeCli(normalizedCli);
  const isBedrock = isBedrockCli(normalizedCli);
  const isPersonal = isPersonalClaudeCli(normalizedCli);
  const bedrockConfig = isBedrock ? await readBedrockConfig() : undefined;
  const localModel = model ?? "gemma4:26b-it-q4_K_M";
  const localSmallModel = "gemma4:4b";

  // For Bedrock-backed Claude, expand short aliases like `claude-sonnet-4-6`
  // into the full inference profile ID the Bedrock API requires.
  const effectiveModel = isBedrock ? toBedrockId(model) : model;
  const requestedReasoningEffort =
    reasoningEffort ?? agentSnapshot?.reasoningEfforts?.[normalizedCli] ?? agentSnapshot?.reasoningEffort;
  const effectiveReasoningEffort = await resolveReasoningEffortForCliModel(
    normalizedCli,
    effectiveModel ?? model,
    requestedReasoningEffort,
  );

  const localProxyEnv = {
    CLAUDE_CODE_USE_BEDROCK: "0",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:4000",
    ANTHROPIC_AUTH_TOKEN: "sk-local-proxy-key",
    ANTHROPIC_MODEL: localModel,
    ANTHROPIC_SMALL_FAST_MODEL: localSmallModel,
  };

  const extraEnv: Record<string, string> = {
    CLI: normalizedCli,  // preserve UI-facing backend; run-turn.sh maps Claude-family backends to the claude binary
    MODEL: effectiveModel ?? "",
    REASONING_EFFORT: effectiveReasoningEffort ?? "",
    ...(await prepareMemoryEnv(sessionId, message, agentSnapshot)),
    ...(planAction ? { SATURN_PLAN_ACTION: planAction } : {}),
    ...(isLocal ? {
      ...localProxyEnv,
      CLAUDE_LOCAL_SETTINGS: JSON.stringify({
        model: localModel,
        alwaysThinkingEnabled: Boolean(effectiveReasoningEffort),
        effortLevel: effectiveReasoningEffort ?? "low",
        env: localProxyEnv,
      }),
    } : isBedrock ? {
      // Bedrock auth: the launchd-spawned dashboard has no AWS env, so inject
      // it explicitly. ~/.claude/settings.json has AWS_PROFILE/AWS_REGION but
      // not CLAUDE_CODE_USE_BEDROCK, so without this claude falls back to OAuth
      // and fails with "Not logged in · Please run /login".
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_PROFILE: bedrockConfig?.profile ?? "",
      AWS_REGION: bedrockConfig?.region ?? "",
      AWS_DEFAULT_REGION: bedrockConfig?.region ?? "",
      AWS_SDK_LOAD_CONFIG: "1",
    } : isPersonal ? {
      CLAUDE_CODE_USE_BEDROCK: "",
      CLAUDE_CODE_USE_VERTEX: "",
      ANTHROPIC_BASE_URL: "",
      ANTHROPIC_AUTH_TOKEN: "",
      CLAUDE_SETTING_SOURCES: "project,local",
    } : {}),
  };


  const port = process.env.PORT ?? "3737";

  // Expose the local orchestrator MCP to every chat. Swarm agents use it for
  // saved slice workflows; ordinary chat agents can use it to call saved swarms
  // or dispatch specialist slices when the conversation calls for delegation.
  if (agentSnapshot) {
    const token = mintToken(sessionId);
    const orchestratorUrl = `http://127.0.0.1:${port}/api/mcp/orchestrator/${sessionId}?token=${token}`;
    extraEnv.SATURN_ORCHESTRATOR_TOOLS = "1";

    if (normalizedCli === "codex") {
      extraEnv.CODEX_HOME = await createCodexHomeWithMcp(sessionId, orchestratorUrl);
    }

    if (isBedrock || isPersonal || isLocal) {
      const mcpConfig = {
        mcpServers: {
          orchestrator: {
            type: "http",
            url: orchestratorUrl,
          },
        },
      };
      const mcpConfigPath = path.join(sessionsRoot(), sessionId, "mcp-config.json");
      await fs.mkdir(path.dirname(mcpConfigPath), { recursive: true });
      await fs.writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), "utf8");

      extraEnv.MCP_CONFIG_PATH = mcpConfigPath;
      if (isLocal && mcpTools !== true) {
        extraEnv.STRICT_MCP = "1";
        extraEnv.CLAUDE_LOCAL_SETTINGS = JSON.stringify({
          model: localModel,
          alwaysThinkingEnabled: Boolean(effectiveReasoningEffort),
          effortLevel: effectiveReasoningEffort ?? "low",
          enabledPlugins: {},
          env: localProxyEnv,
        });
      }
      // If the saved agent already constrains tools, merge in the swarm tools.
      // Saved orchestrators use allowedTools: [] to mean "only the MCP swarm
      // surface"; ordinary chats without a tool allow-list keep the CLI default.
      if (baseTools.length > 0 || isOrchestrator(agentSnapshot)) {
        const allTools = [...new Set([...baseTools, ...ORCHESTRATOR_MCP_TOOLS])];
        extraEnv.ALLOWED_TOOLS_OVERRIDE = allTools.join(",");
      }
    }
  } else if (isLocal && baseTools.length === 0) {
    if (mcpTools === true) {
      extraEnv.ALLOWED_TOOLS_OVERRIDE = "ALL";
    } else {
      // --strict-mcp-config excludes project-level .mcp.json, but plugin MCPs
      // still load via the deferred-tools mechanism after the first tool_use.
      // enabledPlugins: {} in settings disables plugin loading entirely, which
      // is what actually gives fast prefill (~2K vs ~100K tokens).
      extraEnv.STRICT_MCP = "1";
      extraEnv.ALLOWED_TOOLS_OVERRIDE = "Bash,Read,Write,Edit,Glob,Grep";
      extraEnv.CLAUDE_LOCAL_SETTINGS = JSON.stringify({
        model: localModel,
        alwaysThinkingEnabled: Boolean(effectiveReasoningEffort),
        effortLevel: effectiveReasoningEffort ?? "low",
        enabledPlugins: {},
        env: localProxyEnv,
      });
    }
  } else {
    extraEnv.ALLOWED_TOOLS_OVERRIDE = baseTools.length ? baseTools.join(",") : "";
  }

  // Inject Saturn app-control access for all sessions. Agents get the base URL
  // and their identity (session id) so the CLI can create tasks and other
  // app objects without ambiguity.
  extraEnv.SATURN_BASE_URL = `http://127.0.0.1:${port}`;
  extraEnv.SATURN_SESSION_ID = sessionId;
  extraEnv.TASK_BASE_URL = `http://127.0.0.1:${port}/api/tasks`;
  extraEnv.TASK_SESSION_ID = sessionId;

  const earlyStderr = await createReadyAppendStream(path.join(sessionsRoot(), sessionId, "stderr.log"));
  const proc = spawn(script, [sessionId], {
    detached: true,
    stdio: ["pipe", "ignore", earlyStderr],
    env: {
      ...process.env,
      ...extraEnv,
    },
  });

  proc.once("error", (err) => {
    earlyStderr.write(`[runner] failed to spawn run-turn.sh: ${err.message}\n`);
    earlyStderr.end();
    markSessionRunnerFailed(sessionId, `failed to spawn run-turn.sh: ${err.message}`).catch(() => {});
  });

  proc.once("close", (code) => {
    earlyStderr.end();
    const timer = setTimeout(() => {
      markSessionIfRunnerExited(sessionId, code).catch(() => {});
    }, 1000);
    timer.unref?.();
  });

  try {
    proc.stdin!.end(message);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    earlyStderr.write(`[runner] failed to send prompt to run-turn.sh: ${message}\n`);
    markSessionRunnerFailed(sessionId, `failed to send prompt to run-turn.sh: ${message}`).catch(() => {});
  }
  proc.unref();
}
