// Client-safe utilities for SessionMeta and Agent — no Node.js built-ins.
// NOTE: slices.ts imports node:fs at runtime, but we only need its types here.
// `import type` is erased at compile time so it won't leak fs into client bundles.
import type { CLI, SessionMeta, Agent, OrchestratorBudget } from "./runs";
import type { Slice } from "./slices";
import { DEFAULT_CLI, normalizeCli } from "./clis";

export function isMultiCli(session: SessionMeta): boolean {
  const clis = new Set(session.turns.map((t) => normalizeCli(t.cli)));
  return clis.size > 1;
}

export function getCliList(session: SessionMeta): CLI[] {
  return Array.from(new Set(session.turns.map((t) => normalizeCli(t.cli))));
}

export function agentDefaultCli(agent: Agent): CLI {
  return normalizeCli(agent.defaultCli ?? agent.cli);
}

export function agentSupportedClis(agent: Agent): CLI[] {
  if (agent.supportedClis?.length) return agent.supportedClis.map((cli) => normalizeCli(cli));
  if (agent.cli) return [normalizeCli(agent.cli)];
  return [DEFAULT_CLI];
}

export function agentModelForCli(agent: Agent, cli: CLI): string | undefined {
  const normalized = normalizeCli(cli);
  return agent.models?.[normalized] ?? (normalized === agentDefaultCli(agent) ? agent.model : undefined);
}

/**
 * Pick the display title for a session. Priority:
 *   1. Latest user message, matching the inbox/sidebar chat naming.
 *   2. Pending message during initial navigation before the turn stub exists.
 *   3. Explicit override, used only when no user message has been recorded.
 *   4. Agent name if there are no turns yet.
 *   5. "New chat" as a last-resort fallback.
 */
export function sessionTitle(s: SessionMeta, pendingMessage?: string): string {
  const turns = s.turns ?? [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    const msg = t?.user_message?.replace(/\s+/g, " ").trim();
    if (msg) return compactSessionTitle(msg);
  }

  const pending = pendingMessage?.replace(/\s+/g, " ").trim();
  if (pending) return compactSessionTitle(pending);

  const override = s.title_override?.replace(/\s+/g, " ").trim();
  if (override) return compactSessionTitle(override);

  const name = s.agent_snapshot?.name;
  if (name && !isAdHocAgentName(name)) return name;
  return "New chat";
}

function compactSessionTitle(value: string): string {
  return value.length > 120 ? value.slice(0, 117) + "…" : value;
}

function isAdHocAgentName(value: string): boolean {
  return ["adhoc", "adhocchat"].includes(value.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

// ─── Swarm helpers ────────────────────────────────────────────────────────

export function isOrchestrator(agent: Agent | undefined): boolean {
  return agent?.kind === "orchestrator";
}

export function effectiveSwarmAgent(agent: Agent, meta?: SessionMeta): Agent {
  const overrideSlices = meta?.overrides?.slices_available;
  if (isOrchestrator(agent)) {
    return overrideSlices !== undefined ? { ...agent, slices_available: overrideSlices } : agent;
  }

  return {
    ...agent,
    kind: "orchestrator",
    slices_available: overrideSlices ?? agent.slices_available ?? "*",
    can_create_custom_slices: agent.can_create_custom_slices ?? false,
    allowed_mutations: agent.allowed_mutations ?? ["read-only", "writes-scratch", "writes-source"],
    budget: agent.budget ?? {},
    on_budget_exceeded: agent.on_budget_exceeded ?? "report-partial",
    on_slice_failure: agent.on_slice_failure ?? "continue",
  };
}

export function effectiveOrchestratorLimits(agent: Agent, overrides?: OrchestratorBudget): OrchestratorBudget {
  const base = agent.budget ?? {};
  const over = overrides ?? {};
  return {
    max_total_tokens: over.max_total_tokens ?? base.max_total_tokens,
    max_slice_calls: over.max_slice_calls ?? base.max_slice_calls,
    max_recursion_depth: over.max_recursion_depth ?? base.max_recursion_depth,
  };
}

export function sliceInputsValid(
  slice: Slice,
  inputs: Record<string, unknown>
): { ok: true } | { ok: false; missing: string[] } {
  const required = slice.prompt_template.required ?? [];
  const missing = required.filter((key) => !(key in inputs));
  if (missing.length === 0) return { ok: true };
  return { ok: false, missing };
}

export function sliceFilterForOrchestrator(slices: Slice[], orchestrator: Agent): Slice[] {
  const available = orchestrator.slices_available;
  const allowedMutations = orchestrator.allowed_mutations;
  const idWhitelist = available !== undefined && available !== "*" ? available : null;
  const mutationWhitelist =
    allowedMutations && allowedMutations.length > 0
      ? (allowedMutations as readonly string[])
      : null;
  return slices.filter((slice) => {
    if (idWhitelist && !idWhitelist.includes(slice.id)) return false;
    if (mutationWhitelist && !mutationWhitelist.includes(slice.capability.mutation)) return false;
    return true;
  });
}
