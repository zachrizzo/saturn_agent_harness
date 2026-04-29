import { promises as fs } from "node:fs";
import { settingsFile } from "./paths";
import { normalizeReasoningEffortForCli, type ModelReasoningEffort } from "./models";
import { DEFAULT_CLI, isCli, normalizeCli } from "./clis";
import type { CLI } from "./clis";
import { DEFAULT_BEDROCK_PROFILE, DEFAULT_BEDROCK_REGION } from "./bedrock-config";

export type AppSettings = {
  defaultCli: CLI;
  defaultModels: Partial<Record<CLI, string>>;
  defaultReasoningEfforts: Partial<Record<CLI, ModelReasoningEffort>>;
  defaultMcpTools: boolean;
  hiddenMcpImageServers: string[];
  bedrockProfile: string;
  bedrockRegion: string;
  defaultCwd?: string;
};

const VALID_EFFORTS: ModelReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export const DEFAULT_APP_SETTINGS: AppSettings = {
  defaultCli: DEFAULT_CLI,
  defaultModels: {},
  defaultReasoningEfforts: {},
  defaultMcpTools: false,
  hiddenMcpImageServers: [],
  bedrockProfile: DEFAULT_BEDROCK_PROFILE,
  bedrockRegion: DEFAULT_BEDROCK_REGION,
};

function isEffort(value: unknown): value is ModelReasoningEffort {
  return typeof value === "string" && VALID_EFFORTS.includes(value as ModelReasoningEffort);
}

function cleanStringMap(value: unknown): Partial<Record<CLI, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Partial<Record<CLI, string>> = {};
  for (const [key, raw] of Object.entries(value)) {
    const cli = isCli(key) || key === "claude" ? normalizeCli(key) : undefined;
    if (!cli || typeof raw !== "string" || !raw.trim()) continue;
    out[cli] = raw.trim();
  }
  return out;
}

function cleanEffortMap(value: unknown): Partial<Record<CLI, ModelReasoningEffort>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Partial<Record<CLI, ModelReasoningEffort>> = {};
  for (const [key, raw] of Object.entries(value)) {
    const cli = isCli(key) || key === "claude" ? normalizeCli(key) : undefined;
    if (!cli || !isEffort(raw)) continue;
    const normalized = normalizeReasoningEffortForCli(cli, raw);
    if (normalized) out[cli] = normalized;
  }
  return out;
}

function cleanStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

export function normalizeAppSettings(input: unknown): AppSettings {
  const rec = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const defaultCli = isCli(rec.defaultCli) || rec.defaultCli === "claude"
    ? normalizeCli(rec.defaultCli)
    : DEFAULT_APP_SETTINGS.defaultCli;
  const defaultCwd = typeof rec.defaultCwd === "string" && rec.defaultCwd.trim()
    ? rec.defaultCwd.trim()
    : undefined;
  const bedrockProfile = typeof rec.bedrockProfile === "string" && rec.bedrockProfile.trim()
    ? rec.bedrockProfile.trim()
    : process.env.AWS_PROFILE || DEFAULT_APP_SETTINGS.bedrockProfile;
  const bedrockRegion = typeof rec.bedrockRegion === "string" && rec.bedrockRegion.trim()
    ? rec.bedrockRegion.trim()
    : process.env.AWS_REGION || DEFAULT_APP_SETTINGS.bedrockRegion;

  return {
    defaultCli,
    defaultModels: cleanStringMap(rec.defaultModels),
    defaultReasoningEfforts: cleanEffortMap(rec.defaultReasoningEfforts),
    defaultMcpTools: typeof rec.defaultMcpTools === "boolean" ? rec.defaultMcpTools : DEFAULT_APP_SETTINGS.defaultMcpTools,
    hiddenMcpImageServers: cleanStringList(rec.hiddenMcpImageServers),
    bedrockProfile,
    bedrockRegion,
    ...(defaultCwd ? { defaultCwd } : {}),
  };
}

export async function readAppSettings(): Promise<AppSettings> {
  try {
    const raw = await fs.readFile(settingsFile(), "utf8");
    return normalizeAppSettings(JSON.parse(raw));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return DEFAULT_APP_SETTINGS;
    throw err;
  }
}

export async function writeAppSettings(settings: AppSettings): Promise<AppSettings> {
  const normalized = normalizeAppSettings(settings);
  await fs.writeFile(settingsFile(), JSON.stringify(normalized, null, 2), "utf8");
  return normalized;
}
