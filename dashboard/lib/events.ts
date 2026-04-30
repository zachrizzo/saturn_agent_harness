// Pure event-parsing utilities — safe to import in client components.
// Keep this file free of Node.js built-ins (fs, path, child_process, etc.)

export type StreamEvent =
  | { kind: "system"; raw: unknown }
  | { kind: "user"; raw: unknown }
  | { kind: "assistant_text"; text: string; raw: unknown }
  | { kind: "plan_text"; text: string; raw: unknown }
  | { kind: "todo_list"; items: { text: string; completed: boolean }[]; raw: unknown }
  | { kind: "thinking"; text: string; raw: unknown }
  | { kind: "tool_use"; id: string; name: string; input: unknown; parentToolUseId?: string; raw: unknown }
  | { kind: "tool_result"; toolUseId: string; content: unknown; isError: boolean; parentToolUseId?: string; raw: unknown }
  | { kind: "result"; success: boolean; totalTokens: number; numTurns: number; raw: unknown }
  | { kind: "other"; type: string; raw: unknown };

export type TokenBreakdown = {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  total: number;
  cacheEfficiency: number;
};

export type ToolCallSummary = {
  toolName: string;
  count: number;
  failures: number;
};

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord {
  return (value && typeof value === "object" ? value : {}) as AnyRecord;
}

function num(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function normalizeItemType(type: string): string {
  const map: Record<string, string> = {
    agentMessage: "agent_message",
    commandExecution: "command_execution",
    fileChange: "file_change",
    mcpToolCall: "mcp_tool_call",
    collabAgentToolCall: "collab_tool_call",
    todoList: "todo_list",
  };
  return map[type] ?? type;
}

function subAgentDescription(prompt: string, fallback = "Codex sub-agent"): string {
  const compact = prompt.replace(/\s+/g, " ").trim();
  const rowMatch = compact.match(/\brows?\s+(\d+)\s*[-–]\s*(\d+)/i);
  if (rowMatch) return `Rows ${rowMatch[1]}-${rowMatch[2]} spot check`;

  const sentenceMatch = compact.match(/^.+?[.!?](?:\s|$)/);
  const firstSentence = sentenceMatch?.[0]?.trim() ?? compact;
  if (!firstSentence) return fallback;
  return firstSentence.length > 72 ? `${firstSentence.slice(0, 69)}...` : firstSentence;
}

function agentStatusIsError(status: unknown): boolean {
  return status === "failed" || status === "error" || status === "cancelled" || status === "canceled";
}

function tokenBreakdownFromModelUsage(raw: Record<string, unknown>): TokenBreakdown | null {
  const modelUsage = asRecord(raw.modelUsage);
  const entries = Object.values(modelUsage).map(asRecord);
  if (entries.length === 0) return null;

  let input = 0;
  let output = 0;
  let cacheCreation = 0;
  let cacheRead = 0;

  for (const usage of entries) {
    input += num(usage.inputTokens);
    output += num(usage.outputTokens);
    cacheCreation += num(usage.cacheCreationInputTokens);
    cacheRead += num(usage.cacheReadInputTokens);
  }

  const total = input + output + cacheCreation + cacheRead;
  if (total === 0) return null;

  return {
    input,
    output,
    cacheCreation,
    cacheRead,
    total,
    cacheEfficiency: (cacheRead / total) * 100,
  };
}

export function parseStreamJsonl(raw: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    for (const ev of toEvents(obj)) events.push(ev);
  }
  return events;
}

