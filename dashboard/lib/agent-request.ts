import { toClaudeAlias } from "./claude-models";
import { DEFAULT_CLI, isCli } from "./clis";
import type { Agent, CLI } from "./runs";

type AgentPatch = Partial<Agent> & Record<string, unknown>;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseCli(value: unknown, field: string): { ok: true; cli: CLI } | { ok: false; error: string } {
  if (value === "claude") return { ok: true, cli: "claude-bedrock" };
  if (!isCli(value)) {
    return { ok: false, error: `${field} must be one of claude-bedrock, claude-personal, claude-local, or codex` };
  }
  return { ok: true, cli: value };
}

export function normalizeAgentCliFields(
  body: AgentPatch,
): { ok: true; supportedClis: CLI[]; defaultCli: CLI } | { ok: false; error: string } {
  const rawSupported = body.supportedClis ?? (body.cli !== undefined ? [body.cli] : [DEFAULT_CLI]);
  if (!Array.isArray(rawSupported) || rawSupported.length === 0) {
    return { ok: false, error: "supportedClis must be a non-empty array" };
  }

  const supportedClis: CLI[] = [];
  for (const item of rawSupported) {
    const parsed = parseCli(item, "supportedClis");
    if (!parsed.ok) return parsed;
    if (!supportedClis.includes(parsed.cli)) supportedClis.push(parsed.cli);
  }

  const parsedDefault = parseCli(body.defaultCli ?? body.cli ?? supportedClis[0], "defaultCli");
  if (!parsedDefault.ok) return parsedDefault;
  if (!supportedClis.includes(parsedDefault.cli)) {
    return { ok: false, error: "defaultCli must be included in supportedClis" };
  }

  return { ok: true, supportedClis, defaultCli: parsedDefault.cli };
}

export function shouldNormalizeAgentCliFields(body: AgentPatch): boolean {
  return body.supportedClis !== undefined || body.defaultCli !== undefined || body.cli !== undefined;
}

export function normalizeAgentModelFields(body: AgentPatch): string | null {
  if (typeof body.model === "string" && body.model) {
    body.model = toClaudeAlias(body.model) ?? body.model;
  } else if (body.model !== undefined && body.model !== null && body.model !== "") {
    return "model must be a string";
  }

  if (body.models === undefined) return null;
  if (!isPlainObject(body.models)) return "models must be an object";

  const models: Partial<Record<CLI, string>> = {};
  for (const [cliValue, modelValue] of Object.entries(body.models)) {
    const parsedCli = parseCli(cliValue, "models");
    if (!parsedCli.ok) return "models keys must be valid CLI names";
    if (modelValue === undefined || modelValue === null || modelValue === "") continue;
    if (typeof modelValue !== "string") return "models values must be strings";
    models[parsedCli.cli] = toClaudeAlias(modelValue) ?? modelValue;
  }
  body.models = Object.keys(models).length > 0 ? models : undefined;
  return null;
}
