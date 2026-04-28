// Adapter registry — central lookup for runnable backends.
// The dashboard can opt into the SDK-backed path by setting
// HARNESS_USE_SDK_ADAPTERS=1; otherwise the legacy spawn/stream.jsonl pipeline
// stays in charge.

import type { CLI } from "../clis";
import type { RunnableAdapter } from "./types";
import { claudeAdapter } from "./claude-adapter";
import { codexAdapter } from "./codex-adapter";

const adapters: Record<CLI, RunnableAdapter> = {
  "claude-bedrock": claudeAdapter,
  "claude-personal": claudeAdapter,
  "claude-local": claudeAdapter,
  codex: codexAdapter,
};

export function getAdapter(cli: CLI): RunnableAdapter {
  const a = adapters[cli];
  if (!a) throw new Error(`no adapter for cli: ${cli}`);
  return a;
}

export function adapterPathEnabled(): boolean {
  return process.env.HARNESS_USE_SDK_ADAPTERS === "1";
}