export function toEvents(obj: Record<string, unknown>): StreamEvent[] {
  const type = typeof obj.type === "string" ? obj.type : "other";
  const part = asRecord(obj.part);
  const parentToolUseId = typeof obj.parent_tool_use_id === "string" ? obj.parent_tool_use_id : undefined;

  switch (type) {
    case "text": {
      const text = String(part.text ?? "");
      return text.trim() ? [{ kind: "assistant_text", text, raw: obj }] : [];
    }
    case "step_start":
    case "turn.started":
      return [];
    case "step_finish": {
      if (part.reason !== "stop") return [];
      const total = tokenBreakdownFromRaw(obj).total;
      return [{ kind: "result", success: true, totalTokens: total, numTurns: 1, raw: obj }];
    }
    case "tool_use": {
      const state = asRecord(part.state);
      const id = String(part.callID ?? part.id ?? "");
      const name = String(part.tool ?? part.name ?? "");
      const input = state.input ?? part.input;
      const out: StreamEvent[] = [{ kind: "tool_use", id, name, input, parentToolUseId, raw: obj }];
      if (state.output !== undefined) {
        out.push({ kind: "tool_result", toolUseId: id, content: state.output, isError: Boolean(state.error), parentToolUseId, raw: obj });
      }
      return out;
    }
    case "tool_result": {
      return [{
        kind: "tool_result",
        toolUseId: String(part.toolUseId ?? part.callID ?? ""),
        content: part.output ?? part.content,
        isError: Boolean(part.error),
        parentToolUseId,
        raw: obj,
      }];
    }
    case "system":
    case "thread.started":
      return [{ kind: "system", raw: obj }];
    case "turn.failed":
      return [{ kind: "other", type: "error", raw: obj }];
    case "turn.completed": {
      const totalTokens = tokenBreakdownFromRaw(obj).total;
      return [{ kind: "result", success: true, totalTokens, numTurns: 1, raw: obj }];
    }
    case "plan.delta":
      return [];
    case "user": {
      const message = asRecord(obj.message);
      const content = Array.isArray(message.content) ? message.content : [];
      const out: StreamEvent[] = [];
      for (const item of content) {
        const it = asRecord(item);
        if (it.type === "tool_result") {
          out.push({
            kind: "tool_result",
            toolUseId: String(it.tool_use_id ?? ""),
            content: it.content,
            isError: Boolean(it.is_error),
            parentToolUseId,
            raw: obj,
          });
        }
      }
      return out.length > 0 ? out : [{ kind: "user", raw: obj }];
    }
    case "assistant": {
      const message = asRecord(obj.message);
      const content = Array.isArray(message.content) ? message.content : [];
      const out: StreamEvent[] = [];
      for (const item of content) {
        const it = asRecord(item);
        if (it.type === "tool_use") {
          out.push({ kind: "tool_use", id: String(it.id ?? ""), name: String(it.name ?? ""), input: it.input, parentToolUseId, raw: obj });
        } else if (it.type === "thinking") {
          out.push({ kind: "thinking", text: String(it.thinking ?? ""), raw: obj });
        } else if (it.type === "text") {
          out.push({ kind: "assistant_text", text: String(it.text ?? ""), raw: obj });
        }
      }
      return out.length > 0 ? out : [{ kind: "other", type, raw: obj }];
    }
    case "result": {
      const totalTokens = tokenBreakdownFromRaw(obj).total;
      const success = obj.is_error === true ? false : obj.subtype === "success" || obj.is_error !== true;
      return [{ kind: "result", success, totalTokens, numTurns: Number(obj.num_turns ?? 0), raw: obj }];
    }
    case "item.completed":
    case "item.updated":
    case "item.started":
      return parseItemEvent(type, obj);
    default:
      return [{ kind: "other", type, raw: obj }];
  }
}

