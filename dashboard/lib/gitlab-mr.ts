export type ParsedGitLabMergeRequestUrl = {
  sourceUrl: string;
  instanceUrl: string;
  apiBaseUrl: string;
  projectPath: string;
  iid: number;
};

export type GitLabMergeRequestDiffFile = {
  oldPath: string;
  newPath: string;
  diff: string;
  unifiedDiff: string;
  sourceContent?: string;
  sourceContentTruncated?: boolean;
  additions: number;
  deletions: number;
  newFile: boolean;
  renamedFile: boolean;
  deletedFile: boolean;
  generatedFile: boolean;
  collapsed: boolean;
  tooLarge: boolean;
};

export type GitLabMergeRequestComment = {
  id: string;
  discussionId: string;
  body: string;
  authorName?: string;
  authorUsername?: string;
  createdAt?: string;
  resolved?: boolean;
  path?: string;
  oldPath?: string;
  newPath?: string;
  oldLine?: number;
  newLine?: number;
};

export type GitLabMergeRequestReview = {
  sourceUrl: string;
  instanceUrl: string;
  projectPath: string;
  iid: number;
  title: string;
  state: string;
  draft: boolean;
  webUrl: string;
  authorName?: string;
  sourceBranch: string;
  targetBranch: string;
  createdAt?: string;
  updatedAt?: string;
  description?: string;
  changesCount?: string;
  mergeStatus?: string;
  detailedMergeStatus?: string;
  sha?: string;
  pipelineId?: number;
  pipelineIid?: number;
  pipelineStatus?: string;
  pipelineStatusLabel?: string;
  pipelineStatusGroup?: string;
  pipelineStatusTooltip?: string;
  pipelineWebUrl?: string;
  pipelineRef?: string;
  pipelineSha?: string;
  pipelineCreatedAt?: string;
  pipelineUpdatedAt?: string;
  pipelineStartedAt?: string;
  pipelineFinishedAt?: string;
  files: number;
  additions: number;
  deletions: number;
  diffs: GitLabMergeRequestDiffFile[];
  comments: GitLabMergeRequestComment[];
  truncated: boolean;
  warnings: string[];
  fetchedAt: string;
};

export type GitLabMergeRequestContextOptions = {
  selectedPath?: string;
  maxDiffChars?: number;
};

export const GITLAB_MR_SESSION_TAG = "gitlab-mr";
export const GITLAB_MR_SESSION_TAG_PREFIX = "gitlab-mr:";
const DEFAULT_CONTEXT_DIFF_CHARS = 9_000;

export function parseGitLabMergeRequestUrl(rawUrl: string): ParsedGitLabMergeRequestUrl {
  const trimmed = rawUrl.trim();
  if (!trimmed) throw new Error("Enter a GitLab merge request URL.");

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Enter a full GitLab merge request URL.");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("GitLab merge request URLs must use http or https.");
  }

  const segments = parsed.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
  const dashIndex = segments.indexOf("-");
  const mrIndex = dashIndex >= 0 && segments[dashIndex + 1] === "merge_requests"
    ? dashIndex + 1
    : segments.indexOf("merge_requests");
  const iidRaw = mrIndex >= 0 ? segments[mrIndex + 1] : undefined;

  if (mrIndex < 1 || !iidRaw || !/^\d+$/.test(iidRaw)) {
    throw new Error("Expected a GitLab URL like https://gitlab.com/group/project/-/merge_requests/123.");
  }

  const projectSegments = segments.slice(0, dashIndex >= 0 ? dashIndex : mrIndex);
  if (projectSegments.length === 0) {
    throw new Error("Could not find the project path in that merge request URL.");
  }

  return {
    sourceUrl: parsed.toString(),
    instanceUrl: parsed.origin,
    apiBaseUrl: `${parsed.origin}/api/v4`,
    projectPath: projectSegments.join("/"),
    iid: Number(iidRaw),
  };
}

export function gitLabMergeRequestKey(parsed: ParsedGitLabMergeRequestUrl): string {
  const host = new URL(parsed.instanceUrl).hostname.toLowerCase();
  return `${host}/${parsed.projectPath}!${parsed.iid}`;
}

export function gitLabMergeRequestSessionTag(parsed: ParsedGitLabMergeRequestUrl): string {
  return `${GITLAB_MR_SESSION_TAG_PREFIX}${gitLabMergeRequestKey(parsed)}`;
}

