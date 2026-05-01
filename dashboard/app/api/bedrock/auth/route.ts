import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { NextRequest, NextResponse } from "next/server";
import { assertBedrockReady, readBedrockConfig } from "@/lib/bedrock-auth";
import type { BedrockConfig } from "@/lib/bedrock-config";

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

function cleanConfig(raw: { profile?: unknown; region?: unknown } | null | undefined, fallback: BedrockConfig): BedrockConfig {
  const profile = typeof raw?.profile === "string" && raw.profile.trim() ? raw.profile.trim() : fallback.profile;
  const region = typeof raw?.region === "string" && raw.region.trim() ? raw.region.trim() : fallback.region;
  return { profile, region };
}

async function configFromRequest(req: NextRequest): Promise<BedrockConfig> {
  const fallback = await readBedrockConfig();
  const profile = req.nextUrl.searchParams.get("profile");
  const region = req.nextUrl.searchParams.get("region");
  return cleanConfig({ profile, region }, fallback);
}

async function statusFor(config: BedrockConfig) {
  try {
    await assertBedrockReady(config);
    return { ready: true, profile: config.profile, region: config.region };
  } catch (err) {
    return {
      ready: false,
      profile: config.profile,
      region: config.region,
      error: err instanceof Error ? err.message : "failed to check Bedrock auth",
    };
  }
}

function loginCommand(config: BedrockConfig): string {
  return [
    `export PATH=${shellQuote(defaultPath())}:$PATH`,
    `export HOME=${shellQuote(process.env.HOME || os.homedir())}`,
    `export AWS_PROFILE=${shellQuote(config.profile)}`,
    `export AWS_REGION=${shellQuote(config.region)}`,
    `aws sso login --profile ${shellQuote(config.profile)}`,
    "status=$?",
    "printf '\\nAWS SSO login exited with status %s.\\n' \"$status\"",
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

export async function GET(req: NextRequest) {
  const config = await configFromRequest(req);
  return NextResponse.json({ status: await statusFor(config) });
}

export async function POST(req: NextRequest) {
  if (process.platform !== "darwin") {
    return NextResponse.json({ error: "AWS SSO login launch is only implemented for macOS Terminal" }, { status: 501 });
  }

  const fallback = await readBedrockConfig();
  const body = (await req.json().catch(() => null)) as { profile?: unknown; region?: unknown } | null;
  const config = cleanConfig(body, fallback);

  try {
    await openTerminal(loginCommand(config));
    return NextResponse.json({ launched: true, status: await statusFor(config) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed to launch AWS SSO login";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
