import { promises as fs } from "node:fs";
import { settingsFile } from "./paths";
import { isModelReasoningEffort, normalizeReasoningEffortForCli, type ModelReasoningEffort } from "./models";
import { DEFAULT_CLI, isCli, normalizeCli } from "./clis";
import type { CLI } from "./clis";
import { DEFAULT_BEDROCK_PROFILE, DEFAULT_BEDROCK_REGION } from "./bedrock-config";

export type MemoryRetrievalMode = "keyword" | "semantic" | "hybrid";
export type MemoryProvider = "openai-compatible" | "bedrock" | "local-http" | "disabled";

export type AppSettings = {
  defaultCli: CLI;
  defaultModels: Partial<Record<CLI, string>>;
  defaultReasoningEfforts: Partial<Record<CLI, ModelReasoningEffort>>;
  defaultMcpTools: boolean;
  hiddenMcpImageServers: string[];
  bedrockProfile: string;
  bedrockRegion: string;
  memoryEnabled: boolean;
  memoryAutoCapture: boolean;
  memoryRecallLimit: number;
  memoryRetrievalMode: MemoryRetrievalMode;
  memoryEmbeddingProvider: MemoryProvider;
  memoryEmbeddingModel: string;
  memoryEmbeddingBaseUrl: string;
  memoryEmbeddingApiKey: string;
  memoryEmbeddingDimensions: number;
  memoryCuratorEnabled: boolean;
  memoryCuratorProvider: MemoryProvider;
  memoryCuratorModel: string;
  memoryCuratorBaseUrl: string;
  memoryCuratorApiKey: string;
  defaultCwd?: string;
};

const VALID_MEMORY_RETRIEVAL_MODES: MemoryRetrievalMode[] = ["keyword", "semantic", "hybrid"];
const VALID_MEMORY_PROVIDERS: MemoryProvider[] = ["openai-compatible", "bedrock", "local-http", "disabled"];

export const DEFAULT_APP_SETTINGS: AppSettings = {
  defaultCli: DEFAULT_CLI,
  defaultModels: {},
  defaultReasoningEfforts: {},
  defaultMcpTools: false,
  hiddenMcpImageServers: [],
  bedrockProfile: DEFAULT_BEDROCK_PROFILE,
  bedrockRegion: DEFAULT_BEDROCK_REGION,
  memoryEnabled: true,
  memoryAutoCapture: true,
  memoryRecallLimit: 5,
  memoryRetrievalMode: "hybrid",
  memoryEmbeddingProvider: "disabled",
  memoryEmbeddingModel: "text-embedding-3-small",
  memoryEmbeddingBaseUrl: "https://api.openai.com/v1",
  memoryEmbeddingApiKey: "",
  memoryEmbeddingDimensions: 1536,
  memoryCuratorEnabled: false,
  memoryCuratorProvider: "disabled",
  memoryCuratorModel: "gpt-4.1-mini",
  memoryCuratorBaseUrl: "https://api.openai.com/v1",
  memoryCuratorApiKey: "",
};

