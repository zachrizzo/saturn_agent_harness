/**
 * Single source of truth for Claude (Bedrock) model identifiers.
 *
 * Why this exists: Bedrock's inference API only accepts fully-qualified
 * inference profile IDs like `global.anthropic.claude-sonnet-4-6`. Our agents,
 * presets, and UI copy all want to use short aliases like `claude-sonnet-4-6`.
 * Without a shared mapping, the short alias leaks into orchestrator/SDK paths
 * that do not go through the CLI's own alias resolver and Bedrock rejects it
 * with `400 The provided model identifier is invalid`.
 *
 * The data lives in `claude-models.json` so the bash dispatch layer
 * (`bin/lib/cli-dispatch.sh`) can read the same table without duplicating it.
 * Any code that stores, displays, or dispatches a Claude model must go through
 * this module.
 */

import claudeModelsData from "./claude-models.json";

export type ClaudeAliasId = string;

export type ClaudeModelSpec = {
  /** Short alias used in agent configs, UI, presets, etc. */
  alias: ClaudeAliasId;
  /** Full Bedrock inference profile ID — the only thing Bedrock accepts. */
  bedrockId: string;
  /** Human-friendly display name. */
  displayName: string;
  /** Max context window the model supports. */
  contextWindow: number;
};

export const CLAUDE_MODELS: readonly ClaudeModelSpec[] = claudeModelsData.models;

/** Short alias → full spec. */
const BY_ALIAS = new Map<string, ClaudeModelSpec>(
  CLAUDE_MODELS.map((m) => [m.alias, m]),
);

/** Full Bedrock ID → full spec. Keyed by both `global.*` and `us.*` variants. */
const BY_BEDROCK_ID = new Map<string, ClaudeModelSpec>(
  CLAUDE_MODELS.flatMap((m) => {
    const baseId = m.bedrockId.replace(/^(global|us)\./, "");
    return [
      [m.bedrockId, m] as const,
      [`us.${baseId}`, m] as const,
      [`global.${baseId}`, m] as const,
    ];
  }),
);

/** Default model used when an agent/preset doesn't specify one. */
export const DEFAULT_CLAUDE_ALIAS: ClaudeAliasId = claudeModelsData.defaults.alias;

/** Default "cheap tier" model for short-lived slices and bucketing tasks. */
export const DEFAULT_CHEAP_CLAUDE_ALIAS: ClaudeAliasId = claudeModelsData.defaults.cheapAlias;

/**
 * Canonicalize any Claude model identifier to the short alias form, if known.
 * Returns the input unchanged if it's not a recognized ID — the caller must
 * still be tolerant of custom or legacy strings.
 */
export function toClaudeAlias(model: string | undefined | null): string | undefined {
  if (!model) return undefined;
  if (BY_ALIAS.has(model)) return model;
  const byBedrock = BY_BEDROCK_ID.get(model);
  if (byBedrock) return byBedrock.alias;
  return model;
}

/**
 * Resolve any Claude model identifier to the Bedrock inference profile ID.
 * Used at the spawn-turn boundary so the CLI/SDK always sees something
 * Bedrock will accept. Unknown / unrecognized inputs are returned unchanged
 * rather than overwritten — they might be a brand-new model the alias table
 * hasn't learned about yet.
 */
export function toBedrockId(model: string | undefined | null): string | undefined {
  if (!model) return undefined;
  // Already fully-qualified — leave alone.
  if (model.startsWith("global.") || model.startsWith("us.") || model.includes(".anthropic.")) {
    return model;
  }
  const spec = BY_ALIAS.get(model);
  return spec?.bedrockId ?? model;
}

/** Get the full spec for a model, by either alias or Bedrock ID. */
export function getClaudeSpec(model: string | undefined | null): ClaudeModelSpec | undefined {
  if (!model) return undefined;
  return BY_ALIAS.get(model) ?? BY_BEDROCK_ID.get(model);
}

/** Look up a context window for any Claude model ID. */
export function claudeContextWindow(model: string | undefined | null): number | undefined {
  return getClaudeSpec(model)?.contextWindow;
}

/** Convenience: the bedrock IDs for the hard-coded fallback list in `/api/models`. */
export function fallbackClaudeModels(): ReadonlyArray<{
  id: string;
  name: string;
  contextWindow: number;
}> {
  return CLAUDE_MODELS.map((m) => ({
    id: m.bedrockId,
    name: m.displayName,
    contextWindow: m.contextWindow,
  }));
}
