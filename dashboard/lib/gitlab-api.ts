import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitLabApiErrorData = {
  message?: unknown;
  error?: unknown;
};

export type GitLabToken = {
  value: string;
  source: string;
};

export class GitLabApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function envToken(name: string): GitLabToken | undefined {
  const value = process.env[name]?.trim();
  return value ? { value, source: name } : undefined;
}

function envTokenForHost(instanceUrl: string): GitLabToken | undefined {
  const host = new URL(instanceUrl).hostname.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return envToken(`GITLAB_TOKEN_${host}`)
    ?? envToken("GITLAB_TOKEN")
    ?? envToken("GITLAB_PRIVATE_TOKEN")
    ?? envToken("GITLAB_API_TOKEN")
    ?? envToken("GITLAB_PERSONAL_ACCESS_TOKEN");
}

function stripYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  const commentIndex = trimmed.search(/\s#/);
  return (commentIndex >= 0 ? trimmed.slice(0, commentIndex) : trimmed).trim();
}

function parseGlabToken(text: string, hostname: string): string | undefined {
  const lines = text.split(/\r?\n/);
  let inHosts = false;
  let hostsIndent = -1;
  let currentHost: string | null = null;
  let currentIndent = -1;
  let currentApiHost: string | undefined;
  let currentToken: string | undefined;
  let result: string | undefined;

  const flushCurrentHost = () => {
    if (!result && currentToken && (currentHost === hostname || currentApiHost === hostname)) {
      result = currentToken;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, "  ");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const match = line.match(/^(\s*)([^:#][^:]*):(?:\s*(.*))?$/);
    if (!match) continue;
    const indent = match[1].length;
    const key = stripYamlScalar(match[2]);
    const value = stripYamlScalar(match[3] ?? "");

    if (key === "hosts" && !value) {
      inHosts = true;
      hostsIndent = indent;
      currentHost = null;
      currentIndent = -1;
      currentApiHost = undefined;
      currentToken = undefined;
      continue;
    }

    if (!inHosts) continue;
    if (indent <= hostsIndent) {
      flushCurrentHost();
      inHosts = false;
      currentHost = null;
      continue;
    }

    if (!value && (currentHost === null || indent <= currentIndent)) {
      flushCurrentHost();
      currentHost = key;
      currentIndent = indent;
      currentApiHost = undefined;
      currentToken = undefined;
      continue;
    }

    if (!currentHost || indent <= currentIndent) continue;
    if (key === "api_host") currentApiHost = value;
    if (key === "token") currentToken = value;
  }

  flushCurrentHost();
  return result;
}

async function glabTokenForHost(instanceUrl: string): Promise<GitLabToken | undefined> {
  const hostname = new URL(instanceUrl).hostname;
  const configPaths = [
    process.env.GLAB_CONFIG_DIR ? path.join(process.env.GLAB_CONFIG_DIR, "config.yml") : null,
    path.join(os.homedir(), "Library", "Application Support", "glab-cli", "config.yml"),
    path.join(os.homedir(), ".config", "glab-cli", "config.yml"),
  ].filter((value): value is string => Boolean(value));

  for (const configPath of configPaths) {
    const text = await fs.readFile(configPath, "utf8").catch(() => null);
    if (!text) continue;
    const value = parseGlabToken(text, hostname);
    if (value) return { value, source: `glab:${configPath}` };
  }

  return undefined;
}

function tokenFromGlabAuthStatus(output: string): string | undefined {
  return output.match(/Token found:\s*(\S+)/)?.[1];
}

async function glabCommandTokenForHost(instanceUrl: string): Promise<GitLabToken | undefined> {
  const hostname = new URL(instanceUrl).hostname;
  const candidates = Array.from(new Set([
    "glab",
    "/opt/homebrew/bin/glab",
    "/usr/local/bin/glab",
  ]));

  for (const bin of candidates) {
    try {
      const { stdout, stderr } = await execFileAsync(
        bin,
        ["auth", "status", "--hostname", hostname, "--show-token"],
        { timeout: 2500, maxBuffer: 512 * 1024 },
      );
      const value = tokenFromGlabAuthStatus(`${stdout}\n${stderr}`);
      if (value) return { value, source: `glab:${bin}` };
    } catch (err) {
      const output = typeof err === "object" && err
        ? `${"stdout" in err && typeof err.stdout === "string" ? err.stdout : ""}\n${"stderr" in err && typeof err.stderr === "string" ? err.stderr : ""}`
        : "";
      const value = tokenFromGlabAuthStatus(output);
      if (value) return { value, source: `glab:${bin}` };
    }
  }

  return undefined;
}

export async function tokenForGitLabHost(instanceUrl: string): Promise<GitLabToken | undefined> {
  return envTokenForHost(instanceUrl)
    ?? await glabTokenForHost(instanceUrl)
    ?? await glabCommandTokenForHost(instanceUrl);
}

function apiHeaders(token: string | undefined): HeadersInit {
  return token ? { "PRIVATE-TOKEN": token } : {};
}

export function gitLabApiErrorMessage(data: GitLabApiErrorData | null, fallback: string): string {
  const value = data?.message ?? data?.error;
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {}
  }
  return fallback;
}

export async function fetchGitLabJson<T>(url: string, token: string | undefined): Promise<{ data: T; nextPage?: string }> {
  const res = await fetch(url, {
    headers: apiHeaders(token),
    cache: "no-store",
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) as T & GitLabApiErrorData : null;
  if (!res.ok) {
    throw new GitLabApiError(gitLabApiErrorMessage(data, `GitLab API returned HTTP ${res.status}`), res.status);
  }
  return {
    data: data as T,
    nextPage: res.headers.get("x-next-page") || undefined,
  };
}

export async function fetchGitLabText(url: string, token: string | undefined): Promise<string> {
  const res = await fetch(url, {
    headers: apiHeaders(token),
    cache: "no-store",
  });
  const text = await res.text();
  if (!res.ok) {
    let data: GitLabApiErrorData | null = null;
    try {
      data = text ? JSON.parse(text) as GitLabApiErrorData : null;
    } catch {}
    throw new GitLabApiError(gitLabApiErrorMessage(data, `GitLab API returned HTTP ${res.status}`), res.status);
  }
  return text;
}

export function normalizeGitLabInstanceUrl(raw: string | null | undefined): string {
  const fallback = process.env.GITLAB_URL
    || process.env.GITLAB_INSTANCE_URL
    || process.env.CI_SERVER_URL
    || "https://gitlab.com";
  const input = raw?.trim() || fallback;
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `https://${input}`;
  const parsed = new URL(withProtocol);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("GitLab instance must use http or https.");
  }
  return parsed.origin;
}
