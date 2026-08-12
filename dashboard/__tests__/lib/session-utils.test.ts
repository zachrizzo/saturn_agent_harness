import { describe, it, expect } from "vitest";
import {
  isMultiCli,
  getCliList,
  agentDefaultCli,
  agentSupportedClis,
  agentModelForCli,
  sessionTitle,
  isOrchestrator,
  sliceInputsValid,
  sliceFilterForOrchestrator,
} from "../../lib/session-utils";
import type { Agent, SessionMeta, TurnRecord } from "../../lib/runs";
import type { Slice } from "../../lib/slices";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTurn(cli: string, userMessage = "hello"): TurnRecord {
  return {
    cli: cli as TurnRecord["cli"],
    started_at: new Date().toISOString(),
    user_message: userMessage,
  };
}

function makeSession(turns: TurnRecord[]): SessionMeta {
  return {
    session_id: "s1",
    started_at: new Date().toISOString(),
    status: "success",
    turns,
  };
}

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "a1",
    name: "Test Agent",
    prompt: "You are a test.",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeSlice(overrides: Partial<Slice> = {}): Slice {
  return {
    id: "slice-1",
    name: "Test Slice",
    version: 1,
    created_at: new Date().toISOString(),
    cli: "claude-bedrock",
    capability: {
      mutation: "read-only",
      scope: ["repo"],
      output: { kind: "markdown" },
      interactivity: "one-shot",
      cost_tier: "free",
    },
    prompt_template: { system: "Do stuff with {{target}}", variables: ["target"], required: ["target"] },
    sandbox: { mode: "none", net: "deny" },
    ...overrides,
  };
}

// ── isMultiCli ───────────────────────────────────────────────────────────────

describe("isMultiCli", () => {
  it("returns false when all turns use the same CLI", () => {
    const session = makeSession([makeTurn("claude-bedrock"), makeTurn("claude-bedrock")]);
    expect(isMultiCli(session)).toBe(false);
  });

  it("returns true when turns span multiple CLIs", () => {
    const session = makeSession([makeTurn("claude-bedrock"), makeTurn("codex")]);
    expect(isMultiCli(session)).toBe(true);
  });

  it("returns false for a single-turn session", () => {
    const session = makeSession([makeTurn("claude-personal")]);
    expect(isMultiCli(session)).toBe(false);
  });

  it("normalizes legacy 'claude' turns", () => {
    const session = makeSession([makeTurn("claude"), makeTurn("claude-bedrock")]);
    expect(isMultiCli(session)).toBe(false); // both normalize to claude-bedrock
  });
});

// ── getCliList ───────────────────────────────────────────────────────────────

describe("getCliList", () => {
  it("returns deduplicated list of CLIs", () => {
    const session = makeSession([makeTurn("claude-bedrock"), makeTurn("claude-bedrock"), makeTurn("codex")]);
    expect(getCliList(session)).toEqual(["claude-bedrock", "codex"]);
  });

  it("returns empty array for session with no turns", () => {
    expect(getCliList(makeSession([]))).toHaveLength(0);
  });
});

// ── agentDefaultCli ──────────────────────────────────────────────────────────

describe("agentDefaultCli", () => {
  it("uses defaultCli when set", () => {
    const agent = makeAgent({ defaultCli: "codex" });
    expect(agentDefaultCli(agent)).toBe("codex");
  });

  it("falls back to cli field", () => {
    const agent = makeAgent({ cli: "claude-personal" });
    expect(agentDefaultCli(agent)).toBe("claude-personal");
  });

  it("falls back to DEFAULT_CLI when neither is set", () => {
    const agent = makeAgent();
    expect(agentDefaultCli(agent)).toBe("claude-bedrock");
  });
});

// ── agentSupportedClis ───────────────────────────────────────────────────────

describe("agentSupportedClis", () => {
  it("returns normalized supportedClis when present", () => {
    const agent = makeAgent({ supportedClis: ["claude-personal", "codex"] });
    expect(agentSupportedClis(agent)).toEqual(["claude-personal", "codex"]);
  });

  it("wraps legacy cli field in an array", () => {
    const agent = makeAgent({ cli: "claude-local" });
    expect(agentSupportedClis(agent)).toEqual(["claude-local"]);
  });

  it("returns DEFAULT_CLI array when nothing is set", () => {
    expect(agentSupportedClis(makeAgent())).toEqual(["claude-bedrock"]);
  });
});

// ── agentModelForCli ─────────────────────────────────────────────────────────

describe("agentModelForCli", () => {
  it("returns model from models map for the given CLI", () => {
    const agent = makeAgent({ models: { "claude-bedrock": "claude-3-5-sonnet", codex: "o3-mini" } });
    expect(agentModelForCli(agent, "claude-bedrock")).toBe("claude-3-5-sonnet");
    expect(agentModelForCli(agent, "codex")).toBe("o3-mini");
  });

  it("returns agent.model when CLI matches defaultCli and no models map", () => {
    const agent = makeAgent({ model: "claude-3-haiku", defaultCli: "claude-bedrock" });
    expect(agentModelForCli(agent, "claude-bedrock")).toBe("claude-3-haiku");
  });

  it("returns undefined for a CLI not in the models map and not the default", () => {
    const agent = makeAgent({ defaultCli: "claude-bedrock", model: "claude-3-haiku" });
    expect(agentModelForCli(agent, "codex")).toBeUndefined();
  });
});

