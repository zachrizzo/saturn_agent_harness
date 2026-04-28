import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { NextRequest, NextResponse } from "next/server";
import { automationsRoot } from "@/lib/paths";

export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

const DEFAULT_PATH = [
  "/Users/zachrizzo/.local/bin",
  "/Users/zachrizzo/.nvm/versions/node/v20.19.5/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
].join(":");

const PERSONAL_ENV_KEYS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
] as const;

type ClaudeAuthStatus = {
  loggedIn: boolean;
  authMethod?: string;
  apiProvider?: string;
  error?: string;
};

function projectRoot(): string {
  return path.dirname(automationsRoot());
}

function personalClaudeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: process.env.PATH ? `${DEFAULT_PATH}:${process.env.PATH}` : DEFAULT_PATH,
    HOME: process.env.HOME || "/Users/zachrizzo",
  };

  for (const key of PERSONAL_ENV_KEYS) {
    delete env[key];
  }

  return env;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseAuthStatus(stdout: string): ClaudeAuthStatus {
  const raw = JSON.parse(stdout) as Record<string, unknown>;
  return {
    loggedIn: raw.loggedIn === true,
    authMethod: typeof raw.authMethod === "string" ? raw.authMethod : undefined,
    apiProvider: typeof raw.apiProvider === "string" ? raw.apiProvider : undefined,
  };
}

async function readAuthStatus(): Promise<ClaudeAuthStatus> {
  try {
    const { stdout } = await execFileAsync(
      "claude",
      ["--setting-sources", "project,local", "auth", "status", "--json"],
      {
        cwd: projectRoot(),
        env: personalClaudeEnv(),
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
      },
    );
    return parseAuthStatus(stdout);
  } catch (err) {
    const stdout = typeof (err as { stdout?: unknown }).stdout === "string"
      ? (err as { stdout: string }).stdout
      : "";
    if (stdout.trim()) {
      try {
        return parseAuthStatus(stdout);
      } catch {
        // Fall through to the normalized error below.
      }
    }

    const code = (err as NodeJS.ErrnoException).code;
    const message = code === "ENOENT"
      ? "Claude CLI not found in the dashboard PATH"
      : err instanceof Error
        ? err.message
        : "failed to read Claude auth status";

    return { loggedIn: false, error: message };
  }
}

function loginCommand(mode: "claudeai" | "console", email: string | undefined, sso: boolean): string {
  const authArgs = ["--setting-sources", "project,local", "auth", "login", mode === "console" ? "--console" : "--claudeai"];
  if (email) authArgs.push("--email", email);
  if (sso) authArgs.push("--sso");

  const claudeInvocation = ["claude", ...authArgs.map(shellQuote)].join(" ");
  return [
    `export PATH=${shellQuote(DEFAULT_PATH)}:$PATH`,
    `export HOME=${shellQuote(process.env.HOME || "/Users/zachrizzo")}`,
    `cd ${shellQuote(projectRoot())}`,
    "unset CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX ANTHROPIC_BASE_URL ANTHROPIC_AUTH_TOKEN",
    claudeInvocation,
    "status=$?",
    "printf '\\nClaude auth command exited with status %s.\\n' \"$status\"",
    "printf 'Press Return to close this window. '",
    "read _",
  ].join("; ");
}

async function openTerminal(command: string): Promise<void> {
  const script = `
on run argv
  set shellCommand to item 1 of argv
  tell application "Terminal"
    activate
    do script shellCommand
  end tell
end run
`;

  await execFileAsync("/usr/bin/osascript", ["-e", script, command], {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
}

export async function GET() {
  const status = await readAuthStatus();
  return NextResponse.json({ status });
}

export async function POST(req: NextRequest) {
  if (process.platform !== "darwin") {
    return NextResponse.json({ error: "Claude login launch is only implemented for macOS Terminal" }, { status: 501 });
  }

  const body = (await req.json().catch(() => null)) as {
    mode?: unknown;
    email?: unknown;
    sso?: unknown;
  } | null;

  const mode = body?.mode === "console" ? "console" : "claudeai";
  const email = typeof body?.email === "string" && body.email.trim() ? body.email.trim() : undefined;
  const sso = body?.sso === true;

  try {
    await openTerminal(loginCommand(mode, email, sso));
    return NextResponse.json({ launched: true, status: await readAuthStatus() });
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to launch Claude login";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
