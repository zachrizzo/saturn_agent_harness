import { describe, it, expect } from "vitest";
import {
  parseStreamJsonl,
  toEvents,
  tokenBreakdownFromRaw,
  getTokenBreakdown,
  getToolCallSummary,
} from "../../lib/events";

// ── parseStreamJsonl ────────────────────────────────────────────────────────

describe("parseStreamJsonl", () => {
  it("parses multiple newline-separated JSON objects", () => {
    const raw = [
      JSON.stringify({ type: "text", part: { text: "hello" } }),
      JSON.stringify({ type: "text", part: { text: " world" } }),
    ].join("\n");
    const events = parseStreamJsonl(raw);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ kind: "assistant_text", text: "hello" });
    expect(events[1]).toMatchObject({ kind: "assistant_text", text: " world" });
  });

  it("skips blank lines and invalid JSON", () => {
    const raw = "\n{bad json}\n" + JSON.stringify({ type: "text", part: { text: "ok" } }) + "\n";
    const events = parseStreamJsonl(raw);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "assistant_text", text: "ok" });
  });

  it("returns empty array for empty input", () => {
    expect(parseStreamJsonl("")).toHaveLength(0);
    expect(parseStreamJsonl("   \n  ")).toHaveLength(0);
  });
});

// ── toEvents ────────────────────────────────────────────────────────────────

describe("toEvents — text", () => {
  it("emits assistant_text for non-empty text parts", () => {
    const [ev] = toEvents({ type: "text", part: { text: "Hello!" } });
    expect(ev).toMatchObject({ kind: "assistant_text", text: "Hello!" });
  });

  it("filters out whitespace-only text", () => {
    expect(toEvents({ type: "text", part: { text: "   " } })).toHaveLength(0);
  });
});

describe("toEvents — tool_use", () => {
  it("emits tool_use event with id and name", () => {
    const obj = {
      type: "tool_use",
      part: { callID: "tu-1", tool: "Bash", state: { input: { command: "ls" } } },
    };
    const events = toEvents(obj);
    expect(events[0]).toMatchObject({ kind: "tool_use", id: "tu-1", name: "Bash" });
  });

  it("also emits tool_result when state.output is present", () => {
    const obj = {
      type: "tool_use",
      part: {
        callID: "tu-2",
        tool: "Read",
        state: { input: {}, output: "file contents", error: false },
      },
    };
    const events = toEvents(obj);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ kind: "tool_result", toolUseId: "tu-2", isError: false });
  });
});

describe("toEvents — tool_result", () => {
  it("emits tool_result with isError=false", () => {
    const obj = {
      type: "tool_result",
      part: { toolUseId: "tu-3", output: "done", error: false },
    };
    const [ev] = toEvents(obj);
    expect(ev).toMatchObject({ kind: "tool_result", toolUseId: "tu-3", isError: false });
  });

  it("emits tool_result with isError=true when error is set", () => {
    const obj = {
      type: "tool_result",
      part: { toolUseId: "tu-4", output: "oops", error: true },
    };
    const [ev] = toEvents(obj);
    expect(ev).toMatchObject({ kind: "tool_result", isError: true });
  });
});

describe("toEvents — result", () => {
  it("emits result with success=true for subtype=success", () => {
    const obj = {
      type: "result",
      subtype: "success",
      num_turns: 3,
      usage: { input_tokens: 100, output_tokens: 50 },
    };
    const [ev] = toEvents(obj);
    expect(ev).toMatchObject({ kind: "result", success: true, numTurns: 3 });
  });

  it("emits result with success=false when is_error=true", () => {
    const obj = { type: "result", is_error: true, num_turns: 1, usage: {} };
    const [ev] = toEvents(obj);
    expect(ev).toMatchObject({ kind: "result", success: false });
  });
});

describe("toEvents — assistant", () => {
  it("extracts tool_use, thinking, and text from assistant message content", () => {
    const obj = {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "tu-5", name: "Edit", input: {} },
          { type: "thinking", thinking: "I should edit the file" },
          { type: "text", text: "Done." },
        ],
      },
    };
    const events = toEvents(obj);
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ kind: "tool_use", id: "tu-5", name: "Edit" });
    expect(events[1]).toMatchObject({ kind: "thinking", text: "I should edit the file" });
    expect(events[2]).toMatchObject({ kind: "assistant_text", text: "Done." });
  });
});