function isEffort(value: unknown): value is ModelReasoningEffort {
  return isModelReasoningEffort(value);
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

function cleanString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function cleanPositiveInteger(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const raw = typeof value === "string" ? value.trim() : value;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  return Number.isInteger(parsed) && parsed >= 16 && parsed <= 12_288 ? parsed : fallback;
}

function nestedRecord(rec: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = rec[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cleanRetrievalMode(value: unknown): MemoryRetrievalMode {
  return typeof value === "string" && VALID_MEMORY_RETRIEVAL_MODES.includes(value as MemoryRetrievalMode)
    ? value as MemoryRetrievalMode
    : DEFAULT_APP_SETTINGS.memoryRetrievalMode;
}

function cleanMemoryProvider(value: unknown): MemoryProvider {
  if (value === "openai") return "openai-compatible";
  if (value === "ollama" || value === "lmstudio") return "local-http";
  return typeof value === "string" && VALID_MEMORY_PROVIDERS.includes(value as MemoryProvider)
    ? value as MemoryProvider
    : "disabled";
}

export function normalizeAppSettings(input: unknown): AppSettings {
  const rec = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const memoryRetrieval = nestedRecord(rec, "memoryRetrieval");
  const memoryEmbedding = nestedRecord(rec, "memoryEmbedding");
  const memoryCurator = nestedRecord(rec, "memoryCurator");
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
  const memoryRecallLimit = typeof rec.memoryRecallLimit === "number"
    && Number.isInteger(rec.memoryRecallLimit)
    && rec.memoryRecallLimit > 0
    ? Math.min(rec.memoryRecallLimit, 100)
    : DEFAULT_APP_SETTINGS.memoryRecallLimit;
  const memoryEmbeddingDimensions = cleanPositiveInteger(
    rec.memoryEmbeddingDimensions ?? memoryEmbedding.dimensions,
    DEFAULT_APP_SETTINGS.memoryEmbeddingDimensions,
  );

  return {
    defaultCli,
    defaultModels: cleanStringMap(rec.defaultModels),
    defaultReasoningEfforts: cleanEffortMap(rec.defaultReasoningEfforts),
    defaultMcpTools: typeof rec.defaultMcpTools === "boolean" ? rec.defaultMcpTools : DEFAULT_APP_SETTINGS.defaultMcpTools,
    hiddenMcpImageServers: cleanStringList(rec.hiddenMcpImageServers),
    bedrockProfile,
    bedrockRegion,
    memoryEnabled: typeof rec.memoryEnabled === "boolean" ? rec.memoryEnabled : DEFAULT_APP_SETTINGS.memoryEnabled,
    memoryAutoCapture: typeof rec.memoryAutoCapture === "boolean" ? rec.memoryAutoCapture : DEFAULT_APP_SETTINGS.memoryAutoCapture,
    memoryRecallLimit,
    memoryRetrievalMode: cleanRetrievalMode(rec.memoryRetrievalMode ?? memoryRetrieval.mode),
    memoryEmbeddingProvider: cleanMemoryProvider(rec.memoryEmbeddingProvider ?? memoryEmbedding.provider),
    memoryEmbeddingModel: cleanString(rec.memoryEmbeddingModel ?? memoryEmbedding.model, DEFAULT_APP_SETTINGS.memoryEmbeddingModel),
    memoryEmbeddingBaseUrl: cleanString(rec.memoryEmbeddingBaseUrl ?? memoryEmbedding.baseUrl, DEFAULT_APP_SETTINGS.memoryEmbeddingBaseUrl).replace(/\/+$/, ""),
    memoryEmbeddingApiKey: cleanString(rec.memoryEmbeddingApiKey ?? memoryEmbedding.apiKey),
    memoryEmbeddingDimensions,
    memoryCuratorEnabled: typeof rec.memoryCuratorEnabled === "boolean"
      ? rec.memoryCuratorEnabled
      : typeof memoryCurator.enabled === "boolean"
        ? memoryCurator.enabled
        : DEFAULT_APP_SETTINGS.memoryCuratorEnabled,
    memoryCuratorProvider: cleanMemoryProvider(rec.memoryCuratorProvider ?? memoryCurator.provider),
    memoryCuratorModel: cleanString(rec.memoryCuratorModel ?? memoryCurator.model, DEFAULT_APP_SETTINGS.memoryCuratorModel),
    memoryCuratorBaseUrl: cleanString(rec.memoryCuratorBaseUrl ?? memoryCurator.baseUrl, DEFAULT_APP_SETTINGS.memoryCuratorBaseUrl).replace(/\/+$/, ""),
    memoryCuratorApiKey: cleanString(rec.memoryCuratorApiKey ?? memoryCurator.apiKey),
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
