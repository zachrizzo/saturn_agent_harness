import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readAppSettings } from "./settings";
import {
  DEFAULT_BEDROCK_PROFILE,
  DEFAULT_BEDROCK_REGION,
  type BedrockConfig,
} from "./bedrock-config";

const execFileAsync = promisify(execFile);

export class BedrockNotReadyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BedrockNotReadyError";
  }
}

export function bedrockProfile(): string {
  return process.env.AWS_PROFILE || DEFAULT_BEDROCK_PROFILE;
}

export function bedrockRegion(): string {
  return process.env.AWS_REGION || DEFAULT_BEDROCK_REGION;
}

export async function readBedrockConfig(): Promise<BedrockConfig> {
  try {
    const settings = await readAppSettings();
    return {
      profile: settings.bedrockProfile || bedrockProfile(),
      region: settings.bedrockRegion || bedrockRegion(),
    };
  } catch {
    return {
      profile: bedrockProfile(),
      region: bedrockRegion(),
    };
  }
}

export function bedrockLoginHint(profile = bedrockProfile(), region = bedrockRegion()): string {
  return `Run: AWS_PROFILE=${profile} AWS_REGION=${region} aws sso login --profile ${profile}`;
}

function awsEnv(profile: string, region: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AWS_PROFILE: profile,
    AWS_REGION: region,
    AWS_PAGER: "",
  };
}

function errorText(err: unknown): string {
  const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
  return [e.stderr, e.stdout, e.message].filter(Boolean).join("\n").trim();
}

function friendlyAwsMessage(err: unknown, profile: string, region: string): string {
  const raw = errorText(err);
  const lower = raw.toLowerCase();
  const hint = bedrockLoginHint(profile, region);

  if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
    return `AWS CLI is not installed or is not on the dashboard service PATH. Install awscli, then restart Saturn.`;
  }
  if (lower.includes("could not be found") && lower.includes("profile")) {
    return `AWS profile '${profile}' is not configured. Configure that profile for Bedrock, then ${hint}.`;
  }
  if (
    lower.includes("sso") ||
    lower.includes("token has expired") ||
    lower.includes("session has expired") ||
    lower.includes("unable to locate credentials") ||
    lower.includes("login")
  ) {
    return `Bedrock is not authenticated for AWS profile '${profile}' in ${region}. ${hint}.`;
  }
  if (lower.includes("accessdenied") || lower.includes("not authorized") || lower.includes("unauthorized")) {
    return `AWS profile '${profile}' is authenticated, but does not have Bedrock access in ${region}. Check the profile permissions or model access.`;
  }
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return `Timed out checking Bedrock for AWS profile '${profile}' in ${region}. Check AWS SSO/network access, then try again.`;
  }

  return `Bedrock is not ready for AWS profile '${profile}' in ${region}. ${hint}.`;
}

async function runAws(args: string[], profile: string, region: string): Promise<void> {
  await execFileAsync("aws", [...args, "--profile", profile, "--region", region, "--output", "json", "--no-cli-pager"], {
    env: awsEnv(profile, region),
    timeout: 8_000,
    maxBuffer: 1024 * 1024,
  });
}

export async function assertBedrockReady(config?: BedrockConfig): Promise<void> {
  const { profile, region } = config ?? await readBedrockConfig();

  try {
    await runAws(["sts", "get-caller-identity"], profile, region);
  } catch (err) {
    throw new BedrockNotReadyError(friendlyAwsMessage(err, profile, region));
  }

  try {
    await runAws(["bedrock", "list-inference-profiles"], profile, region);
  } catch (err) {
    throw new BedrockNotReadyError(friendlyAwsMessage(err, profile, region));
  }
}

export function isBedrockNotReadyError(err: unknown): err is BedrockNotReadyError {
  return err instanceof BedrockNotReadyError;
}
