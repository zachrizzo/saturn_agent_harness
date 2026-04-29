// Server-only helper to spawn run-turn.sh for a session.
import path from "node:path";
import { promises as fs } from "node:fs";
import { spawn } from "child_process";
import { binDir, sessionsRoot } from "./paths";
import { isOrchestrator } from "./session-utils";
import { mintToken } from "./mcp/auth";
import { toBedrockId } from "./claude-models";
import type { CLI, Agent } from "./runs";
import { normalizeReasoningEffortForCli, type ModelReasoningEffort } from "./models";
import { isBedrockCli, isLocalClaudeCli, isPersonalClaudeCli, normalizeCli } from "./clis";

// MCP tools added to allowedTools for orchestrator sessions
const ORCHESTRATOR_MCP_TOOLS = [
  "mcp__orchestrator__list_slices",
  "mcp__orchestrator__dispatch_slice",
  "mcp__orchestrator__dispatch_custom_slice",
  "mcp__orchestrator__get_budget",
  "mcp__orchestrator__stop",
];


export async function spawnTurn(
  sessionId: string,
  cli: CLI,
  model: string | undefined,
  message: string,
  agentSnapshot?: Agent,
  mcpTools?: boolean,
  reasoningEffort?: ModelReasoningEffort,
): Promise<void> {
  const script = path.join(binDir(), "run-turn.sh");
  const baseTools = agentSnapshot?.allowedTools ?? [];
  const normalizedCli = normalizeCli(cli);

  const isLocal = isLocalClaudeCli(normalizedCli);
  const isBedrock = isBedrockCli(normalizedCli);
  const isPersonal = isPersonalClaudeCli(normalizedCli);
  const localModel = model ?? "gemma4:26b-it-q4_K_M";
  const localSmallModel = "gemma4:4b";
  const effectiveReasoningEffort = normalizeReasoningEffortForCli(
    normalizedCli,
    reasoningEffort ?? agentSnapshot?.reasoningEfforts?.[normalizedCli] ?? agentSnapshot?.reasoningEffort,
  );

  // For Bedrock-backed Claude, expand short aliases like `claude-sonnet-4-6`
  // into the full inference profile ID the Bedrock API requires.
  const effectiveModel = isBedrock ? toBedrockId(model) : model;

  const localProxyEnv = {
    CLAUDE_CODE_USE_BEDROCK: "0",
    ANTHROPIC_BASE_URL: "http://0.0.0.0:4000",
    ANTHROPIC_AUTH_TOKEN: "sk-local-proxy-key",
    ANTHROPIC_MODEL: localModel,
    ANTHROPIC_SMALL_FAST_MODEL: localSmallModel,
  };

  const extraEnv: Record<string, string> = {
    CLI: normalizedCli,  // preserve UI-facing backend; run-turn.sh maps Claude-family backends to the claude binary
    MODEL: effectiveModel ?? "",
    REASONING_EFFORT: effectiveReasoningEffort ?? "",
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
      AWS_PROFILE: "sondermind-development-new",
      AWS_REGION: "us-east-1",
    } : isPersonal ? {
      CLAUDE_CODE_USE_BEDROCK: "",
      CLAUDE_CODE_USE_VERTEX: "",
      ANTHROPIC_BASE_URL: "",
      ANTHROPIC_AUTH_TOKEN: "",
      CLAUDE_SETTING_SOURCES: "project,local",
    } : {}),
  };


  const port = process.env.PORT ?? "3737";

  // For orchestrator sessions (Claude-only in v1): generate an MCP config and
  // inject it so run-turn.sh passes --mcp-config to the Claude CLI.
  if (isOrchestrator(agentSnapshot) && isBedrock) {
    const wallclock = agentSnapshot?.budget?.max_wallclock_seconds;
    const token = mintToken(sessionId, wallclock);
    const mcpConfig = {
      mcpServers: {
        orchestrator: {
          type: "http",
          url: `http://127.0.0.1:${port}/api/mcp/orchestrator/${sessionId}?token=${token}`,
        },
      },
    };
    const mcpConfigPath = path.join(sessionsRoot(), sessionId, "mcp-config.json");
    await fs.mkdir(path.dirname(mcpConfigPath), { recursive: true });
    await fs.writeFile(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), "utf8");

    extraEnv.MCP_CONFIG_PATH = mcpConfigPath;
    // Merge MCP tool names so the orchestrator is allowed to call them
    const allTools = [...new Set([...baseTools, ...ORCHESTRATOR_MCP_TOOLS])];
    extraEnv.ALLOWED_TOOLS_OVERRIDE = allTools.join(",");
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

  const proc = spawn(script, [sessionId], {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
    env: {
      ...process.env,
      ...extraEnv,
    },
  });
  proc.stdin!.end(message);
  proc.unref();
}