describe("toEvents — user with tool_result content", () => {
  it("extracts tool_result items from user message", () => {
    const obj = {
      type: "user",
      message: {
        content: [
          { type: "tool_result", tool_use_id: "tu-6", content: "result text", is_error: false },
        ],
      },
    };
    const [ev] = toEvents(obj);
    expect(ev).toMatchObject({ kind: "tool_result", toolUseId: "tu-6", isError: false });
  });

  it("falls back to user event when no tool_result items", () => {
    const obj = { type: "user", message: { content: [] } };
    const [ev] = toEvents(obj);
    expect(ev.kind).toBe("user");
  });
});

describe("toEvents — turn.completed and step_finish", () => {
  it("turn.completed emits result with success=true", () => {
    const obj = { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } };
    const [ev] = toEvents(obj);
    expect(ev).toMatchObject({ kind: "result", success: true });
  });

  it("step_finish with reason=stop emits result", () => {
    const obj = {
      type: "step_finish",
      part: { reason: "stop", tokens: {} },
      usage: {},
    };
    const [ev] = toEvents(obj);
    expect(ev).toMatchObject({ kind: "result", success: true });
  });

  it("step_finish with non-stop reason returns empty", () => {
    const obj = { type: "step_finish", part: { reason: "tool_use" }, usage: {} };
    expect(toEvents(obj)).toHaveLength(0);
  });
});

describe("toEvents — item events", () => {
  it("item.completed todo_list emits todo_list event", () => {
    const obj = {
      type: "item.completed",
      item: {
        type: "todoList",
        id: "todo-1",
        items: [
          { text: "Write tests", completed: true },
          { text: "Run tests", completed: false },
        ],
      },
    };
    const [ev] = toEvents(obj);
    expect(ev).toMatchObject({
      kind: "todo_list",
      items: [
        { text: "Write tests", completed: true },
        { text: "Run tests", completed: false },
      ],
    });
  });

  it("item.started command_execution emits Bash tool_use", () => {
    const obj = {
      type: "item.started",
      item: { type: "commandExecution", id: "cmd-1", command: "npm test" },
    };
    const [ev] = toEvents(obj);
    expect(ev).toMatchObject({ kind: "tool_use", name: "Bash", id: "cmd-1" });
  });

  it("item.completed command_execution emits tool_result", () => {
    const obj = {
      type: "item.completed",
      item: {
        type: "commandExecution",
        id: "cmd-2",
        aggregated_output: "all good",
        exit_code: 0,
      },
    };
    const [ev] = toEvents(obj);
    expect(ev).toMatchObject({ kind: "tool_result", toolUseId: "cmd-2", isError: false });
  });

  it("item.completed command_execution with non-zero exit is error", () => {
    const obj = {
      type: "item.completed",
      item: { type: "commandExecution", id: "cmd-3", exit_code: 1 },
    };
    const [ev] = toEvents(obj);
    expect(ev).toMatchObject({ kind: "tool_result", isError: true });
  });

  it("filters items with saturn_final_only=true", () => {
    const obj = {
      type: "item.completed",
      item: { type: "agent_message", id: "x", saturn_final_only: true, text: "hi" },
    };
    expect(toEvents(obj)).toHaveLength(0);
  });
});

// ── tokenBreakdownFromRaw ───────────────────────────────────────────────────

