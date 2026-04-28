import { encoding_for_model, get_encoding } from "tiktoken";
import { isClaudeCli, normalizeCli } from "./clis";
import type { CLI } from "./clis";

export type TokenCounterCli = CLI | "claude";

export type TokenCountResult = {
  total_tokens: number;
  source: "openai-tiktoken" | "anthropic-count-tokens";
};

export async function countTextTokensForCli(params: {
  cli?: TokenCounterCli;
  model?: string | null;
  text: string;
}): Promise<TokenCountResult | null> {
  const text = params.text.trim();
  if (!text) return null;

  const cli = normalizeCli(params.cli);

  if (cli === "codex") {
    return countOpenAiTextTokens(text, params.model);
  }

  if (isClaudeCli(cli)) {
    return countClaudeTextTokens(text, params.model);
  }

  return null;
}

function countOpenAiTextTokens(text: string, model?: string | null): TokenCountResult {
  const encoding = getOpenAiEncoding(model);
  try {
    return {
      total_tokens: encoding.encode(text).length,
      source: "openai-tiktoken",
    };
  } finally {
    encoding.free();
  }
}

function getOpenAiEncoding(model?: string | null): ReturnType<typeof get_encoding> {
  if (model) {
    try {
      return encoding_for_model(model as Parameters<typeof encoding_for_model>[0]);
    } catch {
      // New Codex models are OpenAI-family models; o200k_base is the closest
      // local tokenizer when tiktoken does not know the exact model id yet.
    }
  }

  return get_encoding("o200k_base");
}

async function countClaudeTextTokens(
  text: string,
  model?: string | null,
): Promise<TokenCountResult | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN;
  if (!apiKey) return null;

  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({
      apiKey,
      baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
    });
    const result = await client.messages.countTokens({
      model: toAnthropicModelId(model),
      messages: [{ role: "user", content: text }],
    });

    return {
      total_tokens: result.input_tokens,
      source: "anthropic-count-tokens",
    };
  } catch {
    return null;
  }
}

function toAnthropicModelId(model?: string | null): string {
  if (!model) return "claude-sonnet-4-5";

  return model
    .replace(/^(global|us)\.anthropic\./, "")
    .replace(/-v\d(?::\d)?$/, "");
}
