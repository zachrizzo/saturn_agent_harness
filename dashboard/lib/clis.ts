export const CLI_VALUES = ["claude-bedrock", "claude-personal", "claude-local", "codex"] as const;

export type CLI = (typeof CLI_VALUES)[number];
export type LegacyCLI = CLI | "claude";

export const DEFAULT_CLI: CLI = "claude-bedrock";

const CLI_SET = new Set<string>(CLI_VALUES);

export const CLI_LABELS: Record<CLI, string> = {
  "claude-bedrock": "Claude (Bedrock)",
  "claude-personal": "Claude (Personal)",
  "claude-local": "Claude (Local)",
  codex: "Codex",
};

export const CLI_SHORT_LABELS: Record<CLI, string> = {
  "claude-bedrock": "Bedrock",
  "claude-personal": "Personal",
  "claude-local": "Local",
  codex: "Codex",
};

export function isCli(value: unknown): value is CLI {
  return typeof value === "string" && CLI_SET.has(value);
}

export function normalizeCli(value: unknown, fallback: CLI = DEFAULT_CLI): CLI {
  if (value === "claude") return "claude-bedrock";
  return isCli(value) ? value : fallback;
}

export function isClaudeCli(value: unknown): boolean {
  const cli = normalizeCli(value);
  return cli === "claude-bedrock" || cli === "claude-personal" || cli === "claude-local";
}

export function isBedrockCli(value: unknown): boolean {
  return normalizeCli(value) === "claude-bedrock";
}

export function isPersonalClaudeCli(value: unknown): boolean {
  return normalizeCli(value) === "claude-personal";
}

export function isLocalClaudeCli(value: unknown): boolean {
  return normalizeCli(value) === "claude-local";
}