// ── sessionTitle ─────────────────────────────────────────────────────────────

describe("sessionTitle", () => {
  it("uses first turn user_message", () => {
    const session = makeSession([makeTurn("claude-bedrock", "What is the weather?")]);
    expect(sessionTitle(session)).toBe("What is the weather?");
  });

  it("truncates long messages with ellipsis when over 120 chars", () => {
    const long = "A".repeat(130);
    const session = makeSession([makeTurn("claude-bedrock", long)]);
    const title = sessionTitle(session);
    expect(title.length).toBeLessThan(130);
    expect(title.endsWith("…")).toBe(true);
  });

  it("collapses internal whitespace", () => {
    const session = makeSession([makeTurn("claude-bedrock", "hello   world")]);
    expect(sessionTitle(session)).toBe("hello world");
  });

  it("uses pendingMessage when no turns exist", () => {
    const session = makeSession([]);
    expect(sessionTitle(session, "Pending question")).toBe("Pending question");
  });

  it("uses agent name when no turns and no pending message (non-adhoc agent)", () => {
    const session = makeSession([]);
    (session as SessionMeta & { agent_snapshot?: { name: string } }).agent_snapshot = { name: "My Agent" } as Agent;
    expect(sessionTitle(session)).toBe("My Agent");
  });

  it("falls back to 'New chat' for adhoc agent names", () => {
    const session = makeSession([]);
    (session as SessionMeta & { agent_snapshot?: { name: string } }).agent_snapshot = { name: "adhoc" } as Agent;
    expect(sessionTitle(session)).toBe("New chat");
  });

  it("falls back to 'New chat' when nothing available", () => {
    expect(sessionTitle(makeSession([]))).toBe("New chat");
  });
});

// ── isOrchestrator ────────────────────────────────────────────────────────────

describe("isOrchestrator", () => {
  it("returns true for orchestrator kind", () => {
    expect(isOrchestrator(makeAgent({ kind: "orchestrator" }))).toBe(true);
  });

  it("returns false for chat kind", () => {
    expect(isOrchestrator(makeAgent({ kind: "chat" }))).toBe(false);
  });

  it("returns false when agent is undefined", () => {
    expect(isOrchestrator(undefined)).toBe(false);
  });
});

// ── sliceInputsValid ─────────────────────────────────────────────────────────

describe("sliceInputsValid", () => {
  it("returns ok=true when all required inputs are provided", () => {
    const slice = makeSlice({ prompt_template: { system: "", variables: ["target"], required: ["target"] } });
    expect(sliceInputsValid(slice, { target: "src/" })).toEqual({ ok: true });
  });

  it("returns ok=false with missing keys listed", () => {
    const slice = makeSlice({
      prompt_template: { system: "", variables: ["target", "depth"], required: ["target", "depth"] },
    });
    const result = sliceInputsValid(slice, { target: "src/" });
    expect(result).toMatchObject({ ok: false, missing: ["depth"] });
  });

  it("returns ok=true when no required fields defined", () => {
    const slice = makeSlice({ prompt_template: { system: "", variables: [], required: [] } });
    expect(sliceInputsValid(slice, {})).toEqual({ ok: true });
  });
});

// ── sliceFilterForOrchestrator ────────────────────────────────────────────────

describe("sliceFilterForOrchestrator", () => {
  const slices = [
    makeSlice({ id: "slice-read", capability: { ...makeSlice().capability, mutation: "read-only" } }),
    makeSlice({ id: "slice-write", capability: { ...makeSlice().capability, mutation: "writes-source" } }),
    makeSlice({ id: "slice-exec", capability: { ...makeSlice().capability, mutation: "executes-side-effects" } }),
  ];

  it("returns all slices when orchestrator has no restrictions", () => {
    const orchestrator = makeAgent({ kind: "orchestrator" });
    expect(sliceFilterForOrchestrator(slices, orchestrator)).toHaveLength(3);
  });

  it("filters by slices_available id whitelist", () => {
    const orchestrator = makeAgent({ kind: "orchestrator", slices_available: ["slice-read", "slice-exec"] });
    const result = sliceFilterForOrchestrator(slices, orchestrator);
    expect(result.map((s) => s.id)).toEqual(["slice-read", "slice-exec"]);
  });

  it("uses '*' to allow all slices", () => {
    const orchestrator = makeAgent({ kind: "orchestrator", slices_available: "*" });
    expect(sliceFilterForOrchestrator(slices, orchestrator)).toHaveLength(3);
  });

  it("filters by allowed_mutations", () => {
    const orchestrator = makeAgent({ kind: "orchestrator", allowed_mutations: ["read-only"] });
    const result = sliceFilterForOrchestrator(slices, orchestrator);
    expect(result.map((s) => s.id)).toEqual(["slice-read"]);
  });

  it("combines id whitelist and mutation filter (both must pass)", () => {
    const orchestrator = makeAgent({
      kind: "orchestrator",
      slices_available: ["slice-read", "slice-write"],
      allowed_mutations: ["read-only"],
    });
    const result = sliceFilterForOrchestrator(slices, orchestrator);
    expect(result.map((s) => s.id)).toEqual(["slice-read"]);
  });
});
