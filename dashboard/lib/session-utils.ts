// Client-safe utilities for SessionMeta and Agent — no Node.js built-ins.
// NOTE: slices.ts imports node:fs at runtime, but we only need its types here.
// `import type` is erased at compile time so it won't leak fs into client bundles.
import type { CLI, SessionMeta, Agent } from "./runs";
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

// ─── Swarm helpers ────────────────────────────────────────────────────────

export function isOrchestrator(agent: Agent | undefined): boolean {
  return agent?.kind === "orchestrator";
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