describe("tokenBreakdownFromRaw", () => {
  it("handles standard Claude usage fields", () => {
    const raw = {
      usage: {
        input_tokens: 200,
        output_tokens: 50,
        cache_creation_input_tokens: 30,
        cache_read_input_tokens: 100,
      },
    };
    const bd = tokenBreakdownFromRaw(raw);
    expect(bd.input).toBe(200);
    expect(bd.output).toBe(50);
    expect(bd.cacheCreation).toBe(30);
    expect(bd.cacheRead).toBe(100);
    expect(bd.total).toBeGreaterThan(0);
  });

  it("handles object-form cache_creation_input_tokens (ephemeral cache)", () => {
    const raw = {
      usage: {
        input_tokens: 100,
        output_tokens: 20,
        cache_creation_input_tokens: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 5 },
        cache_read_input_tokens: 0,
      },
    };
    const bd = tokenBreakdownFromRaw(raw);
    expect(bd.cacheCreation).toBe(15);
  });

  it("returns zero breakdown for empty usage", () => {
    const bd = tokenBreakdownFromRaw({ usage: {} });
    expect(bd.total).toBe(0);
    expect(bd.cacheEfficiency).toBe(0);
  });

  it("handles modelUsage (multi-model) format", () => {
    const raw = {
      modelUsage: {
        "claude-3-5-sonnet": { inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 10, cacheReadInputTokens: 20 },
        "claude-3-haiku": { inputTokens: 30, outputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 5 },
      },
    };
    const bd = tokenBreakdownFromRaw(raw);
    expect(bd.input).toBe(130);
    expect(bd.output).toBe(60);
    expect(bd.cacheCreation).toBe(10);
    expect(bd.cacheRead).toBe(25);
  });

  it("handles OpenCode step_finish part.tokens format", () => {
    const raw = {
      type: "step_finish",
      part: {
        reason: "stop",
        tokens: { input: 80, output: 20, cache: { write: 5, read: 15 }, reasoning: 0 },
      },
    };
    const bd = tokenBreakdownFromRaw(raw);
    expect(bd.input).toBe(80);
    expect(bd.output).toBe(20);
    expect(bd.cacheCreation).toBe(5);
    expect(bd.cacheRead).toBe(15);
    expect(bd.total).toBe(120);
  });
});

// ── getTokenBreakdown ───────────────────────────────────────────────────────

describe("getTokenBreakdown", () => {
  it("returns zero breakdown when no result events", () => {
    const events = [{ kind: "assistant_text" as const, text: "hi", raw: {} }];
    const bd = getTokenBreakdown(events);
    expect(bd.total).toBe(0);
  });

  it("uses the last result event (Claude cumulative format)", () => {
    const events = [
      {
        kind: "result" as const,
        success: true,
        totalTokens: 50,
        numTurns: 1,
        raw: { usage: { input_tokens: 40, output_tokens: 10 } },
      },
      {
        kind: "result" as const,
        success: true,
        totalTokens: 120,
        numTurns: 2,
        raw: { usage: { input_tokens: 100, output_tokens: 20 } },
      },
    ];
    const bd = getTokenBreakdown(events);
    expect(bd.input).toBe(100);
    expect(bd.output).toBe(20);
  });
});

// ── getToolCallSummary ──────────────────────────────────────────────────────

describe("getToolCallSummary", () => {
  it("counts tool uses and tracks failures", () => {
    const events = [
      { kind: "tool_use" as const, id: "1", name: "Bash", input: {}, raw: {} },
      { kind: "tool_use" as const, id: "2", name: "Bash", input: {}, raw: {} },
      { kind: "tool_use" as const, id: "3", name: "Read", input: {}, raw: {} },
      { kind: "tool_result" as const, toolUseId: "2", content: "err", isError: true, raw: {} },
    ];
    const summary = getToolCallSummary(events);
    const bash = summary.find((s) => s.toolName === "Bash");
    const read = summary.find((s) => s.toolName === "Read");
    expect(bash).toMatchObject({ count: 2, failures: 1 });
    expect(read).toMatchObject({ count: 1, failures: 0 });
  });

  it("returns sorted by count descending", () => {
    const events = [
      { kind: "tool_use" as const, id: "a", name: "Read", input: {}, raw: {} },
      { kind: "tool_use" as const, id: "b", name: "Bash", input: {}, raw: {} },
      { kind: "tool_use" as const, id: "c", name: "Bash", input: {}, raw: {} },
    ];
    const summary = getToolCallSummary(events);
    expect(summary[0].toolName).toBe("Bash");
    expect(summary[1].toolName).toBe("Read");
  });

  it("returns empty array for no tool events", () => {
    expect(getToolCallSummary([])).toHaveLength(0);
  });
});

// ── Message order — long streams ─────────────────────────────────────────────