function parseItemEvent(type: string, obj: Record<string, unknown>): StreamEvent[] {
  const item = obj.item as AnyRecord | undefined;
  if (!item) return [];
  if (item.saturn_final_only === true) return [];
  const itemType = normalizeItemType(String(item.type ?? ""));
  const id = String(item.id ?? "");

  if (itemType === "collab_tool_call") {
    return parseCollabToolEvent(type, obj, item, id);
  }

  if (type === "item.completed") {
    if (itemType === "todo_list") {
      const rawItems = Array.isArray(item.items) ? item.items : [];
      const items = rawItems
        .map((rawItem) => {
          const todo = asRecord(rawItem);
          return {
            text: String(todo.text ?? "").trim(),
            completed: Boolean(todo.completed) || todo.status === "completed",
          };
        })
        .filter((todo) => todo.text.length > 0);
      return items.length > 0 ? [{ kind: "todo_list", items, raw: obj }] : [];
    }
    if (itemType === "plan") {
      const text = String(item.text ?? "");
      return text.trim() ? [{ kind: "plan_text", text, raw: obj }] : [];
    }
    if (itemType === "agent_message") {
      const text = String(item.text ?? "");
      return text.trim() ? [{ kind: "assistant_text", text, raw: obj }] : [];
    }
    if (itemType === "reasoning") {
      const text = String(item.text ?? "");
      return text.trim() ? [{ kind: "thinking", text, raw: obj }] : [];
    }
    if (itemType === "command_execution") {
      return [{
        kind: "tool_result",
        toolUseId: id,
        content: item.aggregated_output ?? item.aggregatedOutput,
        isError: num(item.exit_code ?? item.exitCode) !== 0,
        raw: obj,
      }];
    }
    if (itemType === "file_change") {
      return [
        { kind: "tool_use", id, name: "Edit", input: { changes: item.changes }, raw: obj },
        { kind: "tool_result", toolUseId: id, content: { status: item.status }, isError: item.status === "failed", raw: obj },
      ];
    }
    if (itemType === "mcp_tool_call") {
      return [
        { kind: "tool_use", id, name: `${item.server}.${item.tool}`, input: item.arguments, raw: obj },
        { kind: "tool_result", toolUseId: id, content: item.result ?? item.error, isError: item.status === "failed", raw: obj },
      ];
    }
    if (itemType === "error") {
      return [{ kind: "other", type: "error", raw: obj }];
    }
  }

  if (type === "item.started" && itemType === "command_execution") {
    return [{ kind: "tool_use", id, name: "Bash", input: { command: item.command }, raw: obj }];
  }

  if (type === "item.updated" && itemType === "todo_list") {
    const rawItems = Array.isArray(item.items) ? item.items : [];
    const items = rawItems
      .map((rawItem) => {
        const todo = asRecord(rawItem);
        return {
          text: String(todo.text ?? "").trim(),
          completed: Boolean(todo.completed) || todo.status === "completed",
        };
      })
      .filter((todo) => todo.text.length > 0);
    return items.length > 0 ? [{ kind: "todo_list", items, raw: obj }] : [];
  }

  return [];
}

function parseCollabToolEvent(
  type: string,
  obj: Record<string, unknown>,
  item: AnyRecord,
  id: string,
): StreamEvent[] {
  const rawTool = String(item.tool ?? "");
  const tool = rawTool === "spawnAgent" ? "spawn_agent" : rawTool;
  const prompt = String(item.prompt ?? "");
  const receiverThreadIds = stringArray(item.receiver_thread_ids ?? item.receiverThreadIds);
  const states = asRecord(item.agents_states ?? item.agentsStates);
  const events: StreamEvent[] = [];

  if (tool === "spawn_agent") {
    if (type === "item.started" && receiverThreadIds.length === 0) {
      return [];
    }

    const agentIds = receiverThreadIds.length > 0 ? receiverThreadIds : [id];
    for (const agentId of agentIds) {
      const state = asRecord(states[agentId]);
      const message = stringValue(state.message);
      const status = state.status ?? item.status;
      events.push({
        kind: "tool_use",
        id: agentId,
        name: "Agent",
        input: {
          description: subAgentDescription(prompt),
          prompt,
          subagent_type: "Codex",
          collab_tool: tool,
          receiver_thread_id: agentId,
        },
        raw: obj,
      });
      if (message) {
        events.push({
          kind: "tool_result",
          toolUseId: agentId,
          content: message,
          isError: agentStatusIsError(status),
          raw: obj,
        });
      }
    }
    return events;
  }

  if (tool === "wait" || tool === "wait_agent" || tool === "close_agent") {
    for (const [agentId, rawState] of Object.entries(states)) {
      const state = asRecord(rawState);
      const message = stringValue(state.message);
      if (!message) continue;
      events.push({
        kind: "tool_result",
        toolUseId: agentId,
        content: message,
        isError: agentStatusIsError(state.status),
        raw: obj,
      });
    }
  }

  return events;
}

/** Extract a TokenBreakdown from a single raw result/step_finish/turn.completed event object.
 *  This is the canonical per-event extractor — all paths (UI, bash, adapters) share this logic. */
