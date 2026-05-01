import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const execFileAsync = promisify(execFile);

function defaultPath(): string {
  const candidates = [
    process.env.PATH ?? "",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  return [...new Set(candidates.flatMap((item) => item.split(":")).filter(Boolean))].join(":");
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function cleanServerName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[a-zA-Z0-9_.-]+$/.test(trimmed) ? trimmed : null;
}

function loginCommand(serverName: string): string {
  const command = ["codex", "mcp", "login", serverName].map(shellQuote).join(" ");
  return [
    `export PATH=${shellQuote(defaultPath())}:$PATH`,
    `export HOME=${shellQuote(process.env.HOME || os.homedir())}`,
    command,
    "status=$?",
    "printf '\\nCodex MCP login exited with status %s.\\n' \"$status\"",
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

export async function POST(req: NextRequest) {
  if (process.platform !== "darwin") {
    return NextResponse.json({ error: "MCP OAuth launch is only implemented for macOS Terminal" }, { status: 501 });
  }

  const body = (await req.json().catch(() => null)) as { server?: unknown } | null;
  const serverName = cleanServerName(body?.server);
  if (!serverName) {
    return NextResponse.json({ error: "server must be a configured MCP server name" }, { status: 400 });
  }

  try {
    await openTerminal(loginCommand(serverName));
    return NextResponse.json({ launched: true, server: serverName });
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to launch MCP login";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
