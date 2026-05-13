import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { NextRequest, NextResponse } from "next/server";
import {
  buildGitLabUnifiedDiff,
  diffStats,
  parseGitLabMergeRequestUrl,
  type GitLabMergeRequestComment,
  type GitLabMergeRequestDiffFile,
  type GitLabMergeRequestReview,
} from "@/lib/gitlab-mr";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PER_PAGE = 100;
const MAX_DIFF_FILES = 500;
const MAX_DIFF_BYTES = 4 * 1024 * 1024;
const MAX_DISCUSSIONS = 300;
const execFileAsync = promisify(execFile);

type GitLabApiErrorData = {
  message?: unknown;
  error?: unknown;
};

type GitLabMergeRequestApi = Record<string, unknown> & {
  title?: string;
  state?: string;
  draft?: boolean;
  work_in_progress?: boolean;
  web_url?: string;
  author?: { name?: string; username?: string };
  source_branch?: string;
  target_branch?: string;
  created_at?: string;
  updated_at?: string;
  description?: string;
  changes_count?: string;
  merge_status?: string;
  detailed_merge_status?: string;
  sha?: string;
};

type GitLabDiffApi = Record<string, unknown> & {
  old_path?: string;
  new_path?: string;
  diff?: string;
  new_file?: boolean;
  renamed_file?: boolean;
  deleted_file?: boolean;
  generated_file?: boolean;
  collapsed?: boolean;
  too_large?: boolean;
};

type GitLabDiscussionNoteApi = Record<string, unknown> & {
  id?: number | string;
  body?: string;
  author?: { name?: string; username?: string };
  created_at?: string;
  resolved?: boolean;
  position?: {
    old_path?: string;
    new_path?: string;
    old_line?: number;
    new_line?: number;
  };
};

type GitLabDiscussionApi = Record<string, unknown> & {
  id?: string;
  notes?: GitLabDiscussionNoteApi[];
};

class GitLabApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

type GitLabToken = {
  value: string;
  source: string;
};

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

async function tokenForHost(instanceUrl: string): Promise<GitLabToken | undefined> {
  return envTokenForHost(instanceUrl)
    ?? await glabTokenForHost(instanceUrl)
    ?? await glabCommandTokenForHost(instanceUrl);
}

function apiHeaders(token: string | undefined): HeadersInit {
  return token ? { "PRIVATE-TOKEN": token } : {};
}

function errorMessage(data: GitLabApiErrorData | null, fallback: string): string {
  const value = data?.message ?? data?.error;
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {}
  }
  return fallback;
}