describe("parseStreamJsonl — message ordering in long streams", () => {
  function textLine(text: string) {
    return JSON.stringify({ type: "text", part: { text } });
  }
  function toolUseLine(id: string, name: string) {
    return JSON.stringify({ type: "tool_use", part: { callID: id, tool: name, state: {} } });
  }
  function toolResultLine(id: string, output: string, error = false) {
    return JSON.stringify({ type: "tool_result", part: { toolUseId: id, output, error } });
  }
  function resultLine(turns: number) {
    return JSON.stringify({ type: "result", subtype: "success", num_turns: turns, usage: { input_tokens: 100, output_tokens: 50 } });
  }

  it("preserves insertion order for 100 sequential text messages", () => {
    const lines = Array.from({ length: 100 }, (_, i) => textLine(`Message ${i}`));
    const events = parseStreamJsonl(lines.join("\n"));
    expect(events).toHaveLength(100);
    for (let i = 0; i < 100; i++) {
      expect(events[i]).toMatchObject({ kind: "assistant_text", text: `Message ${i}` });
    }
  });

  it("preserves order of interleaved tool_use and tool_result events", () => {
    const lines = [
      toolUseLine("tu-1", "Read"),
      toolResultLine("tu-1", "file contents"),
      toolUseLine("tu-2", "Edit"),
      toolResultLine("tu-2", "done"),
      toolUseLine("tu-3", "Bash"),
      toolResultLine("tu-3", "exit 0"),
    ];
    const events = parseStreamJsonl(lines.join("\n"));
    expect(events).toHaveLength(6);
    expect(events[0]).toMatchObject({ kind: "tool_use", id: "tu-1", name: "Read" });
    expect(events[1]).toMatchObject({ kind: "tool_result", toolUseId: "tu-1" });
    expect(events[2]).toMatchObject({ kind: "tool_use", id: "tu-2", name: "Edit" });
    expect(events[3]).toMatchObject({ kind: "tool_result", toolUseId: "tu-2" });
    expect(events[4]).toMatchObject({ kind: "tool_use", id: "tu-3", name: "Bash" });
    expect(events[5]).toMatchObject({ kind: "tool_result", toolUseId: "tu-3" });
  });

  it("maintains order across a realistic multi-turn stream (text → tools → text → result)", () => {
    const turns = 5;
    const lines: string[] = [];
    for (let t = 0; t < turns; t++) {
      lines.push(textLine(`Thinking about turn ${t}`));
      lines.push(toolUseLine(`tu-${t}`, "Bash"));
      lines.push(toolResultLine(`tu-${t}`, `output ${t}`));
      lines.push(textLine(`Done with turn ${t}`));
    }
    lines.push(resultLine(turns));

    const events = parseStreamJsonl(lines.join("\n"));
    // 4 events per turn (text, tool_use, tool_result, text) + 1 result
    expect(events).toHaveLength(turns * 4 + 1);

    for (let t = 0; t < turns; t++) {
      const base = t * 4;
      expect(events[base]).toMatchObject({ kind: "assistant_text", text: `Thinking about turn ${t}` });
      expect(events[base + 1]).toMatchObject({ kind: "tool_use", id: `tu-${t}` });
      expect(events[base + 2]).toMatchObject({ kind: "tool_result", toolUseId: `tu-${t}` });
      expect(events[base + 3]).toMatchObject({ kind: "assistant_text", text: `Done with turn ${t}` });
    }
    expect(events[turns * 4]).toMatchObject({ kind: "result", numTurns: turns });
  });

  it("does not reorder events when invalid JSON lines are interspersed", () => {
    const lines = [
      textLine("first"),
      "not valid json",
      textLine("second"),
      "",
      textLine("third"),
    ];
    const events = parseStreamJsonl(lines.join("\n"));
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ kind: "assistant_text", text: "first" });
    expect(events[1]).toMatchObject({ kind: "assistant_text", text: "second" });
    expect(events[2]).toMatchObject({ kind: "assistant_text", text: "third" });
  });

  it("preserves order for 50 interleaved tool pairs with unique ids", () => {
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      lines.push(toolUseLine(`id-${i}`, i % 2 === 0 ? "Read" : "Bash"));
      lines.push(toolResultLine(`id-${i}`, `result-${i}`, false));
    }
    const events = parseStreamJsonl(lines.join("\n"));
    expect(events).toHaveLength(100);
    for (let i = 0; i < 50; i++) {
      const useEv = events[i * 2];
      const resultEv = events[i * 2 + 1];
      expect(useEv).toMatchObject({ kind: "tool_use", id: `id-${i}` });
      expect(resultEv).toMatchObject({ kind: "tool_result", toolUseId: `id-${i}` });
    }
  });

  it("long text content in a single message is preserved verbatim", () => {
    const longText = "word ".repeat(2000).trimEnd(); // ~10 000 chars
    const line = JSON.stringify({ type: "text", part: { text: longText } });
    const events = parseStreamJsonl(line);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "assistant_text", text: longText });
  });
});
