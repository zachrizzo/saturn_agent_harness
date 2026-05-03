import { NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Model } from "@/lib/models";
import { isModelReasoningEffort, normalizeSupportedReasoningEfforts } from "@/lib/models";
import { claudeContextWindow, fallbackClaudeModels } from "@/lib/claude-models";
import { normalizeCli } from "@/lib/clis";
import { readBedrockConfig } from "@/lib/bedrock-auth";
import { claudeCliReasoningEfforts, reasoningEffortsForCliModel } from "@/lib/model-capabilities";

export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

function cleanBedrockName(raw: string): string {
  return raw.replace(/^(US\s+|Global\s+|GLOBAL\s+)/i, "").replace(/^Anthropic\s+/i, "").trim();
}

function inferClaudeContextWindow(id: string, name: string): number | undefined {
  // Prefer the shared spec table. Fall back to a conservative 200K window for
  // any Claude/Anthropic model not yet known to CLAUDE_MODELS.
  const spec = claudeContextWindow(id);
  if (spec) return spec;
  const value = `${id} ${name}`.toLowerCase();
  if (!value.includes("claude") && !value.includes("anthropic")) return undefined;
  return 200_000;
}

function claudeReasoningEfforts(id: string, name: string, cliEfforts: NonNullable<Model["supportedReasoningEfforts"]>) {
  const value = `${id} ${name}`.toLowerCase();
  const supportsThinking =
    value.includes("claude-sonnet-4") ||
    value.includes("claude-opus-4") ||
    value.includes("claude-haiku-4") ||
    value.includes("claude-3-7-sonnet") ||
    value.includes("claude-3.7-sonnet");
  return supportsThinking ? cliEfforts : [];
}

async function getClaudeModels(): Promise<Model[]> {
  const { profile: awsProfile, region: awsRegion } = await readBedrockConfig();
  const env = { ...process.env, AWS_PROFILE: awsProfile, AWS_REGION: awsRegion, AWS_PAGER: "" };
  const cliEfforts = await claudeCliReasoningEfforts();

  const [profilesOut, foundationOut] = await Promise.all([
    execFileAsync("aws", ["bedrock", "list-inference-profiles", "--profile", awsProfile, "--region", awsRegion, "--output", "json", "--no-cli-pager"], { env })
      .catch(() => ({ stdout: '{"inferenceProfileSummaries":[]}' })),
    execFileAsync("aws", ["bedrock", "list-foundation-models", "--by-provider", "Anthropic", "--profile", awsProfile, "--region", awsRegion, "--output", "json", "--no-cli-pager"], { env })
      .catch(() => ({ stdout: '{"modelSummaries":[]}' })),
  ]);

  const models: Model[] = [];
  const seen = new Set<string>();

  const add = (id: string, name: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      models.push({
        id,
        name,
        contextWindow: inferClaudeContextWindow(id, name),
        supportedReasoningEfforts: claudeReasoningEfforts(id, name, cliEfforts),
      });
    }
  };

  try {
    for (const p of JSON.parse(profilesOut.stdout).inferenceProfileSummaries ?? []) {
      if (p.inferenceProfileId?.includes("anthropic")) {
        const region = p.inferenceProfileId.startsWith("global.") ? " (global)" : "";
        add(p.inferenceProfileId, cleanBedrockName(p.inferenceProfileName ?? p.inferenceProfileId) + region);
      }
    }
  } catch {}

  try {
    for (const m of JSON.parse(foundationOut.stdout).modelSummaries ?? []) {
      if (m.inferenceTypesSupported?.includes("INFERENCE_PROFILE")) {
        add("us." + m.modelId, cleanBedrockName(m.modelName ?? m.modelId));
        add("global." + m.modelId, cleanBedrockName(m.modelName ?? m.modelId) + " (global)");
      }
      if (m.inferenceTypesSupported?.includes("ON_DEMAND")) {
        add(m.modelId, cleanBedrockName(m.modelName ?? m.modelId));
      }
    }
  } catch {}

  function rank(id: string, name: string): number {
    const lower = `${id} ${name}`.toLowerCase();
    // Sonnet 4.6 first, then other sonnet, then opus, then haiku, then rest
    if (lower.includes("sonnet-4-6") || lower.includes("sonnet-4.6")) return 0;
    if (lower.includes("sonnet")) return 1;
    if (lower.includes("opus")) return 2;
    if (lower.includes("haiku")) return 3;
    return 4;
  }
  models.sort((a, b) => rank(a.id, a.name) - rank(b.id, b.name) || b.name.localeCompare(a.name));

  return models.length > 0
    ? models
    : fallbackClaudeModels().map((m) => ({
        ...m,
        supportedReasoningEfforts: claudeReasoningEfforts(m.id, m.name, cliEfforts),
      }));
}

