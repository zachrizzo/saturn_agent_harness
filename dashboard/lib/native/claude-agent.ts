import { query, type SlashCommand as ClaudeSlashCommand } from "@anthropic-ai/claude-agent-sdk";
import { normalizeCli, type CLI } from "@/lib/clis";
import { claudeProviderOptions } from "@/lib/runnables/claude-adapter";

const DEFAULT_TIMEOUT_MS = 6_000;

async function* emptyPrompt(): AsyncGenerator<never> {}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function listClaudeSlashCommands(args: {
  cli: CLI | string;
  cwd?: string;
  model?: string;
  timeoutMs?: number;
}): Promise<ClaudeSlashCommand[]> {
  const cli = normalizeCli(args.cli);
  const provider = await claudeProviderOptions(cli, args.model);
  const session = query({
    prompt: emptyPrompt(),
    options: {
      maxTurns: 1,
      cwd: args.cwd,
      model: provider.model,
      env: provider.env,
      settings: provider.settings,
      settingSources: provider.settingSources,
      mcpServers: provider.mcpServers,
      permissionMode: "dontAsk",
    },
  });

  try {
    return await withTimeout(
      session.supportedCommands(),
      args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "Claude slash command discovery",
    );
  } finally {
    session.close();
  }
}
