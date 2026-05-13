import { promises as fs } from "node:fs";
import path from "node:path";
import { getSubagentMessages } from "@anthropic-ai/claude-agent-sdk";
import { parseStreamJsonl, type StreamEvent } from "@/lib/events";
import { getSessionMeta, sessionDir, type SessionMeta } from "@/lib/runs";
import { withCodexAppServer } from "@/lib/native/codex-app-server";

export type NativeAgentProvider = "claude" | "codex" | "unknown";
export type NativeAgentStatus = "running" | "done" | "failed" | "stopped";

export type NativeAgentRun = {
  id: string;
  provider: NativeAgentProvider;
  status: NativeAgentStatus;
  title: string;
  prompt?: string;
  description?: string;
  saturnToolId: string;
  linkedToolUseId?: string;
  nativeAgentId: string;
  nativeSessionId?: string;
  nativeThreadId?: string;
  parentNativeThreadId?: string;
  resultText?: string;
  stopAvailable: boolean;
  transcriptAvailable: boolean;
  rawEventTypes: string[];
};

export type NativeAgentTranscriptMessage = {
  role: "user" | "assistant" | "system" | "tool" | "unknown";
  type?: string;
  text?: string;
  raw: unknown;
};

export type NativeAgentTranscript = {
  agent: NativeAgentRun;
  source: "claude-subagent-jsonl" | "codex-thread-read" | "stream-summary";
  messages: NativeAgentTranscriptMessage[];
  unsupportedReason?: string;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function rawType(event: StreamEvent): string {
  return stringValue(asRecord(event.raw).type) ?? event.kind;
}

function rawSubtype(event: StreamEvent): string | undefined {
  return stringValue(asRecord(event.raw).subtype);
}

function itemRecord(event: StreamEvent): Record<string, unknown> {
  return asRecord(asRecord(event.raw).item);
}

function providerForToolUse(event: Extract<StreamEvent, { kind: "tool_use" }>): NativeAgentProvider {
  const input = asRecord(event.input);
  const subagentType = (stringValue(input.subagent_type) ?? "").toLowerCase();
  if (subagentType.includes("claude")) return "claude";
  if (subagentType.includes("codex")) return "codex";
  if (rawType(event) === "system" && rawSubtype(event) === "task_started") return "claude";
  if (stringValue(input.receiver_thread_id)) return "codex";
  if (itemRecord(event).type === "collab_tool_call") return "codex";
  return "unknown";
}

function titleFromInput(input: unknown, fallback: string): string {
  const record = asRecord(input);
  return stringValue(record.description)
    ?? stringValue(record.subagent_type)
    ?? stringValue(record.agent_role)
    ?? fallback;
}

function textFromResult(result: unknown): string | undefined {
  if (typeof result === "string" && result.trim()) return result;
  if (Array.isArray(result)) {
    const parts = result.flatMap((item) => {
      if (typeof item === "string") return [item];
      const record = asRecord(item);
      return stringValue(record.text) ? [String(record.text)] : [];
    });
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  const record = asRecord(result);
  return stringValue(record.summary)
    ?? stringValue(record.message)
    ?? stringValue(record.output)
    ?? stringValue(record.text);
}

function statusFromResult(result: Extract<StreamEvent, { kind: "tool_result" }> | undefined): NativeAgentStatus {
  if (!result) return "running";
  const content = asRecord(result.content);
  const status = (stringValue(content.status) ?? "").toLowerCase();
  if (status === "running" || status === "in_progress" || status === "pending") return "running";
  if (status === "canceled" || status === "cancelled" || status === "stopped") return "stopped";
  if (result.isError || status === "failed" || status === "error") return "failed";
  return "done";
}

function latestCliSessionId(meta: SessionMeta, provider: NativeAgentProvider): string | undefined {
  const cliPrefix = provider === "claude" ? "claude-" : provider;
  return [...meta.turns].reverse().find((turn) => turn.cli === provider || turn.cli.startsWith(cliPrefix))?.cli_session_id;
}

async function readSessionEvents(sessionId: string): Promise<StreamEvent[]> {
  const raw = await fs.readFile(path.join(sessionDir(sessionId), "stream.jsonl"), "utf8").catch(() => "");
  return parseStreamJsonl(raw);
}

export async function listNativeAgents(sessionId: string): Promise<NativeAgentRun[]> {
  const [meta, events] = await Promise.all([
    getSessionMeta(sessionId),
    readSessionEvents(sessionId),
  ]);
  if (!meta) throw new Error(`session not found: ${sessionId}`);

  const toolUses = new Map<string, Extract<StreamEvent, { kind: "tool_use" }>>();
  const results = new Map<string, Extract<StreamEvent, { kind: "tool_result" }>>();
  const rawTypesById = new Map<string, Set<string>>();
  const claudeToolUseAliases = new Map<string, string>();

  for (const event of events) {
    if (event.kind === "tool_use" && event.name === "Agent") {
      const input = asRecord(event.input);
      const linkedToolUseId = stringValue(input.tool_use_id);
      if (providerForToolUse(event) === "claude" && linkedToolUseId) {
        claudeToolUseAliases.set(linkedToolUseId, event.id);
      }
      toolUses.set(event.id, event);
      rawTypesById.set(event.id, new Set([rawType(event)]));
    } else if (event.kind === "tool_result" && !(event as { parentToolUseId?: string }).parentToolUseId) {
      results.set(event.toolUseId, event);
      const types = rawTypesById.get(event.toolUseId) ?? new Set<string>();
      types.add(rawType(event));
      rawTypesById.set(event.toolUseId, types);
    }
  }

  return Array.from(toolUses.values()).filter((event) => !claudeToolUseAliases.has(event.id)).map((event) => {
    const input = asRecord(event.input);
    const raw = asRecord(event.raw);
    const item = itemRecord(event);
    const provider = providerForToolUse(event);
    const result = results.get(event.id);
    const status = statusFromResult(result);
    const linkedToolUseId = stringValue(input.tool_use_id);
    const nativeAgentId = stringValue(input.receiver_thread_id) ?? event.id;
    const nativeThreadId = provider === "codex" ? nativeAgentId : undefined;
    const nativeSessionId = provider === "claude"
      ? stringValue(raw.session_id) ?? latestCliSessionId(meta, provider)
      : latestCliSessionId(meta, provider);
    const parentNativeThreadId = stringValue(item.sender_thread_id)
      ?? stringValue(item.senderThreadId)
      ?? latestCliSessionId(meta, provider);

    return {
      id: event.id,
      provider,
      status,
      title: titleFromInput(event.input, provider === "codex" ? "Codex sub-agent" : "Claude sub-agent"),
      prompt: stringValue(input.prompt) ?? stringValue(item.prompt),
      description: stringValue(input.description),
      saturnToolId: event.id,
      linkedToolUseId,
      nativeAgentId,
      nativeSessionId,
      nativeThreadId,
      parentNativeThreadId,
      resultText: textFromResult(result?.content),
      stopAvailable: status === "running" && provider !== "unknown",
      transcriptAvailable: provider === "claude" ? Boolean(nativeSessionId) : provider === "codex",
      rawEventTypes: Array.from(rawTypesById.get(event.id) ?? new Set([rawType(event)])),
    };
  });
}

function roleFromRaw(value: unknown): NativeAgentTranscriptMessage["role"] {
  const role = stringValue(asRecord(value).role) ?? stringValue(asRecord(value).type);
  if (role === "user" || role === "assistant" || role === "system" || role === "tool") return role;
  return "unknown";
}

function textFromContent(content: unknown): string | undefined {
  if (typeof content === "string" && content.trim()) return content;
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((item) => {
    const record = asRecord(item);
    if (typeof item === "string") return [item];
    return stringValue(record.text)
      ?? stringValue(record.thinking)
      ?? stringValue(record.content)
      ?? [];
  });
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function normalizeClaudeMessage(raw: unknown): NativeAgentTranscriptMessage {
  const record = asRecord(raw);
  const message = asRecord(record.message);
  return {
    role: roleFromRaw(record),
    type: stringValue(record.type),
    text: textFromContent(message.content) ?? textFromContent(record.message),
    raw,
  };
}

function normalizeCodexThread(thread: unknown): NativeAgentTranscriptMessage[] {
  const turns = Array.isArray(asRecord(thread).turns) ? asRecord(thread).turns as unknown[] : [];
  const messages: NativeAgentTranscriptMessage[] = [];
  for (const turn of turns) {
    const items = Array.isArray(asRecord(turn).items) ? asRecord(turn).items as unknown[] : [];
    for (const item of items) {
      const record = asRecord(item);
      const type = stringValue(record.type);
      if (type === "userMessage") {
        messages.push({ role: "user", type, text: textFromContent(record.content), raw: item });
      } else if (type === "agentMessage" || type === "plan") {
        messages.push({ role: "assistant", type, text: stringValue(record.text), raw: item });
      } else if (type === "reasoning") {
        messages.push({ role: "assistant", type, text: textFromContent(record.summary) ?? textFromContent(record.content), raw: item });
      } else if (type === "commandExecution" || type === "mcpToolCall" || type === "dynamicToolCall") {
        messages.push({
          role: "tool",
          type,
          text: stringValue(record.aggregatedOutput) ?? textFromResult(record.result) ?? textFromResult(record.error),
          raw: item,
        });
      }
    }
  }
  return messages;
}

export async function readNativeAgentTranscript(
  sessionId: string,
  agentId: string,
): Promise<NativeAgentTranscript> {
  const [meta, agents] = await Promise.all([getSessionMeta(sessionId), listNativeAgents(sessionId)]);
  if (!meta) throw new Error(`session not found: ${sessionId}`);
  const agent = agents.find((item) => item.id === agentId || item.nativeAgentId === agentId);
  if (!agent) throw new Error(`native agent not found: ${agentId}`);

  if (agent.provider === "claude" && agent.nativeSessionId) {
    const messages = await getSubagentMessages(agent.nativeSessionId, agent.nativeAgentId, {
      dir: meta.agent_snapshot?.cwd,
      limit: 200,
    }).catch(() => []);
    return {
      agent,
      source: "claude-subagent-jsonl",
      messages: messages.map(normalizeClaudeMessage),
      unsupportedReason: messages.length === 0 ? "Claude did not expose a transcript for this sub-agent." : undefined,
    };
  }

  if (agent.provider === "codex" && agent.nativeThreadId) {
    try {
      const response = await withCodexAppServer<Record<string, unknown>>(async (client) => (
        client.request("thread/read", { threadId: agent.nativeThreadId, includeTurns: true }, 20_000)
      ));
      return {
        agent,
        source: "codex-thread-read",
        messages: normalizeCodexThread(response.thread),
      };
    } catch (err) {
      return {
        agent,
        source: "stream-summary",
        messages: agent.resultText
          ? [{ role: "assistant", type: "summary", text: agent.resultText, raw: { resultText: agent.resultText } }]
          : [],
        unsupportedReason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return {
    agent,
    source: "stream-summary",
    messages: agent.resultText
      ? [{ role: "assistant", type: "summary", text: agent.resultText, raw: { resultText: agent.resultText } }]
      : [],
    unsupportedReason: "This native agent does not expose an external transcript reader.",
  };
}