async function getPersonalClaudeModels(): Promise<Model[]> {
  const [sonnetEfforts, opusEfforts, haikuEfforts] = await Promise.all([
    reasoningEffortsForCliModel("claude-personal", "sonnet"),
    reasoningEffortsForCliModel("claude-personal", "opus"),
    reasoningEffortsForCliModel("claude-personal", "haiku"),
  ]);
  return [
    {
      id: "sonnet",
      name: "Sonnet",
      supportedReasoningEfforts: sonnetEfforts,
    },
    {
      id: "opus",
      name: "Opus",
      supportedReasoningEfforts: opusEfforts,
    },
    {
      id: "haiku",
      name: "Haiku",
      supportedReasoningEfforts: haikuEfforts,
    },
  ];
}

async function getCodexModels(): Promise<Model[]> {
  try {
    const cachePath = path.join(os.homedir(), ".codex", "models_cache.json");
    const raw = await fs.readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw);
    return (parsed.models ?? [])
      .filter((m: any) => m.slug && m.visibility !== "hidden")
      .map((m: any) => ({
        id: m.slug,
        name: m.display_name ?? m.slug,
        contextWindow: typeof m.context_window === "number" ? m.context_window : undefined,
        maxOutputTokens: typeof m.max_output_tokens === "number" ? m.max_output_tokens : undefined,
        defaultReasoningEffort: isModelReasoningEffort(m.default_reasoning_level) ? m.default_reasoning_level : undefined,
        supportedReasoningEfforts: normalizeSupportedReasoningEfforts(m.supported_reasoning_levels),
      }));
  } catch {
    return [{
      id: "gpt-5.5",
      name: "GPT-5.5",
      contextWindow: 272_000,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [],
    }];
  }
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok ? (await res.json() as T) : null;
  } catch { return null; }
}

const LOCAL_DEFAULT: Model = {
  id: "gemma4:26b-it-q4_K_M",
  name: "Gemma 4 26B (4-bit)",
  contextWindow: 128_000,
};

async function getLMStudioModels(): Promise<Model[]> {
  const cliEfforts = await reasoningEffortsForCliModel("claude-local", LOCAL_DEFAULT.id);
  const localDefault = { ...LOCAL_DEFAULT, supportedReasoningEfforts: cliEfforts };
  // Native API has display_name + context window
  type NativeModel = { key: string; display_name?: string; type?: string; max_context_length?: number };
  const native = await fetchJson<{ models?: NativeModel[] }>("http://127.0.0.1:1234/api/v1/models");
  const nativeList = native?.models ?? [];
  if (nativeList.length > 0) {
    const list = nativeList
      .filter((m) => m.type !== "embedding")
      .map((m) => ({
        id: m.key,
        name: m.display_name ?? m.key,
        contextWindow: m.max_context_length,
        supportedReasoningEfforts: cliEfforts,
      }));
    // Ensure default model is always present and first
    return list.find((m) => m.id === LOCAL_DEFAULT.id)
      ? list
      : [localDefault, ...list];
  }

  // Fall back to OpenAI-compatible endpoint
  const compat = await fetchJson<{ data: { id: string }[] }>("http://127.0.0.1:1234/v1/models");
  const compatList = (compat?.data ?? []).filter((m) => !m.id.toLowerCase().includes("embed"));
  if (compatList.length > 0) {
    const list = compatList.map((m) => ({
      id: m.id,
      name: m.id,
      supportedReasoningEfforts: cliEfforts,
    }));
    return list.find((m) => m.id === LOCAL_DEFAULT.id)
      ? list
      : [localDefault, ...list];
  }

  return [localDefault];
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const cli = normalizeCli(searchParams.get("cli"));

  try {
    if (cli === "codex") {
      return NextResponse.json({ models: await getCodexModels() });
    }
    if (cli === "claude-personal") {
      return NextResponse.json({ models: await getPersonalClaudeModels() });
    }
    if (cli === "claude-local" || searchParams.get("cli") === "lmstudio") {
      return NextResponse.json({ models: await getLMStudioModels() });
    }
    return NextResponse.json({ models: await getClaudeModels() });
  } catch {
    return NextResponse.json({ error: "Failed to fetch models" }, { status: 500 });
  }
}
