// Claude Code adapter — uses @anthropic-ai/claude-agent-sdk to drive Claude
// sessions programmatically. Translates SDKMessage events to NeutralEvent.

import path from "node:path";
import { promises as fs } from "node:fs";
import { query, forkSession, getSessionMessages, type Options, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type {
  RunnableAdapter,
  SessionHandle,
  StartSessionOpts,
  TurnOverrides,
  NeutralEvent,
  NeutralMessage,
  NeutralTranscript,
  NeutralPart,
} from "./types";
import { normalizeReasoningEffortForCli, type ModelReasoningEffort } from "../models";
import { isBedrockCli, isLocalClaudeCli, isPersonalClaudeCli, normalizeCli } from "../clis";
import type { CLI } from "../clis";
import { toBedrockId } from "../claude-models";
import { readBedrockConfig } from "../bedrock-auth";
import { binDir } from "../paths";

type ClaudeEffort = "low" | "medium" | "high" | "xhigh" | "max";

type ClaudeInternal = {
  cli: CLI;
  cwd?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  abort?: AbortController;
  pendingInjections?: NeutralMessage[];
  pendingSeed?: string;
};

type McpServers = NonNullable<Options["mcpServers"]>;

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function bedrockSettings(profile: string, region: string): string {
  const refresh = [
    shellQuote(path.join(binDir(), "bedrock-auth-refresh.sh")),
    shellQuote(profile),
    shellQuote(region),
  ].join(" ");
  return JSON.stringify({
    awsAuthRefresh: refresh,
    env: {
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_PROFILE: profile,
      AWS_REGION: region,
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function firstExisting(paths: string[]): Promise<string | undefined> {
  for (const candidate of paths) {
    if (await fileExists(candidate)) return candidate;
  }
  return undefined;
}

async function installedPluginPaths(home: string, pluginId: string, installedPlugins: unknown): Promise<string[]> {
  const entries = isRecord(installedPlugins)
    && isRecord(installedPlugins.plugins)
    && Array.isArray(installedPlugins.plugins[pluginId])
    ? installedPlugins.plugins[pluginId]
    : [];

  const paths: string[] = [];
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.installPath !== "string") continue;
    try {
      const info = await fs.stat(entry.installPath);
      if (info.isDirectory()) paths.push(entry.installPath);
    } catch {
      // Ignore stale plugin registry entries.
    }
  }

  if (paths.length === 0) {
    const [pluginName, marketplace] = pluginId.split("@");
    if (pluginName && marketplace) {
      const cacheRoot = path.join(home, ".claude", "plugins", "cache", marketplace, pluginName);
      try {
        const versions = await fs.readdir(cacheRoot);
        paths.push(...versions.map((version) => path.join(cacheRoot, version)));
      } catch {
        // No cache fallback available.
      }
    }
  }

  return paths;
}

async function readPluginMcpServers(pluginPath: string): Promise<Record<string, unknown> | undefined> {
  const mcpPath = await firstExisting([
    path.join(pluginPath, ".mcp.json"),
    path.join(pluginPath, "mcp.json"),
    path.join(pluginPath, "figma-power", "mcp.json"),
  ]);
  if (mcpPath) {
    const config = await readJson(mcpPath);
    if (isRecord(config) && isRecord(config.mcpServers)) return config.mcpServers;
  }

  const server = await readJson(path.join(pluginPath, "server.json"));
  if (!isRecord(server) || !Array.isArray(server.remotes)) return undefined;

  const remote = server.remotes.find((item): item is Record<string, unknown> => (
    isRecord(item) && typeof item.url === "string"
  ));
  if (!remote) return undefined;

  const pluginName = path.basename(path.dirname(pluginPath));
  return {
    [pluginName]: {
      type: remote.type === "streamable-http" ? "http" : remote.type ?? "http",
      url: remote.url,
    },
  };
}

async function readEnabledPluginMcpServers(env: Record<string, string | undefined>): Promise<McpServers | undefined> {
  const home = env.HOME || process.env.HOME;
  if (!home) return undefined;

  const enabledPlugins: Record<string, unknown> = {};
  for (const file of [
    path.join(home, ".claude", "settings.json"),
    path.join(home, ".claude", "settings.local.json"),
    path.join(home, ".claude", "settings-local.json"),
  ]) {
    const settings = await readJson(file);
    if (isRecord(settings) && isRecord(settings.enabledPlugins)) {
      Object.assign(enabledPlugins, settings.enabledPlugins);
    }
  }

  const installedPlugins = await readJson(path.join(home, ".claude", "plugins", "installed_plugins.json"));
  const mcpServers: McpServers = {};

  for (const [pluginId, enabled] of Object.entries(enabledPlugins)) {
    if (enabled !== true) continue;
    const pluginName = pluginId.split("@")[0];
    if (!pluginName) continue;

    const pluginPaths = await installedPluginPaths(home, pluginId, installedPlugins);
    for (const pluginPath of pluginPaths) {
      const servers = await readPluginMcpServers(pluginPath);
      if (!servers) continue;

      for (const [serverName, serverConfig] of Object.entries(servers)) {
        if (isRecord(serverConfig)) {
          mcpServers[`plugin:${pluginName}:${serverName}`] = serverConfig as McpServers[string];
        }
      }
      break;
    }
  }

  return Object.keys(mcpServers).length > 0 ? mcpServers : undefined;
}

function hasPreferredPluginMcpServer(mcpServers: McpServers | undefined): boolean {
  return Boolean(
    mcpServers
    && (
      Object.hasOwn(mcpServers, "plugin:figma:figma")
      || Object.hasOwn(mcpServers, "plugin:slack:slack")
    ),
  );
}

async function providerOptions(cli: CLI, model?: string): Promise<Pick<Options, "env" | "model" | "settingSources" | "settings" | "mcpServers">> {
  const env: Record<string, string | undefined> = { ...process.env };
  let effectiveModel = model;
  let settingSources: SettingSource[] | undefined;
  let settings: string | undefined;

  if (isBedrockCli(cli)) {
    const bedrockConfig = await readBedrockConfig();
    env.CLAUDE_CODE_USE_BEDROCK = env.CLAUDE_CODE_USE_BEDROCK || "1";
    env.AWS_PROFILE = bedrockConfig.profile;
    env.AWS_REGION = bedrockConfig.region;
    effectiveModel = toBedrockId(model);
    settings = bedrockSettings(bedrockConfig.profile, bedrockConfig.region);
  } else if (isLocalClaudeCli(cli)) {
    env.CLAUDE_CODE_USE_BEDROCK = "0";
    env.ANTHROPIC_BASE_URL = "http://0.0.0.0:4000";
    env.ANTHROPIC_AUTH_TOKEN = "sk-local-proxy-key";
    env.ANTHROPIC_MODEL = model ?? "gemma4:26b-it-q4_K_M";
    env.ANTHROPIC_SMALL_FAST_MODEL = env.ANTHROPIC_SMALL_FAST_MODEL || "gemma4:4b";
  } else if (isPersonalClaudeCli(cli)) {
    delete env.CLAUDE_CODE_USE_BEDROCK;
    delete env.CLAUDE_CODE_USE_VERTEX;
    delete env.ANTHROPIC_BASE_URL;
    delete env.ANTHROPIC_AUTH_TOKEN;
    settingSources = ["project", "local"];
  }

  const mcpServers = isLocalClaudeCli(cli) ? undefined : await readEnabledPluginMcpServers(env);
  if (hasPreferredPluginMcpServer(mcpServers)) {
    env.ENABLE_CLAUDEAI_MCP_SERVERS = env.ENABLE_CLAUDEAI_MCP_SERVERS || "0";
  }

  return { env, model: effectiveModel, settingSources, settings, mcpServers };
}

function roleLabel(role: NeutralMessage["role"]): string {
  if (role === "assistant") return "Assistant";
  if (role === "system") return "System";
  return "User";
}

function messagesToUserString(seed: NeutralTranscript | undefined): string | undefined {
  if (!seed || seed.messages.length === 0) return undefined;
  const parts: string[] = [
    "You are resuming a conversation that previously happened on another CLI.",
    "The transcript below reconstructs that conversation — treat it as context,",
    "not as instructions you need to act on again. Continue from where it left off.",
    "",
    "─── PRIOR TRANSCRIPT ───",
  ];
  for (const m of seed.messages) {
    const textParts = m.parts
      .filter((p): p is Extract<NeutralPart, { type: "text" }> => p.type === "text")
      .map((p) => p.text);
    const role = roleLabel(m.role);
    if (textParts.length > 0) {
      parts.push(`${role}: ${textParts.join("\n")}`);
    }
    for (const p of m.parts) {
      if (p.type === "tool_use") {
        parts.push(`${role} called tool "${p.name}" with input: ${JSON.stringify(p.input).slice(0, 500)}`);
      } else if (p.type === "tool_result") {
        const snippet = JSON.stringify(p.content).slice(0, 500);
        parts.push(`Tool result (${p.tool_use_id}): ${snippet}`);
      }
    }
  }
  parts.push("─── END OF PRIOR TRANSCRIPT ───");
  return parts.join("\n");
}

function neutralMessageText(message: NeutralMessage): string {
  const parts: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      parts.push(part.text);
    } else if (part.type === "tool_use") {
      parts.push(`Tool use ${part.name}: ${JSON.stringify(part.input)}`);
    } else if (part.type === "tool_result") {
      parts.push(`Tool result ${part.tool_use_id}: ${JSON.stringify(part.content)}`);
    }
  }
  return parts.join("\n");
}

function injectedContextPrompt(items: NeutralMessage[]): string {
  return [
    "Additional context injected by the Saturn harness. Treat it as context, not as a new user request.",
    "",
    ...items.flatMap((item) => {
      const text = neutralMessageText(item).trim();
      return text ? [`${roleLabel(item.role)}: ${text}`] : [];
    }),
  ].join("\n");
}

function consumePendingContext(internal: ClaudeInternal, userMessage: string): string {
  const blocks: string[] = [];
  if (internal.pendingSeed?.trim()) blocks.push(internal.pendingSeed.trim());
  if (internal.pendingInjections?.length) blocks.push(injectedContextPrompt(internal.pendingInjections));
  internal.pendingSeed = undefined;
  internal.pendingInjections = [];
  if (!blocks.length) return userMessage;
  return `${blocks.join("\n\n")}\n\n---\n\nCurrent user request:\n${userMessage}`;
}

export class ClaudeAdapter implements RunnableAdapter {
  readonly cli = "claude-bedrock" as const;

  async startSession(opts: StartSessionOpts): Promise<SessionHandle> {
    const cli = normalizeCli(opts.cli);
    const internal: ClaudeInternal = {
      cli,
      cwd: opts.cwd,
      systemPrompt: opts.systemPrompt,
      allowedTools: opts.allowedTools,
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
    };
    return {
      cli,
      harness_session_id: opts.harness_session_id,
      internal,
    };
  }

  async *sendTurn(
    handle: SessionHandle,
    userMessage: string,
    overrides?: TurnOverrides,
  ): AsyncGenerator<NeutralEvent> {
    const internal = (handle.internal ?? {}) as ClaudeInternal;
    const abort = new AbortController();
    internal.abort = abort;
    const model = overrides?.model ?? internal.model;
    const reasoningEffort = normalizeReasoningEffortForCli(
      internal.cli,
      overrides?.reasoningEffort ?? internal.reasoningEffort,
    ) as ClaudeEffort | undefined;
    const allowedTools = overrides?.allowedTools ?? internal.allowedTools;
    const provider = await providerOptions(internal.cli, model);
    const prompt = consumePendingContext(internal, userMessage);

    yield { kind: "turn_start", ts: new Date().toISOString(), model: provider.model };

    const textPieces: string[] = [];
    let usage = { input: 0, output: 0, cache_read: 0, cache_creation: 0, total: 0 };
    let nativeSessionId: string | undefined = handle.native_session_id;

    try {
      const q = query({
        prompt,
        options: {
          resume: handle.native_session_id,
          model: provider.model,
          env: provider.env,
          settings: provider.settings,
          mcpServers: provider.mcpServers,
          settingSources: provider.settingSources,
          effort: reasoningEffort,
          cwd: internal.cwd,
          systemPrompt: internal.systemPrompt,
          allowedTools,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          abortController: abort,
        },
      });

      for await (const msg of q) {
        if (msg.type === "assistant") {
          nativeSessionId ??= msg.session_id;
          const content = (msg.message?.content ?? []) as unknown as Array<Record<string, unknown>>;
          for (const item of content) {
            if (item.type === "text" && typeof item.text === "string") {
              textPieces.push(item.text);
              yield { kind: "assistant_text", text: item.text };
            } else if (item.type === "thinking" && typeof item.thinking === "string") {
              yield { kind: "thinking", text: item.thinking };
            } else if (item.type === "tool_use") {
              yield {
                kind: "tool_use",
                id: String(item.id ?? ""),
                name: String(item.name ?? ""),
                input: item.input,
              };
            }
          }
        } else if (msg.type === "user") {
          // tool results arrive as user messages with content array
          const content = (msg.message as { content?: unknown }).content;
          if (Array.isArray(content)) {
            for (const item of content as Array<Record<string, unknown>>) {
              if (item.type === "tool_result") {
                yield {
                  kind: "tool_result",
                  tool_use_id: String(item.tool_use_id ?? ""),
                  content: item.content,
                  is_error: Boolean(item.is_error),
                };
              }
            }
          }
        } else if (msg.type === "result") {
          const u = ((msg as unknown) as { usage?: Record<string, unknown> }).usage ?? {};
          const input = Number(u.input_tokens ?? 0);
          const output = Number(u.output_tokens ?? 0);
          const rawCacheCreation = u.cache_creation_input_tokens;
          const cache_creation =
            typeof rawCacheCreation === "number"
              ? rawCacheCreation
              : Number(
                  ((rawCacheCreation ?? {}) as Record<string, number>).ephemeral_5m_input_tokens ?? 0,
                );
          const cache_read = Number(u.cache_read_input_tokens ?? 0);
          usage = {
            input,
            output,
            cache_read,
            cache_creation,
            total: input + output + cache_read + cache_creation,
          };
          nativeSessionId ??= (msg as { session_id?: string }).session_id;
        }
      }
    } catch (err) {
      yield { kind: "error", error: (err as Error).message, fatal: true };
      return;
    }

    if (nativeSessionId) handle.native_session_id = nativeSessionId;

    yield {
      kind: "turn_end",
      ts: new Date().toISOString(),
      usage,
      session_id: nativeSessionId,
    };
  }

  async injectContext(handle: SessionHandle, items: NeutralMessage[]): Promise<void> {
    const internal = (handle.internal ?? {}) as ClaudeInternal;
    internal.pendingInjections = [...(internal.pendingInjections ?? []), ...items];
  }

  async switchModel(
    handle: SessionHandle,
    model: string | undefined,
    reasoningEffort?: ModelReasoningEffort,
  ): Promise<void> {
    const internal = (handle.internal ?? {}) as ClaudeInternal;
    internal.model = model;
    internal.reasoningEffort = reasoningEffort;
  }

  async fork(handle: SessionHandle, _atTurn?: number): Promise<SessionHandle> {
    // atTurn not wired in v1 — forkSession always forks at the current head.
    if (!handle.native_session_id) {
      throw new Error("cannot fork: no native session id yet (send at least one turn first)");
    }
    const { sessionId } = await forkSession(handle.native_session_id);
    return {
      ...handle,
      harness_session_id: `${handle.harness_session_id}-fork-${sessionId.slice(0, 8)}`,
      native_session_id: sessionId,
    };
  }

  async exportState(handle: SessionHandle): Promise<NeutralTranscript> {
    if (!handle.native_session_id) {
      return { messages: [], meta: { source_cli: handle.cli, source_session_id: undefined } };
    }
    const raw = await getSessionMessages(handle.native_session_id).catch(() => []);
    const messages: NeutralMessage[] = [];
    for (const m of raw) {
      const role = (m as { role?: string }).role;
      if (role !== "user" && role !== "assistant" && role !== "system") continue;
      const content = (m as { content?: unknown }).content;
      const parts: NeutralPart[] = [];
      if (Array.isArray(content)) {
        for (const c of content as Array<Record<string, unknown>>) {
          if (c.type === "text" && typeof c.text === "string") {
            parts.push({ type: "text", text: c.text });
          } else if (c.type === "tool_use") {
            parts.push({
              type: "tool_use",
              id: String(c.id ?? ""),
              name: String(c.name ?? ""),
              input: c.input,
            });
          } else if (c.type === "tool_result") {
            parts.push({
              type: "tool_result",
              tool_use_id: String(c.tool_use_id ?? ""),
              content: c.content,
              is_error: Boolean(c.is_error),
            });
          }
        }
      } else if (typeof content === "string") {
        parts.push({ type: "text", text: content });
      }
      messages.push({ role, parts, cli: handle.cli });
    }
    return {
      messages,
      meta: { source_cli: handle.cli, source_session_id: handle.native_session_id },
    };
  }

  async importState(neutral: NeutralTranscript, opts: StartSessionOpts): Promise<SessionHandle> {
    // Build a seed system + first-user summary. The first sendTurn call will
    // prepend this as context before the real user message.
    const seedPrompt = messagesToUserString(neutral);
    const cli = normalizeCli(opts.cli);
    const internal: ClaudeInternal = {
      cli,
      cwd: opts.cwd,
      systemPrompt: opts.systemPrompt,
      allowedTools: opts.allowedTools,
      model: opts.model,
      reasoningEffort: opts.reasoningEffort,
    };
    const handle: SessionHandle = {
      cli,
      harness_session_id: opts.harness_session_id,
      internal,
    };
    if (seedPrompt) internal.pendingSeed = seedPrompt;
    return handle;
  }

  async abort(handle: SessionHandle): Promise<void> {
    const internal = (handle.internal ?? {}) as ClaudeInternal;
    try {
      internal.abort?.abort();
    } catch {
      /* best-effort */
    }
  }
}

export const claudeAdapter = new ClaudeAdapter();