async function fetchGitLabJson<T>(url: string, token: string | undefined): Promise<{ data: T; nextPage?: string }> {
  const res = await fetch(url, {
    headers: apiHeaders(token),
    cache: "no-store",
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) as T & GitLabApiErrorData : null;
  if (!res.ok) {
    throw new GitLabApiError(errorMessage(data, `GitLab API returned HTTP ${res.status}`), res.status);
  }
  return {
    data: data as T,
    nextPage: res.headers.get("x-next-page") || undefined,
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function boolValue(value: unknown): boolean {
  return value === true;
}

function normalizeDiffFile(raw: GitLabDiffApi): GitLabMergeRequestDiffFile {
  const oldPath = stringValue(raw.old_path);
  const newPath = stringValue(raw.new_path) || oldPath;
  const diff = stringValue(raw.diff);
  const stats = diffStats(diff);
  const normalized = {
    oldPath,
    newPath,
    diff,
    unifiedDiff: "",
    additions: stats.additions,
    deletions: stats.deletions,
    newFile: boolValue(raw.new_file),
    renamedFile: boolValue(raw.renamed_file),
    deletedFile: boolValue(raw.deleted_file),
    generatedFile: boolValue(raw.generated_file),
    collapsed: boolValue(raw.collapsed),
    tooLarge: boolValue(raw.too_large),
  };

  return {
    ...normalized,
    unifiedDiff: buildGitLabUnifiedDiff(normalized),
  };
}

function capDiffPayload(
  files: GitLabMergeRequestDiffFile[],
): { files: GitLabMergeRequestDiffFile[]; truncated: boolean } {
  let bytes = 0;
  const capped: GitLabMergeRequestDiffFile[] = [];

  for (const file of files) {
    const fileBytes = Buffer.byteLength(file.unifiedDiff, "utf8");
    if (bytes + fileBytes <= MAX_DIFF_BYTES) {
      capped.push(file);
      bytes += fileBytes;
      continue;
    }

    const remaining = Math.max(0, MAX_DIFF_BYTES - bytes);
    if (remaining > 400) {
      const truncatedUnified = `${Buffer.from(file.unifiedDiff).subarray(0, remaining).toString("utf8").trimEnd()}\n...[file diff truncated]\n`;
      capped.push({
        ...file,
        diff: "",
        unifiedDiff: truncatedUnified,
      });
    }
    return { files: capped, truncated: true };
  }

  return { files: capped, truncated: false };
}

async function listDiffs(
  apiBaseUrl: string,
  projectPath: string,
  iid: number,
  token: string | undefined,
): Promise<{ files: GitLabMergeRequestDiffFile[]; warnings: string[]; truncated: boolean }> {
  const warnings: string[] = [];
  const files: GitLabMergeRequestDiffFile[] = [];
  let page = 1;

  while (files.length < MAX_DIFF_FILES) {
    const url = new URL(`${apiBaseUrl}/projects/${encodeURIComponent(projectPath)}/merge_requests/${iid}/diffs`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(PER_PAGE));
    const { data, nextPage } = await fetchGitLabJson<GitLabDiffApi[]>(url.toString(), token);
    if (!Array.isArray(data) || data.length === 0) break;

    for (const raw of data) files.push(normalizeDiffFile(raw));
    if (!nextPage) break;
    page = Number(nextPage);
    if (!Number.isFinite(page) || page < 1) break;
  }

  let truncated = files.length >= MAX_DIFF_FILES;
  if (truncated) warnings.push(`Only the first ${MAX_DIFF_FILES.toLocaleString()} diff files were loaded.`);

  const capped = capDiffPayload(files);
  truncated = truncated || capped.truncated;
  if (capped.truncated) warnings.push("The diff payload was truncated before sending it to the browser.");

  return { files: capped.files, warnings, truncated };
}

async function legacyChanges(
  apiBaseUrl: string,
  projectPath: string,
  iid: number,
  token: string | undefined,
): Promise<{ files: GitLabMergeRequestDiffFile[]; warnings: string[]; truncated: boolean }> {
  const url = new URL(`${apiBaseUrl}/projects/${encodeURIComponent(projectPath)}/merge_requests/${iid}/changes`);
  url.searchParams.set("access_raw_diffs", "true");
  url.searchParams.set("unidiff", "true");
  const { data } = await fetchGitLabJson<{ changes?: GitLabDiffApi[]; overflow?: boolean }>(url.toString(), token);
  const files = (data.changes ?? []).slice(0, MAX_DIFF_FILES).map(normalizeDiffFile);
  const capped = capDiffPayload(files);
  const warnings = ["Used GitLab's legacy merge request changes endpoint because the diffs endpoint was unavailable."];
  if (data.overflow) warnings.push("GitLab reported that the merge request diff overflowed server limits.");
  if ((data.changes?.length ?? 0) > MAX_DIFF_FILES) warnings.push(`Only the first ${MAX_DIFF_FILES.toLocaleString()} diff files were loaded.`);
  if (capped.truncated) warnings.push("The diff payload was truncated before sending it to the browser.");
  return {
    files: capped.files,
    warnings,
    truncated: Boolean(data.overflow) || (data.changes?.length ?? 0) > MAX_DIFF_FILES || capped.truncated,
  };
}

function normalizeComment(discussion: GitLabDiscussionApi, note: GitLabDiscussionNoteApi): GitLabMergeRequestComment | null {
  const body = stringValue(note.body).trim();
  if (!body) return null;
  const position = note.position;
  const oldPath = position?.old_path ? stringValue(position.old_path) : undefined;
  const newPath = position?.new_path ? stringValue(position.new_path) : undefined;
  const oldLine = typeof position?.old_line === "number" ? position.old_line : undefined;
  const newLine = typeof position?.new_line === "number" ? position.new_line : undefined;
  return {
    id: String(note.id ?? `${discussion.id ?? "discussion"}:${body.slice(0, 24)}`),
    discussionId: String(discussion.id ?? ""),
    body,
    authorName: note.author?.name,
    authorUsername: note.author?.username,
    createdAt: stringValue(note.created_at) || undefined,
    resolved: typeof note.resolved === "boolean" ? note.resolved : undefined,
    path: newPath || oldPath,
    oldPath,
    newPath,
    oldLine,
    newLine,
  };
}

async function listDiscussions(
  apiBaseUrl: string,
  projectPath: string,
  iid: number,
  token: string | undefined,
): Promise<{ comments: GitLabMergeRequestComment[]; warning?: string }> {
  const comments: GitLabMergeRequestComment[] = [];
  let page = 1;

  while (comments.length < MAX_DISCUSSIONS) {
    const url = new URL(`${apiBaseUrl}/projects/${encodeURIComponent(projectPath)}/merge_requests/${iid}/discussions`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(PER_PAGE));
    const { data, nextPage } = await fetchGitLabJson<GitLabDiscussionApi[]>(url.toString(), token);
    if (!Array.isArray(data) || data.length === 0) break;

    for (const discussion of data) {
      for (const note of discussion.notes ?? []) {
        const comment = normalizeComment(discussion, note);
        if (comment) comments.push(comment);
        if (comments.length >= MAX_DISCUSSIONS) break;
      }
      if (comments.length >= MAX_DISCUSSIONS) break;
    }
    if (!nextPage) break;
    page = Number(nextPage);
    if (!Number.isFinite(page) || page < 1) break;
  }

  return {
    comments,
    warning: comments.length >= MAX_DISCUSSIONS
      ? `Only the first ${MAX_DISCUSSIONS.toLocaleString()} merge request comments were loaded.`
      : undefined,
  };
}

export async function GET(req: NextRequest) {
  const rawUrl = req.nextUrl.searchParams.get("url") ?? "";
  let parsed: ReturnType<typeof parseGitLabMergeRequestUrl>;
  try {
    parsed = parseGitLabMergeRequestUrl(rawUrl);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid GitLab merge request URL" }, { status: 400 });
  }

  const auth = await tokenForHost(parsed.instanceUrl);
  const token = auth?.value;
  const encodedProject = encodeURIComponent(parsed.projectPath);

  try {
    const mrUrl = `${parsed.apiBaseUrl}/projects/${encodedProject}/merge_requests/${parsed.iid}`;
    const { data: mr } = await fetchGitLabJson<GitLabMergeRequestApi>(mrUrl, token);

    let diffResult: { files: GitLabMergeRequestDiffFile[]; warnings: string[]; truncated: boolean };
    try {
      diffResult = await listDiffs(parsed.apiBaseUrl, parsed.projectPath, parsed.iid, token);
    } catch (err) {
      if (!(err instanceof GitLabApiError) || (err.status !== 404 && err.status !== 405)) throw err;
      diffResult = await legacyChanges(parsed.apiBaseUrl, parsed.projectPath, parsed.iid, token);
    }

    const tooLargeCount = diffResult.files.filter((file) => file.tooLarge).length;
    const collapsedCount = diffResult.files.filter((file) => file.collapsed).length;
    const warnings = [...diffResult.warnings];
    if (tooLargeCount > 0) warnings.push(`${tooLargeCount.toLocaleString()} file diff${tooLargeCount === 1 ? " was" : "s were"} marked too large by GitLab.`);
    if (collapsedCount > 0) warnings.push(`${collapsedCount.toLocaleString()} file diff${collapsedCount === 1 ? " was" : "s were"} collapsed by GitLab.`);

    let comments: GitLabMergeRequestComment[] = [];
    try {
      const discussionResult = await listDiscussions(parsed.apiBaseUrl, parsed.projectPath, parsed.iid, token);
      comments = discussionResult.comments;
      if (discussionResult.warning) warnings.push(discussionResult.warning);
    } catch (err) {
      if (err instanceof GitLabApiError && (err.status === 401 || err.status === 403 || err.status === 404)) {
        warnings.push("Could not load merge request comments from GitLab.");
      } else {
        throw err;
      }
    }

    const review: GitLabMergeRequestReview = {
      sourceUrl: parsed.sourceUrl,
      instanceUrl: parsed.instanceUrl,
      projectPath: parsed.projectPath,
      iid: parsed.iid,
      title: stringValue(mr.title) || `Merge request !${parsed.iid}`,
      state: stringValue(mr.state) || "unknown",
      draft: boolValue(mr.draft) || boolValue(mr.work_in_progress),
      webUrl: stringValue(mr.web_url) || parsed.sourceUrl,
      authorName: mr.author?.name || mr.author?.username,
      sourceBranch: stringValue(mr.source_branch),
      targetBranch: stringValue(mr.target_branch),
      createdAt: stringValue(mr.created_at) || undefined,
      updatedAt: stringValue(mr.updated_at) || undefined,
      description: stringValue(mr.description) || undefined,
      changesCount: stringValue(mr.changes_count) || undefined,
      mergeStatus: stringValue(mr.merge_status) || undefined,
      detailedMergeStatus: stringValue(mr.detailed_merge_status) || undefined,
      sha: stringValue(mr.sha) || undefined,
      files: diffResult.files.length,
      additions: diffResult.files.reduce((total, file) => total + file.additions, 0),
      deletions: diffResult.files.reduce((total, file) => total + file.deletions, 0),
      diffs: diffResult.files,
      comments,
      truncated: diffResult.truncated,
      warnings,
      fetchedAt: new Date().toISOString(),
    };

    return NextResponse.json(review);
  } catch (err) {
    const message = err instanceof Error ? err.message : "GitLab merge request fetch failed";
    const status = err instanceof GitLabApiError && err.status === 401 ? 401 : err instanceof GitLabApiError && err.status === 404 ? 404 : 502;
    const hint = status === 401 || status === 404
      ? auth
        ? `The GitLab token from ${auth.source} could not access this project or merge request.`
        : "Private GitLab projects need a token. Run glab auth login, or set GITLAB_TOKEN, GITLAB_PRIVATE_TOKEN, GITLAB_API_TOKEN, GITLAB_PERSONAL_ACCESS_TOKEN, or GITLAB_TOKEN_<HOST> in the dashboard environment."
      : undefined;
    return NextResponse.json({ error: message, hint }, { status });
  }
}