export function gitLabMergeRequestSessionTagFromUrl(rawUrl: string): string | null {
  try {
    return gitLabMergeRequestSessionTag(parseGitLabMergeRequestUrl(rawUrl));
  } catch {
    return null;
  }
}

export function diffStats(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;

  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }

  return { additions, deletions };
}

export function buildGitLabUnifiedDiff(file: {
  oldPath: string;
  newPath: string;
  diff: string;
  newFile?: boolean;
  renamedFile?: boolean;
  deletedFile?: boolean;
}): string {
  const diff = file.diff.trimEnd();
  if (diff.startsWith("diff --git ")) return `${diff}\n`;

  const oldPath = file.oldPath || file.newPath;
  const newPath = file.newPath || file.oldPath;
  const lines = [`diff --git a/${oldPath} b/${newPath}`];

  if (file.renamedFile && oldPath !== newPath) {
    lines.push(`rename from ${oldPath}`);
    lines.push(`rename to ${newPath}`);
  }
  if (file.newFile) lines.push("new file mode 100644");
  if (file.deletedFile) lines.push("deleted file mode 100644");

  lines.push(`--- ${file.newFile ? "/dev/null" : `a/${oldPath}`}`);
  lines.push(`+++ ${file.deletedFile ? "/dev/null" : `b/${newPath}`}`);
  if (diff) lines.push(diff);

  return `${lines.join("\n")}\n`;
}

function changeFlags(file: GitLabMergeRequestDiffFile): string {
  return [
    file.newFile ? "new" : "",
    file.deletedFile ? "deleted" : "",
    file.renamedFile ? "renamed" : "",
    file.generatedFile ? "generated" : "",
    file.collapsed ? "collapsed" : "",
    file.tooLarge ? "too large" : "",
  ].filter(Boolean).join(", ");
}

function truncateText(text: string, maxChars: number, label = "truncated"): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars)).trimEnd()}\n...[${label} after ${maxChars.toLocaleString()} chars]`;
}

export function formatGitLabMrContext(
  review: GitLabMergeRequestReview,
  options: GitLabMergeRequestContextOptions = {},
): string {
  const maxDiffChars = options.maxDiffChars ?? DEFAULT_CONTEXT_DIFF_CHARS;
  const selectedPath = options.selectedPath;
  const selectedFile = selectedPath
    ? review.diffs.find((file) => file.newPath === selectedPath || file.oldPath === selectedPath)
    : undefined;
  const files = selectedFile ? [selectedFile] : review.diffs;
  const fileLines = files.slice(0, 80).map((file) => {
    const flags = changeFlags(file);
    return `- ${file.newPath}${file.renamedFile && file.oldPath !== file.newPath ? ` (from ${file.oldPath})` : ""}: +${file.additions} -${file.deletions}${flags ? ` [${flags}]` : ""}`;
  });
  if (files.length > fileLines.length) {
    fileLines.push(`- ...${files.length - fileLines.length} more files`);
  }

  const diffText = files.map((file) => file.unifiedDiff).join("\n");
  const scopedLabel = selectedFile ? `selected file ${selectedFile.newPath}` : "full MR";
  const description = review.description?.trim()
    ? `\nDescription:\n${truncateText(review.description.trim(), 1_200, "description truncated")}\n`
    : "";

  return [
    "GitLab merge request context",
    "",
    `MR: !${review.iid} ${review.title}`,
    `URL: ${review.webUrl || review.sourceUrl}`,
    `Project: ${review.projectPath}`,
    `State: ${review.state}${review.draft ? " (draft)" : ""}`,
    `Branches: ${review.sourceBranch} -> ${review.targetBranch}`,
    `Author: ${review.authorName || "unknown"}`,
    review.pipelineStatus || review.pipelineStatusLabel
      ? `Pipeline: ${review.pipelineStatusLabel || review.pipelineStatus}${review.pipelineWebUrl ? ` (${review.pipelineWebUrl})` : ""}`
      : "",
    `Diff summary: ${review.files} files, +${review.additions} -${review.deletions}`,
    selectedFile ? `Scope: ${scopedLabel}` : "",
    description,
    "Changed files:",
    fileLines.join("\n") || "- No changed files returned by GitLab.",
    "",
    `Unified diff (${scopedLabel}${review.truncated ? ", response truncated" : ""}):`,
    "````diff",
    truncateText(diffText, maxDiffChars, "diff truncated"),
    "````",
    review.warnings.length ? `\nWarnings:\n${review.warnings.map((warning) => `- ${warning}`).join("\n")}` : "",
  ].filter((part) => part !== "").join("\n");
}