export function tokenBreakdownFromRaw(raw: Record<string, unknown>): TokenBreakdown {
  const empty: TokenBreakdown = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0, cacheEfficiency: 0 };

  const modelUsageBreakdown = tokenBreakdownFromModelUsage(raw);
  if (modelUsageBreakdown) return modelUsageBreakdown;

  // OpenCode: step_finish — tokens live at part.tokens
  const partTokensRaw = asRecord(asRecord(raw.part).tokens as unknown);
  if (partTokensRaw && Object.keys(partTokensRaw).length > 0) {
    const cache = asRecord(partTokensRaw.cache);
    const input = num(partTokensRaw.input);
    const output = num(partTokensRaw.output);
    const cacheCreation = num(cache.write);
    const cacheRead = num(cache.read);
    const total = input + output + cacheCreation + cacheRead + num(partTokensRaw.reasoning);
    return { input, output, cacheCreation, cacheRead, total, cacheEfficiency: total > 0 ? (cacheRead / total) * 100 : 0 };
  }

  const usage = asRecord(raw.usage);
  if (Object.keys(usage).length === 0) return empty;

  const input = num(usage.input_tokens);
  const output = num(usage.output_tokens);

  // Claude: cache_creation_input_tokens may be a number OR an object
  // (ephemeral cache uses { ephemeral_5m_input_tokens: N, ephemeral_1h_input_tokens: N, ... })
  const rawCacheCreation = usage.cache_creation_input_tokens;
  const cacheCreation =
    typeof rawCacheCreation === "number"
      ? rawCacheCreation
      : typeof rawCacheCreation === "object" && rawCacheCreation !== null
        ? Object.values(rawCacheCreation as Record<string, unknown>).reduce<number>(
            (s, v) => s + (typeof v === "number" ? v : 0), 0)
        : 0;

  // Codex reports cached_input_tokens as the cached portion of input_tokens.
  // Claude reports cache_read_input_tokens as a separate usage bucket.
  const codexCacheRead = num(usage.cached_input_tokens);
  const claudeCacheRead = num(usage.cache_read_input_tokens);
  const cacheRead = claudeCacheRead || codexCacheRead;

  // Include reasoning tokens in total (billed on some models/providers)
  const reasoning = num(usage.reasoning_output_tokens);

  const billableInput = codexCacheRead > 0
    ? Math.max(0, input - codexCacheRead)
    : input + claudeCacheRead;
  const total = billableInput + output + cacheCreation + reasoning;
  const cacheEfficiencyBase = total + (codexCacheRead > 0 ? cacheRead : 0);
  return {
    input,
    output,
    cacheCreation,
    cacheRead,
    total,
    cacheEfficiency: cacheEfficiencyBase > 0 ? (cacheRead / cacheEfficiencyBase) * 100 : 0,
  };
}

/** Aggregate token usage across ALL result events in a stream.
 *  Claude's result event is cumulative (last one = session total).
 *  Codex/OpenCode emit one per turn, so we take the last for each. */
export function getTokenBreakdown(events: StreamEvent[]): TokenBreakdown {
  const resultEvents = events.filter((e) => e.kind === "result");
  if (resultEvents.length === 0) {
    return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0, cacheEfficiency: 0 };
  }
  // The last result event carries the cumulative total for Claude (stream-json format).
  // For OpenCode/Codex (one result per turn), the last turn is what we want as the
  // latest snapshot. Taking the last in all cases is safe.
  const last = resultEvents[resultEvents.length - 1];
  return tokenBreakdownFromRaw(asRecord(last.raw));
}

export function getToolCallSummary(events: StreamEvent[]): ToolCallSummary[] {
  const map = new Map<string, { count: number; failures: number }>();
  const toolUseById = new Map<string, string>();

  for (const ev of events) {
    if (ev.kind === "tool_use") {
      toolUseById.set(ev.id, ev.name);
      const c = map.get(ev.name) ?? { count: 0, failures: 0 };
      c.count++;
      map.set(ev.name, c);
    } else if (ev.kind === "tool_result" && ev.isError) {
      const name = toolUseById.get(ev.toolUseId);
      if (name) {
        const c = map.get(name) ?? { count: 0, failures: 0 };
        c.failures++;
        map.set(name, c);
      }
    }
  }

  return Array.from(map, ([toolName, s]) => ({ toolName, count: s.count, failures: s.failures }))
    .sort((a, b) => b.count - a.count);
}
