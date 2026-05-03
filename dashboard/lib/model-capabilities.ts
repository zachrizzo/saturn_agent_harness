import { execFile } from "child_process";
import { promisify } from "util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CLI } from "./clis";
import { isBedrockCli, isLocalClaudeCli, isPersonalClaudeCli, normalizeCli } from "./clis";
import {
  isModelReasoningEffort,
  normalizeReasoningEffortForCli,
  normalizeSupportedReasoningEfforts,
  type ModelReasoningEffort,
} from "./models";
import { toBedrockId } from "./claude-models";

const execFileAsync = promisify(execFile);
const HELP_CACHE_MS = 5 * 60 * 1000;

let claudeEffortCache: { expiresAt: number; efforts: ModelReasoningEffort[] } | null = null;

function parseEffortsFromHelp(help: string, optionName: string): ModelReasoningEffort[] {
  const optionLine = help
    .split(/\r?\n/)
    .find((line) => line.includes(optionName) && line.includes("(") && line.includes(")"));
  if (!optionLine) return [];
  const parenthetical = optionLine.match(/\(([^)]*)\)/)?.[1] ?? "";
  return normalizeSupportedReasoningEfforts(
    parenthetical
      .split(/[,|/]/)
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

export async function claudeCliReasoningEfforts(): Promise<ModelReasoningEffort[]> {
  const now = Date.now();
  if (claudeEffortCache && claudeEffortCache.expiresAt > now) return claudeEffortCache.efforts;
  try {
    const { stdout, stderr } = await execFileAsync("claude", ["--help"], {
      timeout: 2500,
      maxBuffer: 512 * 1024,
    });
    const efforts = parseEffortsFromHelp(`${stdout}\n${stderr}`, "--effort");
    claudeEffortCache = { expiresAt: now + HELP_CACHE_MS, efforts };
    return efforts;
  } catch {
    claudeEffortCache = { expiresAt: now + 30_000, efforts: [] };
    return [];
  }
}

function claudeModelCanUseEffort(model: string | undefined): boolean {
  if (!model) return true;
  const value = (toBedrockId(model) ?? model).toLowerCase();
  if (["sonnet", "opus", "haiku"].includes(value)) return true;
  if (value.includes("claude-sonnet-4")) return true;
  if (value.includes("claude-opus-4")) return true;
  if (value.includes("claude-haiku-4")) return true;
  if (value.includes("claude-3-7-sonnet") || value.includes("claude-3.7-sonnet")) return true;
  return false;
}

async function codexDefaultModel(): Promise<string | undefined> {
  try {
    const config = await fs.readFile(path.join(os.homedir(), ".codex", "config.toml"), "utf8");
    return config.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1];
  } catch {
    return undefined;
  }
}

async function codexModelReasoningEfforts(model: string | undefined): Promise<ModelReasoningEffort[]> {
  const effectiveModel = model || await codexDefaultModel();
  if (!effectiveModel) return [];
  try {
    const cachePath = path.join(os.homedir(), ".codex", "models_cache.json");
    const parsed = JSON.parse(await fs.readFile(cachePath, "utf8")) as {
      models?: Array<{
        slug?: string;
        supported_reasoning_levels?: unknown;
      }>;
    };
    const found = (parsed.models ?? []).find((entry) => entry.slug === effectiveModel);
    return normalizeSupportedReasoningEfforts(found?.supported_reasoning_levels);
  } catch {
    return [];
  }
}

export async function reasoningEffortsForCliModel(
  cliInput: CLI | string,
  model?: string,
): Promise<ModelReasoningEffort[]> {
  const cli = normalizeCli(cliInput);
  if (cli === "codex") return codexModelReasoningEfforts(model);
  if (isBedrockCli(cli) || isPersonalClaudeCli(cli)) {
    if (!claudeModelCanUseEffort(model)) return [];
    return claudeCliReasoningEfforts();
  }
  if (isLocalClaudeCli(cli)) return claudeCliReasoningEfforts();
  return [];
}

export async function resolveReasoningEffortForCliModel(
  cliInput: CLI | string,
  model: string | undefined,
  effort?: ModelReasoningEffort | null,
): Promise<ModelReasoningEffort | undefined> {
  const cli = normalizeCli(cliInput);
  const normalized = normalizeReasoningEffortForCli(cli, effort);
  if (!normalized) return undefined;
  const supported = await reasoningEffortsForCliModel(cli, model);
  return supported.includes(normalized) ? normalized : undefined;
}

export function isKnownReasoningEffort(value: unknown): value is ModelReasoningEffort {
  return isModelReasoningEffort(value);
}
