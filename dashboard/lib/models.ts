import type { CLI } from "./clis";

export type Model = {
  id: string;
  name: string;
  contextWindow?: number;
  loadedContextWindow?: number;
  maxOutputTokens?: number;
  defaultReasoningEffort?: ModelReasoningEffort;
  supportedReasoningEfforts?: ModelReasoningEffort[];
};

export type ModelReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ReasoningCli = CLI;

export const REASONING_EFFORT_OPTIONS: Array<{
  value: ModelReasoningEffort;
  label: string;
  description: string;
}> = [
  { value: "minimal", label: "Minimal", description: "Fastest responses with the least extra reasoning." },
  { value: "low", label: "Low", description: "Lighter reasoning for routine work." },
  { value: "medium", label: "Medium", description: "Balanced speed and reasoning depth." },
  { value: "high", label: "High", description: "Deeper reasoning for complex work." },
  { value: "xhigh", label: "XHigh", description: "Extra reasoning for difficult tasks." },
  { value: "max", label: "Max", description: "Claude's maximum effort setting." },
];

export const REASONING_EFFORTS_BY_CLI: Record<ReasoningCli, ModelReasoningEffort[]> = {
  "claude-bedrock": ["low", "medium", "high", "xhigh", "max"],
  "claude-personal": ["low", "medium", "high", "xhigh", "max"],
  "claude-local": ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
};

export function normalizeReasoningEffortForCli(
  cli: ReasoningCli,
  effort?: ModelReasoningEffort | null,
): ModelReasoningEffort | undefined {
  if (!effort) return undefined;
  if ((cli === "claude-bedrock" || cli === "claude-personal" || cli === "claude-local") && effort === "minimal") return "low";
  if (cli === "codex" && effort === "max") return "xhigh";
  return REASONING_EFFORTS_BY_CLI[cli].includes(effort) ? effort : undefined;
}

export function reasoningEffortOptionsForCli(
  cli: ReasoningCli,
  model?: Pick<Model, "supportedReasoningEfforts"> | null,
): typeof REASONING_EFFORT_OPTIONS {
  const cliEfforts = REASONING_EFFORTS_BY_CLI[cli];
  const modelEfforts = model?.supportedReasoningEfforts;
  const allowed = modelEfforts ? cliEfforts.filter((effort) => modelEfforts.includes(effort)) : cliEfforts;
  return REASONING_EFFORT_OPTIONS.filter((option) => allowed.includes(option.value));
}

export function formatReasoningEffort(effort?: ModelReasoningEffort | null): string {
  if (!effort) return "Default";
  return REASONING_EFFORT_OPTIONS.find((o) => o.value === effort)?.label ?? effort;
}

export function formatTokenCount(tokens?: number): string | null {
  if (!tokens || !Number.isFinite(tokens)) return null;
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}K`;
  }
  return tokens.toLocaleString();
}

export function formatContextWindow(model: Pick<Model, "contextWindow" | "loadedContextWindow">): string | null {
  const max = formatTokenCount(model.contextWindow);
  const loaded = formatTokenCount(model.loadedContextWindow);

  if (loaded && max && model.loadedContextWindow !== model.contextWindow) {
    return `${loaded}/${max} ctx`;
  }

  const value = loaded ?? max;
  return value ? `${value} ctx` : null;
}

export function formatModelOption(model: Model): string {
  const context = formatContextWindow(model);
  return context ? `${model.name} (${context})` : model.name;
}
