"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import type { ThemedToken } from "shiki";
import type { BundledLanguage } from "shiki/bundle/web";
import {
  formatGitLabMrContext,
  type GitLabMergeRequestComment,
  type GitLabMergeRequestDiffFile,
  type GitLabMergeRequestReview as GitLabMergeRequestReviewData,
} from "@/lib/gitlab-mr";
import { parseUnifiedDiff, type ParsedDiff, type ParsedDiffRow } from "@/app/components/chat/FileViewer";
import type { ComposerContextAttachment } from "@/app/components/chat/Composer";
import { useTheme, type ResolvedTheme } from "@/app/components/ThemeProvider";

const MARKDOWN_PLUGINS = [remarkGfm];

type ReviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; data: GitLabMergeRequestReviewData };

type Props = {
  cacheKey?: string;
  panelWidth?: number;
  initialUrl?: string;
  onInsertIntoComposer?: (text: string) => void;
  onAttachToComposer?: (attachment: ComposerContextAttachment) => void;
  onPinContext?: (text: string, label: string) => void | Promise<void>;
};

const MR_URL_STORAGE_PREFIX = "saturn.gitlabMergeRequest.url";
const MR_FILES_WIDTH_STORAGE_PREFIX = "saturn.gitlabMergeRequest.filesWidth";
const MR_FILES_HEIGHT_STORAGE_PREFIX = "saturn.gitlabMergeRequest.filesHeight";
const MR_FILE_VIEW_COLLAPSED_STORAGE_PREFIX = "saturn.gitlabMergeRequest.fileViewCollapsed";
const MR_REVIEW_CACHE_DB = "saturn.gitlabMergeRequest.reviewCache";
const MR_REVIEW_CACHE_STORE = "reviews";
const MR_REVIEW_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const FILE_PANEL_MIN_WIDTH = 180;
const FILE_PANEL_MAX_WIDTH = 520;
const FILE_PANEL_MIN_DIFF_WIDTH = 320;
const FILE_PANEL_MIN_HEIGHT = 96;
const FILE_PANEL_MAX_HEIGHT = 360;
const FILE_PANEL_DEFAULT_HEIGHT = 150;

type CachedMergeRequestReview = {
  key: string;
  url: string;
  cachedAt: number;
  data: GitLabMergeRequestReviewData;
};

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function maxFilePanelWidth(panelWidth?: number): number {
  if (!panelWidth) return FILE_PANEL_MAX_WIDTH;
  return clampNumber(panelWidth - FILE_PANEL_MIN_DIFF_WIDTH, FILE_PANEL_MIN_WIDTH, FILE_PANEL_MAX_WIDTH);
}

function defaultFilePanelWidth(panelWidth?: number): number {
  return clampNumber(Math.round((panelWidth ?? 860) * 0.3), 220, maxFilePanelWidth(panelWidth));
}

function storedPanelSize(key: string, fallback: number, min: number, max: number): number {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(key);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) ? clampNumber(parsed, min, max) : fallback;
}

function formatCount(value: number): string {
  return value.toLocaleString();
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function reviewCacheKey(cacheKey: string | undefined, url: string): string {
  return `${cacheKey || "global"}:${url}`;
}

function openReviewCacheDb(): Promise<IDBDatabase | null> {
  if (typeof window === "undefined" || !("indexedDB" in window)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = window.indexedDB.open(MR_REVIEW_CACHE_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MR_REVIEW_CACHE_STORE)) {
        db.createObjectStore(MR_REVIEW_CACHE_STORE, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

async function deleteCachedReview(key: string): Promise<void> {
  const db = await openReviewCacheDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(MR_REVIEW_CACHE_STORE, "readwrite");
    tx.objectStore(MR_REVIEW_CACHE_STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
  db.close();
}

async function readCachedReview(cacheKey: string | undefined, url: string): Promise<GitLabMergeRequestReviewData | null> {
  const key = reviewCacheKey(cacheKey, url);
  const db = await openReviewCacheDb();
  if (!db) return null;
  const entry = await new Promise<CachedMergeRequestReview | undefined>((resolve) => {
    const tx = db.transaction(MR_REVIEW_CACHE_STORE, "readonly");
    const request = tx.objectStore(MR_REVIEW_CACHE_STORE).get(key) as IDBRequest<CachedMergeRequestReview | undefined>;
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
    tx.onerror = () => resolve(undefined);
    tx.onabort = () => resolve(undefined);
  });
  db.close();
  if (!entry || entry.url !== url || !entry.data || !Array.isArray(entry.data.diffs)) return null;
  if (Date.now() - entry.cachedAt > MR_REVIEW_CACHE_TTL_MS) {
    void deleteCachedReview(key);
    return null;
  }
  return entry.data;
}

async function writeCachedReview(cacheKey: string | undefined, url: string, data: GitLabMergeRequestReviewData): Promise<void> {
  const key = reviewCacheKey(cacheKey, url);
  const db = await openReviewCacheDb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(MR_REVIEW_CACHE_STORE, "readwrite");
    tx.objectStore(MR_REVIEW_CACHE_STORE).put({ key, url, cachedAt: Date.now(), data } satisfies CachedMergeRequestReview);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
  db.close();
}

function fileFlags(file: GitLabMergeRequestDiffFile): string[] {
  return [
    file.newFile ? "new" : "",
    file.deletedFile ? "deleted" : "",
    file.renamedFile ? "renamed" : "",
    file.generatedFile ? "generated" : "",
    file.tooLarge ? "too large" : "",
    file.collapsed ? "collapsed" : "",
  ].filter(Boolean);
}

function shortDate(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function fullDate(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function shortSha(value?: string): string {
  return value ? value.slice(0, 12) : "";
}

function statusClass(value?: string): string {
  return (value || "unknown").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

function pipelineLabel(review: GitLabMergeRequestReviewData): string {
  return review.pipelineStatusLabel || review.pipelineStatus || "No pipeline visible";
}

function selectedFileForPath(
  review: GitLabMergeRequestReviewData,
  selectedPath: string | null,
): GitLabMergeRequestDiffFile | null {
  if (!selectedPath) return null;
  return review.diffs.find((file) => file.newPath === selectedPath || file.oldPath === selectedPath) ?? null;
}

type DiffRowWithContext = {
  row: ParsedDiffRow;
  index: number;
  filePath?: string;
};

type ContextControlRow = {
  kind: "context-control";
  key: string;
  filePath: string;
  startLine: number;
  endLine: number;
  expanded: boolean;
};

type ExpandedContextLine = {
  kind: "context-line";
  key: string;
  filePath: string;
  lineNumber: number;
  text: string;
};

type RenderableDiffRow =
  | { kind: "diff"; item: DiffRowWithContext }
  | ContextControlRow
  | ExpandedContextLine;

type RowSelectionMode = "add" | "remove";
type FilePanelResizeState = {
  mode: "width" | "height";
  startClientX: number;
  startClientY: number;
  startWidth: number;
  startHeight: number;
  maxWidth: number;
};

function rowsWithFileContext(parsed: ParsedDiff): DiffRowWithContext[] {
  let filePath: string | undefined;
  return parsed.rows.map((row, index) => {
    if (row.kind === "file") filePath = row.text;
    return { row, index, filePath };
  });
}

function sourceLines(content: string | undefined): string[] {
  if (content === undefined) return [];
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function hunkNewStart(text: string): number | undefined {
  const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
  if (!match) return undefined;
  return Number(match[1]);
}

function contextKey(filePath: string, startLine: number, endLine: number): string {
  return `${filePath}:${startLine}-${endLine}`;
}

function contextControl(
  filePath: string,
  startLine: number,
  endLine: number,
  expandedContext: Set<string>,
): ContextControlRow | null {
  if (startLine > endLine) return null;
  const key = contextKey(filePath, startLine, endLine);
  return {
    kind: "context-control",
    key,
    filePath,
    startLine,
    endLine,
    expanded: expandedContext.has(key),
  };
}

function expandedContextRows(control: ContextControlRow, lines: string[]): ExpandedContextLine[] {
  if (!control.expanded) return [];
  return lines.slice(control.startLine - 1, control.endLine).map((text, offset) => {
    const lineNumber = control.startLine + offset;
    return {
      kind: "context-line",
      key: `${control.key}:${lineNumber}`,
      filePath: control.filePath,
      lineNumber,
      text,
    };
  });
}

function renderableRows(
  rows: DiffRowWithContext[],
  sourceByPath: Map<string, string>,
  expandedContext: Set<string>,
): RenderableDiffRow[] {
  const result: RenderableDiffRow[] = [];
  const lastNewLineByFile = new Map<string, number>();
  const lastFilePathByFile = new Set<string>();
  let currentFilePath: string | undefined;

  const pushControl = (filePath: string | undefined, startLine: number, endLine: number) => {
    if (!filePath) return;
    const lines = sourceLines(sourceByPath.get(filePath));
    if (lines.length === 0) return;
    const boundedEnd = Math.min(endLine, lines.length);
    const control = contextControl(filePath, startLine, boundedEnd, expandedContext);
    if (!control) return;
    result.push(control);
    result.push(...expandedContextRows(control, lines));
  };

  const finishFile = (filePath: string | undefined) => {
    if (!filePath || lastFilePathByFile.has(filePath)) return;
    const lines = sourceLines(sourceByPath.get(filePath));
    const lastShownLine = lastNewLineByFile.get(filePath) ?? 0;
    if (lines.length > lastShownLine) pushControl(filePath, lastShownLine + 1, lines.length);
    lastFilePathByFile.add(filePath);
  };

  for (const item of rows) {
    if (item.row.kind === "file") {
      finishFile(currentFilePath);
      currentFilePath = item.filePath;
    }

    if (item.row.kind === "hunk" && item.filePath) {
      const newStart = hunkNewStart(item.row.text);
      if (newStart !== undefined) {
        const lastShownLine = lastNewLineByFile.get(item.filePath) ?? 0;
        pushControl(item.filePath, lastShownLine + 1, newStart - 1);
      }
    }

    result.push({ kind: "diff", item });

    if (item.row.kind === "line" && item.filePath && item.row.newLine != null) {
      lastNewLineByFile.set(item.filePath, Math.max(lastNewLineByFile.get(item.filePath) ?? 0, item.row.newLine));
    }
  }

  finishFile(currentFilePath);
  return result;
}

function lineNumberLabel(row: Extract<ParsedDiffRow, { kind: "line" }>): string {
  if (row.newLine != null) return `+${row.newLine}`;
  if (row.oldLine != null) return `-${row.oldLine}`;
  return "";
}

function rowSearchText(item: DiffRowWithContext): string {
  const row = item.row;
  if (row.kind === "line") return `${item.filePath ?? ""} ${lineNumberLabel(row)} ${row.text}`;
  return `${item.filePath ?? ""} ${row.text}`;
}

function commentKeys(comment: GitLabMergeRequestComment): string[] {
  const paths = [comment.path, comment.newPath, comment.oldPath].filter((value): value is string => Boolean(value));
  const keys: string[] = [];
  for (const path of paths) {
    if (comment.newLine != null) keys.push(`${path}:new:${comment.newLine}`);
    if (comment.oldLine != null) keys.push(`${path}:old:${comment.oldLine}`);
  }
  return Array.from(new Set(keys));
}

function commentMap(comments: GitLabMergeRequestComment[]): Map<string, GitLabMergeRequestComment[]> {
  const map = new Map<string, GitLabMergeRequestComment[]>();
  for (const comment of comments) {
    for (const key of commentKeys(comment)) {
      const rows = map.get(key) ?? [];
      rows.push(comment);
      map.set(key, rows);
    }
  }
  return map;
}

function commentsForRow(
  commentsByLine: Map<string, GitLabMergeRequestComment[]>,
  filePath: string | undefined,
  row: Extract<ParsedDiffRow, { kind: "line" }>,
): GitLabMergeRequestComment[] {
  if (!filePath) return [];
  const comments: GitLabMergeRequestComment[] = [];
  if (row.newLine != null) comments.push(...(commentsByLine.get(`${filePath}:new:${row.newLine}`) ?? []));
  if (row.oldLine != null) comments.push(...(commentsByLine.get(`${filePath}:old:${row.oldLine}`) ?? []));
  return Array.from(new Map(comments.map((comment) => [comment.id, comment])).values());
}

const SHIKI_THEMES: Record<ResolvedTheme, "github-light-default" | "github-dark-default"> = {
  light: "github-light-default",
  dark: "github-dark-default",
};
const SHIKI_FONT_STYLE_ITALIC = 1;
const SHIKI_FONT_STYLE_BOLD = 2;
const SHIKI_FONT_STYLE_UNDERLINE = 4;

type HighlightToken = {
  content: string;
  style?: CSSProperties;
};

function languageForPath(pathValue?: string): BundledLanguage | null {
  const lower = (pathValue ?? "").toLowerCase();
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".tsx")) return "tsx";
  if (lower.endsWith(".ts")) return "typescript";
  if (lower.endsWith(".jsx")) return "jsx";
  if (/\.(js|mjs|cjs)$/.test(lower)) return "javascript";
  if (lower.endsWith(".jsonc")) return "jsonc";
  if (lower.endsWith(".jsonl")) return "jsonl";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".mdx")) return "mdx";
  if (/\.(md|markdown)$/.test(lower)) return "markdown";
  if (/\.(yaml|yml)$/.test(lower)) return "yaml";
  if (/\.(sh|bash|zsh|fish)$/.test(lower)) return "shellscript";
  if (lower.endsWith(".java")) return "java";
  if (lower.endsWith(".php")) return "php";
  if (lower.endsWith(".c")) return "c";
  if (/\.(cc|cpp|cxx|hpp|hxx)$/.test(lower)) return "cpp";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".scss")) return "scss";
  if (lower.endsWith(".sass")) return "sass";
  if (lower.endsWith(".less")) return "less";
  if (lower.endsWith(".vue")) return "vue";
  if (lower.endsWith(".svelte")) return "svelte";
  if (/\.(html|htm)$/.test(lower)) return "html";
  if (/\.(xml|svg)$/.test(lower)) return "xml";
  if (lower.endsWith(".sql")) return "sql";
  if (/\.(graphql|gql)$/.test(lower)) return "graphql";
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".r")) return "r";
  return null;
}

function tokenStyle(token: ThemedToken): CSSProperties | undefined {
  const style: CSSProperties = token.htmlStyle ? { ...token.htmlStyle } : {};
  if (token.color && !style.color) style.color = token.color;
  const fontStyle = token.fontStyle ?? 0;
  if (fontStyle & SHIKI_FONT_STYLE_ITALIC) style.fontStyle = "italic";
  if (fontStyle & SHIKI_FONT_STYLE_BOLD) style.fontWeight = 700;
  if (fontStyle & SHIKI_FONT_STYLE_UNDERLINE) style.textDecoration = "underline";
  return Object.keys(style).length > 0 ? style : undefined;
}

function renderHighlightedCode(text: string, tokens?: HighlightToken[]): ReactNode {
  if (!tokens) return text;
  return tokens.map((token, index) => (
    <span key={`${index}-${token.content}`} style={token.style}>
      {token.content}
    </span>
  ));
}

function plainHighlightedRows(rows: DiffRowWithContext[]): Map<number, HighlightToken[]> {
  const highlighted = new Map<number, HighlightToken[]>();
  for (const { row, index } of rows) {
    if (row.kind === "line") {
      highlighted.set(index, [{ content: row.text }]);
    }
  }
  return highlighted;
}

async function highlightDiffRows(rows: DiffRowWithContext[], theme: ResolvedTheme): Promise<Map<number, HighlightToken[]>> {
  const groups = new Map<string, { language: BundledLanguage; rows: Array<{ index: number; text: string }> }>();
  for (const { row, index, filePath } of rows) {
    if (row.kind !== "line") continue;
    const language = languageForPath(filePath);
    if (!language) continue;
    const key = `${filePath ?? "unknown"}:${language}`;
    const group = groups.get(key) ?? { language, rows: [] };
    group.rows.push({ index, text: row.text });
    groups.set(key, group);
  }

  if (groups.size === 0) return plainHighlightedRows(rows);

  const highlighted = plainHighlightedRows(rows);
  const { codeToTokens } = await import("shiki/bundle/web");
  await Promise.all(Array.from(groups.values()).map(async (group) => {
    const result = await codeToTokens(group.rows.map((item) => item.text).join("\n"), {
      lang: group.language,
      theme: SHIKI_THEMES[theme],
    });
    group.rows.forEach((item, lineIndex) => {
      const tokens = result.tokens[lineIndex] ?? [];
      highlighted.set(item.index, tokens.map((token) => ({
        content: token.content,
        style: tokenStyle(token),
      })));
    });
  }));
  return highlighted;
}

function formatCommentDate(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function gitLabCommentHref(href: string | undefined, instanceUrl: string): string | undefined {
  if (!href) return href;
  if (href.startsWith("#")) return href;
  try {
    return new URL(href, instanceUrl).toString();
  } catch {
    return href;
  }
}

function GitLabMarkdown({
  body,
  instanceUrl,
  className,
}: {
  body: string;
  instanceUrl: string;
  className: string;
}) {
  const components = useMemo<Components>(() => ({
    a: ({ href, children, ...props }) => (
      <a href={gitLabCommentHref(href, instanceUrl)} target="_blank" rel="noreferrer" {...props}>
        {children}
      </a>
    ),
    table: ({ children, ...props }) => (
      <div className="markdown-table-scroll" tabIndex={0}>
        <table {...props}>{children}</table>
      </div>
    ),
  }), [instanceUrl]);

  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS} components={components}>
        {body}
      </ReactMarkdown>
    </div>
  );
}

function MarkdownComment({ body, instanceUrl }: { body: string; instanceUrl: string }) {
  return <GitLabMarkdown body={body} instanceUrl={instanceUrl} className="insp-mr-comment-body prose-dashboard" />;
}

function detailRows(
  review: GitLabMergeRequestReviewData,
  unresolvedComments: number,
  resolvedComments: number,
): Array<{ label: string; value: string; title?: string }> {
  return [
    { label: "Project", value: review.projectPath },
    { label: "Author", value: review.authorName || "Unknown" },
    { label: "State", value: `${review.state}${review.draft ? " draft" : ""}` },
    { label: "Source", value: review.sourceBranch || "Unknown" },
    { label: "Target", value: review.targetBranch || "Unknown" },
    { label: "Created", value: fullDate(review.createdAt) || "Unknown" },
    { label: "Updated", value: fullDate(review.updatedAt) || "Unknown" },
    { label: "Merge status", value: review.detailedMergeStatus || review.mergeStatus || "Unknown" },
    { label: "Commit", value: shortSha(review.sha) || "Unknown", title: review.sha },
    { label: "Pipeline", value: pipelineLabel(review), title: review.pipelineStatusTooltip || review.pipelineWebUrl },
    { label: "Pipeline ref", value: review.pipelineRef || "Unknown" },
    { label: "Pipeline SHA", value: shortSha(review.pipelineSha) || "Unknown", title: review.pipelineSha },
    { label: "Pipeline updated", value: fullDate(review.pipelineUpdatedAt) || "Unknown" },
    { label: "Changes", value: `${formatCount(review.files)} files, +${formatCount(review.additions)} -${formatCount(review.deletions)}` },
    { label: "Comments", value: `${formatCount(review.comments.length)} total, ${formatCount(unresolvedComments)} unresolved, ${formatCount(resolvedComments)} resolved` },
    { label: "Fetched", value: fullDate(review.fetchedAt) || "Unknown" },
  ];
}

function MergeRequestDiff({
  parsed,
  searchQuery,
  activeSearchRowIndex,
  comments,
  instanceUrl,
  sourceByPath,
  selectedRows,
  expandedContext,
  onToggleRow,
  onStartRowSelection,
  onEnterRowSelection,
  onToggleContext,
}: {
  parsed: ParsedDiff;
  searchQuery: string;
  activeSearchRowIndex: number | null;
  comments: GitLabMergeRequestComment[];
  instanceUrl: string;
  sourceByPath: Map<string, string>;
  selectedRows: Set<number>;
  expandedContext: Set<string>;
  onToggleRow: (index: number, event: ReactMouseEvent<HTMLButtonElement>) => void;
  onStartRowSelection: (index: number, event: ReactPointerEvent<HTMLButtonElement>) => void;
  onEnterRowSelection: (index: number, event: ReactPointerEvent<HTMLButtonElement>) => void;
  onToggleContext: (key: string) => void;
}) {
  const { resolved: theme } = useTheme();
  const rows = useMemo(() => rowsWithFileContext(parsed), [parsed]);
  const renderedRows = useMemo(
    () => renderableRows(rows, sourceByPath, expandedContext),
    [expandedContext, rows, sourceByPath],
  );
  const commentsByLine = useMemo(() => commentMap(comments), [comments]);
  const [highlightedRows, setHighlightedRows] = useState(() => plainHighlightedRows(rows));
  const diffRootRef = useRef<HTMLDivElement | null>(null);
  const normalizedSearch = searchQuery.trim().toLowerCase();

  useEffect(() => {
    let cancelled = false;
    setHighlightedRows(plainHighlightedRows(rows));
    highlightDiffRows(rows, theme)
      .then((next) => {
        if (!cancelled) setHighlightedRows(next);
      })
      .catch(() => {
        if (!cancelled) setHighlightedRows(plainHighlightedRows(rows));
      });
    return () => {
      cancelled = true;
    };
  }, [rows, theme]);

  useEffect(() => {
    if (activeSearchRowIndex === null) return;
    const active = diffRootRef.current?.querySelector<HTMLElement>("[data-active-search-match='true']");
    active?.scrollIntoView({ block: "center", inline: "nearest" });
  }, [activeSearchRowIndex, normalizedSearch]);

  if (parsed.rows.length === 0) {
    return <div className="insp-mr-empty">No textual diff is available for this file.</div>;
  }

  return (
    <div ref={diffRootRef} className="file-viewer-diff" role="region" aria-label="File diff">
      <div className="file-viewer-diff-table">
        {renderedRows.map((rendered) => {
          if (rendered.kind === "context-control") {
            const count = rendered.endLine - rendered.startLine + 1;
            return (
              <button
                key={rendered.key}
                type="button"
                className="insp-mr-context-expand"
                onClick={() => onToggleContext(rendered.key)}
                aria-expanded={rendered.expanded}
              >
                <span className="insp-mr-context-arrow">{rendered.expanded ? "⌃" : "⌄"}</span>
                <span>
                  {rendered.expanded ? "Hide" : "Show"} {count.toLocaleString()} context line{count === 1 ? "" : "s"}
                </span>
                <span className="insp-mr-context-range">
                  {rendered.filePath}:{rendered.startLine}-{rendered.endLine}
                </span>
              </button>
            );
          }

          if (rendered.kind === "context-line") {
            const searchHit = normalizedSearch.length > 0
              && `${rendered.filePath} +${rendered.lineNumber} ${rendered.text}`.toLowerCase().includes(normalizedSearch);
            return (
              <div key={rendered.key} className={`file-viewer-diff-row ctx expanded-context ${searchHit ? "search-hit" : ""}`}>
                <span className="file-viewer-diff-gutter old" />
                <span className="file-viewer-diff-gutter new">{rendered.lineNumber}</span>
                <span className="file-viewer-diff-sign" />
                <span className="file-viewer-diff-code">{rendered.text}</span>
              </div>
            );
          }

          const { row, index, filePath } = rendered.item;
          const searchHit = normalizedSearch.length > 0 && rowSearchText({ row, index, filePath }).toLowerCase().includes(normalizedSearch);
          const activeSearchHit = searchHit && activeSearchRowIndex === index;
          if (row.kind === "section") {
            return (
              <div
                key={index}
                className={`file-viewer-diff-section ${searchHit ? "search-hit" : ""} ${activeSearchHit ? "active-search-hit" : ""}`}
                data-active-search-match={activeSearchHit ? "true" : undefined}
              >
                {row.text}
              </div>
            );
          }

          if (row.kind === "file") {
            return (
              <div
                key={index}
                className={`file-viewer-diff-file ${searchHit ? "search-hit" : ""} ${activeSearchHit ? "active-search-hit" : ""}`}
                data-active-search-match={activeSearchHit ? "true" : undefined}
              >
                {row.text}
              </div>
            );
          }

          if (row.kind === "line") {
            const rowComments = commentsForRow(commentsByLine, filePath, row);
            const selected = selectedRows.has(index);
            return (
              <div key={index} className="insp-mr-diff-line-wrap">
                <button
                  type="button"
                  className={`file-viewer-diff-row ${row.lineKind} selectable ${selected ? "selected" : ""} ${searchHit ? "search-hit" : ""} ${activeSearchHit ? "active-search-hit" : ""}`}
                  data-active-search-match={activeSearchHit ? "true" : undefined}
                  onPointerDown={(event) => onStartRowSelection(index, event)}
                  onPointerEnter={(event) => onEnterRowSelection(index, event)}
                  onClick={(event) => onToggleRow(index, event)}
                  aria-label="Select this diff line for chat context"
                >
                  <span className="file-viewer-diff-gutter old">{row.oldLine ?? ""}</span>
                  <span className="file-viewer-diff-gutter new">{row.newLine ?? ""}</span>
                  <span className="file-viewer-diff-sign">{row.lineKind === "add" ? "+" : row.lineKind === "del" ? "-" : ""}</span>
                  <span className="file-viewer-diff-code">{renderHighlightedCode(row.text, highlightedRows.get(index))}</span>
                </button>
                {rowComments.length > 0 && (
                  <details className="insp-mr-comments">
                    <summary className="insp-mr-comments-summary">
                      <span>
                        {rowComments.length} comment{rowComments.length === 1 ? "" : "s"}
                      </span>
                      {rowComments.some((comment) => comment.resolved) && (
                        <span>{rowComments.filter((comment) => comment.resolved).length} resolved</span>
                      )}
                    </summary>
                    <div className="insp-mr-comments-body">
                      {rowComments.map((comment) => (
                        <div key={comment.id} className={`insp-mr-comment ${comment.resolved ? "resolved" : ""}`}>
                          <div className="insp-mr-comment-head">
                            <strong>{comment.authorName || comment.authorUsername || "GitLab comment"}</strong>
                            {formatCommentDate(comment.createdAt) && <span>{formatCommentDate(comment.createdAt)}</span>}
                            {comment.resolved && <span>resolved</span>}
                          </div>
                          <MarkdownComment body={comment.body} instanceUrl={instanceUrl} />
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            );
          }

          return (
            <div
              key={index}
              className={`file-viewer-diff-row ${row.kind} ${searchHit ? "search-hit" : ""} ${activeSearchHit ? "active-search-hit" : ""}`}
              data-active-search-match={activeSearchHit ? "true" : undefined}
            >
              <span className="file-viewer-diff-gutter old" />
              <span className="file-viewer-diff-gutter new" />
              <span className="file-viewer-diff-sign" />
              <span className="file-viewer-diff-code">{row.text}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function GitLabMergeRequestReview({ cacheKey, panelWidth, initialUrl, onInsertIntoComposer, onAttachToComposer, onPinContext }: Props) {
  const filePanelWidthStorageKey = cacheKey ? `${MR_FILES_WIDTH_STORAGE_PREFIX}:${cacheKey}` : MR_FILES_WIDTH_STORAGE_PREFIX;
  const filePanelHeightStorageKey = cacheKey ? `${MR_FILES_HEIGHT_STORAGE_PREFIX}:${cacheKey}` : MR_FILES_HEIGHT_STORAGE_PREFIX;
  const fileViewCollapsedStorageKey = cacheKey
    ? `${MR_FILE_VIEW_COLLAPSED_STORAGE_PREFIX}:${cacheKey}`
    : MR_FILE_VIEW_COLLAPSED_STORAGE_PREFIX;
  const [draftUrl, setDraftUrl] = useState("");
  const [state, setState] = useState<ReviewState>({ status: "idle" });
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [pinning, setPinning] = useState(false);
  const [pinStatus, setPinStatus] = useState<string | null>(null);
  const [urlEditorOpen, setUrlEditorOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeSearchMatchIndex, setActiveSearchMatchIndex] = useState(0);
  const [filesCollapsed, setFilesCollapsed] = useState(false);
  const [filesTouched, setFilesTouched] = useState(false);
  const [fileViewCollapsed, setFileViewCollapsed] = useState(false);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [expandedContext, setExpandedContext] = useState<Set<string>>(new Set());
  const [filePanelWidth, setFilePanelWidth] = useState(() => defaultFilePanelWidth(panelWidth));
  const [filePanelHeight, setFilePanelHeight] = useState(FILE_PANEL_DEFAULT_HEIGHT);
  const lastSelectedRowRef = useRef<number | null>(null);
  const rowSelectionDragRef = useRef<{ anchor: number; mode: RowSelectionMode } | null>(null);
  const filePanelResizeRef = useRef<FilePanelResizeState | null>(null);
  const filePanelWidthRef = useRef(filePanelWidth);
  const filePanelHeightRef = useRef(filePanelHeight);
  const suppressNextRowClickRef = useRef(false);
  const restoredStorageKeyRef = useRef<string | null>(null);
  const loadedInitialUrlRef = useRef<string | null>(null);
  const loadRequestIdRef = useRef(0);

  const review = state.status === "ok" ? state.data : null;
  const unresolvedComments = review?.comments.filter((comment) => comment.resolved !== true).length ?? 0;
  const resolvedComments = review?.comments.filter((comment) => comment.resolved === true).length ?? 0;
  const mrDetailRows = review ? detailRows(review, unresolvedComments, resolvedComments) : [];
  const storageKey = useMemo(
    () => cacheKey ? `${MR_URL_STORAGE_PREFIX}:${cacheKey}` : MR_URL_STORAGE_PREFIX,
    [cacheKey],
  );
  const selectedFile = review ? selectedFileForPath(review, selectedPath) : null;
  const displayDiff = useMemo(() => {
    if (!review) return "";
    if (selectedFile) return selectedFile.unifiedDiff;
    return review.diffs.map((file) => file.unifiedDiff).join("\n");
  }, [review, selectedFile]);
  const parsedDiff = useMemo(() => parseUnifiedDiff(displayDiff), [displayDiff]);
  const scopedAdditions = selectedFile?.additions ?? review?.additions ?? 0;
  const scopedDeletions = selectedFile?.deletions ?? review?.deletions ?? 0;
  const scopedFiles = selectedFile ? 1 : review?.files ?? 0;
  const fileViewLabel = selectedFile?.newPath ?? "All changed files";
  const wideLayout = (panelWidth ?? 0) >= 760;
  const reviewStyle = {
    "--mr-files-width": `${filePanelWidth}px`,
    "--mr-files-height": `${filePanelHeight}px`,
  } as CSSProperties;
  const diffRows = useMemo(() => rowsWithFileContext(parsedDiff), [parsedDiff]);
  const lineRowIndexes = useMemo(
    () => diffRows.filter((item) => item.row.kind === "line").map((item) => item.index),
    [diffRows],
  );
  const searchText = searchQuery.trim().toLowerCase();
  const searchMatchRowIndexes = useMemo(
    () => searchText
      ? diffRows.filter((item) => rowSearchText(item).toLowerCase().includes(searchText)).map((item) => item.index)
      : [],
    [diffRows, searchText],
  );
  const searchMatches = searchMatchRowIndexes.length;
  const activeSearchRowIndex = searchMatches > 0
    ? searchMatchRowIndexes[Math.min(activeSearchMatchIndex, searchMatches - 1)] ?? null
    : null;
  const filteredFiles = useMemo(() => {
    if (!review || !searchText) return review?.diffs ?? [];
    return review.diffs.filter((file) => (
      file.newPath.toLowerCase().includes(searchText) ||
      file.oldPath.toLowerCase().includes(searchText) ||
      file.diff.toLowerCase().includes(searchText)
    ));
  }, [review, searchText]);
  const sourceByPath = useMemo(() => {
    const map = new Map<string, string>();
    for (const file of review?.diffs ?? []) {
      if (!file.sourceContent) continue;
      map.set(file.newPath, file.sourceContent);
      if (file.oldPath && file.oldPath !== file.newPath) map.set(file.oldPath, file.sourceContent);
    }
    return map;
  }, [review]);

  useEffect(() => {
    filePanelWidthRef.current = filePanelWidth;
  }, [filePanelWidth]);

  useEffect(() => {
    filePanelHeightRef.current = filePanelHeight;
  }, [filePanelHeight]);

  useEffect(() => {
    const maxWidth = maxFilePanelWidth(panelWidth);
    setFilePanelWidth((current) => {
      const next = clampNumber(current, FILE_PANEL_MIN_WIDTH, maxWidth);
      filePanelWidthRef.current = next;
      return next;
    });
  }, [panelWidth]);

  useEffect(() => {
    const next = storedPanelSize(
      filePanelWidthStorageKey,
      defaultFilePanelWidth(panelWidth),
      FILE_PANEL_MIN_WIDTH,
      maxFilePanelWidth(panelWidth),
    );
    filePanelWidthRef.current = next;
    setFilePanelWidth(next);
    const nextHeight = storedPanelSize(
      filePanelHeightStorageKey,
      FILE_PANEL_DEFAULT_HEIGHT,
      FILE_PANEL_MIN_HEIGHT,
      FILE_PANEL_MAX_HEIGHT,
    );
    filePanelHeightRef.current = nextHeight;
    setFilePanelHeight(nextHeight);
    // Only reload saved sizes when the chat-specific storage keys change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePanelWidthStorageKey, filePanelHeightStorageKey]);

  useEffect(() => {
    setFileViewCollapsed(window.localStorage.getItem(fileViewCollapsedStorageKey) === "1");
  }, [fileViewCollapsedStorageKey]);

  useEffect(() => {
    const stopResize = () => {
      const resize = filePanelResizeRef.current;
      if (!resize) return;
      filePanelResizeRef.current = null;
      document.documentElement.classList.remove("mr-files-resizing-width", "mr-files-resizing-height");
      if (resize.mode === "width") {
        window.localStorage.setItem(filePanelWidthStorageKey, String(filePanelWidthRef.current));
      } else {
        window.localStorage.setItem(filePanelHeightStorageKey, String(filePanelHeightRef.current));
      }
    };

    const moveResize = (event: PointerEvent) => {
      const resize = filePanelResizeRef.current;
      if (!resize) return;
      event.preventDefault();
      if (resize.mode === "width") {
        const next = clampNumber(
          resize.startWidth + event.clientX - resize.startClientX,
          FILE_PANEL_MIN_WIDTH,
          resize.maxWidth,
        );
        filePanelWidthRef.current = next;
        setFilePanelWidth(next);
        return;
      }
      const next = clampNumber(
        resize.startHeight + event.clientY - resize.startClientY,
        FILE_PANEL_MIN_HEIGHT,
        FILE_PANEL_MAX_HEIGHT,
      );
      filePanelHeightRef.current = next;
      setFilePanelHeight(next);
    };

    window.addEventListener("pointermove", moveResize);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
    return () => {
      window.removeEventListener("pointermove", moveResize);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    };
  }, [filePanelHeightStorageKey, filePanelWidthStorageKey]);

  useEffect(() => {
    if (!review || filesTouched) return;
    setFilesCollapsed(!wideLayout);
  }, [filesTouched, review, wideLayout]);

  useEffect(() => {
    setActiveSearchMatchIndex(0);
  }, [searchText, selectedPath]);

  useEffect(() => {
    setActiveSearchMatchIndex((current) => {
      if (searchMatches === 0) return 0;
      return Math.min(current, searchMatches - 1);
    });
  }, [searchMatches]);

  const cycleSearchMatch = useCallback((direction: 1 | -1) => {
    if (searchMatches === 0) return;
    setActiveSearchMatchIndex((current) => (current + direction + searchMatches) % searchMatches);
  }, [searchMatches]);

  const loadMergeRequestUrl = useCallback(async (rawUrl: string, persist = true, options: { force?: boolean } = {}) => {
    const url = normalizeUrl(rawUrl);
    if (!url) {
      setState({ status: "error", message: "Enter a GitLab merge request URL." });
      return;
    }

    const requestId = loadRequestIdRef.current + 1;
    loadRequestIdRef.current = requestId;
    const isCurrentRequest = () => loadRequestIdRef.current === requestId;

    setDraftUrl(url);
    setState({ status: "loading" });
    setSelectedPath(null);
    setPinStatus(null);
    setSelectedRows(new Set());
    lastSelectedRowRef.current = null;
    rowSelectionDragRef.current = null;
    setFilesTouched(false);
    setSearchQuery("");
    setActiveSearchMatchIndex(0);
    setExpandedContext(new Set());
    try {
      if (!options.force) {
        const cached = await readCachedReview(cacheKey, url);
        if (cached) {
          if (!isCurrentRequest()) return;
          setState({ status: "ok", data: cached });
          setUrlEditorOpen(false);
          if (persist) {
            window.localStorage.setItem(storageKey, url);
            window.localStorage.setItem(fileViewCollapsedStorageKey, "0");
            setFileViewCollapsed(false);
          }
          return;
        }
      }

      const res = await fetch(`/api/gitlab/merge-request?url=${encodeURIComponent(url)}`, {
        cache: "no-store",
      });
      if (!isCurrentRequest()) return;
      const data = await res.json().catch(() => null) as (GitLabMergeRequestReviewData & { error?: string; hint?: string }) | null;
      if (!res.ok) {
        const message = [data?.error || `GitLab returned HTTP ${res.status}`, data?.hint].filter(Boolean).join(" ");
        throw new Error(message);
      }
      if (!data || !Array.isArray(data.diffs)) throw new Error("GitLab response did not include diff data.");
      void writeCachedReview(cacheKey, url, data);
      setState({ status: "ok", data });
      setUrlEditorOpen(false);
      if (persist) {
        window.localStorage.setItem(storageKey, url);
        window.localStorage.setItem(fileViewCollapsedStorageKey, "0");
        setFileViewCollapsed(false);
      }
    } catch (err) {
      if (!isCurrentRequest()) return;
      setState({ status: "error", message: err instanceof Error ? err.message : "Could not load that merge request." });
    }
  }, [cacheKey, fileViewCollapsedStorageKey, storageKey]);

  useEffect(() => {
    if (restoredStorageKeyRef.current === storageKey) return;
    restoredStorageKeyRef.current = storageKey;
    if (initialUrl?.trim()) return;
    const cachedUrl = window.localStorage.getItem(storageKey)?.trim();
    if (!cachedUrl) {
      loadRequestIdRef.current += 1;
      setDraftUrl("");
      setState({ status: "idle" });
      setUrlEditorOpen(true);
      setSelectedPath(null);
      setSelectedRows(new Set());
      setPinStatus(null);
      return;
    }
    void loadMergeRequestUrl(cachedUrl, false);
  }, [initialUrl, loadMergeRequestUrl, storageKey]);

  useEffect(() => {
    const requestedUrl = initialUrl?.trim();
    if (!requestedUrl) return;
    const normalized = normalizeUrl(requestedUrl);
    if (!normalized) return;
    const key = `${storageKey}:${normalized}`;
    if (loadedInitialUrlRef.current === key) return;
    loadedInitialUrlRef.current = key;
    void loadMergeRequestUrl(normalized, true);
  }, [initialUrl, loadMergeRequestUrl, storageKey]);

  const loadMergeRequest = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    await loadMergeRequestUrl(draftUrl);
  };

  const refreshMergeRequest = () => {
    if (!review) return;
    void loadMergeRequestUrl(review.sourceUrl || review.webUrl || draftUrl, false, { force: true });
  };

  const contextForScope = () => {
    if (!review) return "";
    return formatGitLabMrContext(review, { selectedPath: selectedFile?.newPath });
  };

  const addToChat = () => {
    const context = contextForScope();
    if (!context) return;
    onInsertIntoComposer?.(context);
  };

  const selectedLineContext = () => {
    if (!review || selectedRows.size === 0) return "";
    const selected = diffRows
      .filter((item) => selectedRows.has(item.index) && item.row.kind === "line")
      .map((item) => {
        const row = item.row as Extract<ParsedDiffRow, { kind: "line" }>;
        const sign = row.lineKind === "add" ? "+" : row.lineKind === "del" ? "-" : " ";
        return `${item.filePath ?? selectedFile?.newPath ?? "diff"}:${lineNumberLabel(row)} ${sign}${row.text}`;
      });
    if (selected.length === 0) return "";
    return [
      "GitLab merge request selected diff context",
      "",
      `MR: !${review.iid} ${review.title}`,
      `URL: ${review.webUrl || review.sourceUrl}`,
      selectedFile ? `File: ${selectedFile.newPath}` : "Scope: selected diff lines",
      "",
      "Selected lines:",
      "```diff",
      selected.join("\n"),
      "```",
    ].join("\n");
  };

  const addSelectedToChat = () => {
    const context = selectedLineContext();
    if (!context) return;
    if (review && onAttachToComposer) {
      onAttachToComposer({
        kind: "gitlab-mr",
        label: `MR !${review.iid} selected diff`,
        detail: `${selectedRows.size.toLocaleString()} line${selectedRows.size === 1 ? "" : "s"}`,
        text: context,
      });
      setSelectedRows(new Set());
      lastSelectedRowRef.current = null;
      rowSelectionDragRef.current = null;
      return;
    }
    onInsertIntoComposer?.(context);
  };

  const toggleFiles = () => {
    setFilesTouched(true);
    setFilesCollapsed((current) => !current);
  };

  const toggleContext = (key: string) => {
    setExpandedContext((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleFileView = () => {
    setFileViewCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem(fileViewCollapsedStorageKey, next ? "1" : "0");
      return next;
    });
  };

  const startFilePanelResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const mode = wideLayout ? "width" : "height";
    filePanelResizeRef.current = {
      mode,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startWidth: filePanelWidthRef.current,
      startHeight: filePanelHeightRef.current,
      maxWidth: maxFilePanelWidth(panelWidth),
    };
    document.documentElement.classList.remove("mr-files-resizing-width", "mr-files-resizing-height");
    document.documentElement.classList.add(mode === "width" ? "mr-files-resizing-width" : "mr-files-resizing-height");
  };

  const resetFilePanelSize = () => {
    if (wideLayout) {
      const next = defaultFilePanelWidth(panelWidth);
      filePanelWidthRef.current = next;
      setFilePanelWidth(next);
      window.localStorage.setItem(filePanelWidthStorageKey, String(next));
      return;
    }
    filePanelHeightRef.current = FILE_PANEL_DEFAULT_HEIGHT;
    setFilePanelHeight(FILE_PANEL_DEFAULT_HEIGHT);
    window.localStorage.setItem(filePanelHeightStorageKey, String(FILE_PANEL_DEFAULT_HEIGHT));
  };

  const applyRowRangeSelection = useCallback((anchor: number, target: number, mode: RowSelectionMode) => {
    const start = lineRowIndexes.indexOf(anchor);
    const end = lineRowIndexes.indexOf(target);
    if (start < 0 || end < 0) return;

    const [from, to] = start <= end ? [start, end] : [end, start];
    const range = lineRowIndexes.slice(from, to + 1);
    setSelectedRows((current) => {
      const next = new Set(current);
      for (const rowIndex of range) {
        if (mode === "remove") next.delete(rowIndex);
        else next.add(rowIndex);
      }
      return next;
    });
  }, [lineRowIndexes]);

  useEffect(() => {
    const finishDrag = () => {
      rowSelectionDragRef.current = null;
    };
    window.addEventListener("pointerup", finishDrag);
    window.addEventListener("pointercancel", finishDrag);
    return () => {
      window.removeEventListener("pointerup", finishDrag);
      window.removeEventListener("pointercancel", finishDrag);
    };
  }, []);

  const startRowSelection = (index: number, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;

    event.preventDefault();
    suppressNextRowClickRef.current = true;
    window.setTimeout(() => {
      suppressNextRowClickRef.current = false;
    }, 50);

    if (event.shiftKey && lastSelectedRowRef.current !== null) {
      applyRowRangeSelection(lastSelectedRowRef.current, index, "add");
      lastSelectedRowRef.current = index;
      rowSelectionDragRef.current = null;
      return;
    }

    const mode: RowSelectionMode = selectedRows.has(index) ? "remove" : "add";
    rowSelectionDragRef.current = { anchor: index, mode };
    setSelectedRows((current) => {
      const next = new Set(current);
      if (mode === "remove") next.delete(index);
      else next.add(index);
      return next;
    });
    lastSelectedRowRef.current = index;
  };

  const enterRowSelection = (index: number, event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = rowSelectionDragRef.current;
    if (!drag || event.buttons !== 1) return;

    event.preventDefault();
    applyRowRangeSelection(drag.anchor, index, drag.mode);
    lastSelectedRowRef.current = index;
  };

  const toggleDiffRow = (index: number, event: ReactMouseEvent<HTMLButtonElement>) => {
    if (suppressNextRowClickRef.current) {
      suppressNextRowClickRef.current = false;
      return;
    }

    setSelectedRows((current) => {
      const next = new Set(current);

      if (event.shiftKey && lastSelectedRowRef.current !== null) {
        const start = lineRowIndexes.indexOf(lastSelectedRowRef.current);
        const end = lineRowIndexes.indexOf(index);
        if (start >= 0 && end >= 0) {
          const [from, to] = start <= end ? [start, end] : [end, start];
          for (const rowIndex of lineRowIndexes.slice(from, to + 1)) next.add(rowIndex);
        }
      } else if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }

      lastSelectedRowRef.current = index;
      return next;
    });
  };

  const pinForAgent = async () => {
    if (!review || !onPinContext) return;
    const context = contextForScope();
    if (!context) return;
    setPinning(true);
    setPinStatus(null);
    try {
      await onPinContext(context, `GitLab MR !${review.iid}${selectedFile ? ` ${selectedFile.newPath}` : ""}`);
      setPinStatus("Pinned for future turns.");
    } catch (err) {
      setPinStatus(err instanceof Error ? err.message : "Pin failed.");
    } finally {
      setPinning(false);
    }
  };

  return (
    <div className="insp-mr-pane">
      {(!review || urlEditorOpen) && (
        <form className="insp-mr-toolbar" onSubmit={loadMergeRequest}>
          <input
            className="insp-mr-url"
            value={draftUrl}
            onChange={(event) => setDraftUrl(event.target.value)}
            placeholder="https://gitlab.com/group/project/-/merge_requests/123"
            aria-label="GitLab merge request URL"
          />
          <button type="submit" className="insp-mr-button primary" disabled={state.status === "loading"}>
            {state.status === "loading" ? "Loading..." : "Load"}
          </button>
          {review && (
            <button type="button" className="insp-mr-button quiet" onClick={() => setUrlEditorOpen(false)}>
              Cancel
            </button>
          )}
        </form>
      )}

      {state.status === "error" && <div className="insp-mr-error">{state.message}</div>}

      {state.status === "idle" && (
        <div className="insp-mr-empty">
          <span>Paste a GitLab merge request URL to review its diff here.</span>
        </div>
      )}

      {state.status === "loading" && (
        <div className="insp-mr-empty">
          <svg className="animate-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" strokeOpacity="0.2" />
            <path d="M21 12a9 9 0 00-9-9" />
          </svg>
          <span>Loading merge request...</span>
        </div>
      )}

      {review && (
        <>
          <details className="insp-mr-summary" open>
            <summary className="insp-mr-summary-trigger">
              <div className="insp-mr-title" title={review.title}>
                <span>!{review.iid}</span>
                {review.title}
              </div>
              <div className="insp-mr-summary-stats">
                <span>{formatCount(scopedFiles)} {scopedFiles === 1 ? "file" : "files"}</span>
                <span className="add">+{formatCount(scopedAdditions)}</span>
                <span className="del">-{formatCount(scopedDeletions)}</span>
                {review.comments.length > 0 && <span>{review.comments.length} comments</span>}
                {(review.pipelineStatus || review.pipelineStatusLabel) && (
                  <span
                    className={`pipeline ${statusClass(review.pipelineStatusGroup || review.pipelineStatus)}`}
                    title={review.pipelineStatusTooltip || `Pipeline ${pipelineLabel(review)}`}
                  >
                    ci {pipelineLabel(review)}
                  </span>
                )}
                {review.warnings.length > 0 && (
                  <span className="warn">
                    {review.warnings.length} warning{review.warnings.length === 1 ? "" : "s"}
                  </span>
                )}
              </div>
              <span className="insp-mr-summary-label">Details</span>
            </summary>
            <div className="insp-mr-summary-body">
              <div className="insp-mr-title-row">
                <div className="insp-mr-meta">
                  <span>{review.projectPath}</span>
                  <span>{review.sourceBranch}{" -> "}{review.targetBranch}</span>
                  <span className="state">{review.state}{review.draft ? " draft" : ""}</span>
                  {shortDate(review.updatedAt) && <span>updated {shortDate(review.updatedAt)}</span>}
                  {review.truncated && <span className="warn">truncated</span>}
                  {review.detailedMergeStatus && <span>{review.detailedMergeStatus}</span>}
                </div>
                <a className="insp-mr-open-link" href={review.webUrl} target="_blank" rel="noreferrer">
                  Open
                </a>
              </div>
              {review.warnings.length > 0 && (
                <div className="insp-mr-warnings">
                  {review.warnings.map((warning) => (
                    <div key={warning}>{warning}</div>
                  ))}
                </div>
              )}
              <div className="insp-mr-details-section">
                <div className="insp-mr-section-heading">
                  <span>Full MR details</span>
                </div>
                <dl className="insp-mr-detail-grid">
                  {mrDetailRows.map((item) => (
                    <div key={item.label}>
                      <dt>{item.label}</dt>
                      <dd title={item.title ?? item.value}>{item.value}</dd>
                    </div>
                  ))}
                </dl>
                {review.pipelineWebUrl && (
                  <a
                    className={`insp-mr-pipeline-link ${statusClass(review.pipelineStatusGroup || review.pipelineStatus)}`}
                    href={review.pipelineWebUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open pipeline: {pipelineLabel(review)}
                  </a>
                )}
              </div>
              <div className="insp-mr-description">
                <div className="insp-mr-section-heading">
                  <span>Description</span>
                </div>
                {review.description?.trim() ? (
                  <GitLabMarkdown
                    body={review.description}
                    instanceUrl={review.instanceUrl}
                    className="insp-mr-description-body prose-dashboard"
                  />
                ) : (
                  <div className="insp-mr-description-empty">No description provided.</div>
                )}
              </div>
              {review.comments.length > 0 && (
                <details className="insp-mr-discussions" open>
                  <summary className="insp-mr-discussions-trigger">
                    <span>Discussions</span>
                    <span>
                      {formatCount(review.comments.length)} total, {formatCount(unresolvedComments)} unresolved, {formatCount(resolvedComments)} resolved
                    </span>
                  </summary>
                  <div className="insp-mr-discussions-list">
                    {review.comments.map((comment) => {
                      const line = comment.newLine ?? comment.oldLine;
                      const location = [
                        comment.path,
                        typeof line === "number" ? `line ${line}` : "",
                      ].filter(Boolean).join(": ");
                      return (
                        <div key={`${comment.discussionId}:${comment.id}`} className={`insp-mr-discussion ${comment.resolved ? "resolved" : ""}`.trim()}>
                          <div className="insp-mr-discussion-head">
                            <strong>{comment.authorName || comment.authorUsername || "GitLab comment"}</strong>
                            {formatCommentDate(comment.createdAt) && <span>{formatCommentDate(comment.createdAt)}</span>}
                            {location && <span title={location}>{location}</span>}
                            {comment.resolved ? <span>resolved</span> : <span className="open">unresolved</span>}
                          </div>
                          <MarkdownComment body={comment.body} instanceUrl={review.instanceUrl} />
                        </div>
                      );
                    })}
                  </div>
                </details>
              )}
              <div className="insp-mr-actions">
                <button type="button" className="insp-mr-button quiet" onClick={() => setUrlEditorOpen(true)}>
                  Change MR
                </button>
                <button type="button" className="insp-mr-button quiet" onClick={refreshMergeRequest}>
                  Refresh
                </button>
                <button type="button" className="insp-mr-button primary" onClick={addToChat}>
                  {selectedFile ? "Add file to chat" : "Add MR to chat"}
                </button>
                <button
                  type="button"
                  className="insp-mr-button quiet"
                  onClick={pinForAgent}
                  disabled={pinning || !onPinContext}
                >
                  {pinning ? "Pinning..." : "Pin for agent"}
                </button>
                <button type="button" className="insp-mr-button quiet" onClick={toggleFileView}>
                  {fileViewCollapsed ? "Show file view" : "Hide file view"}
                </button>
                {pinStatus && <span className="insp-mr-pin-status">{pinStatus}</span>}
              </div>
            </div>
          </details>

          {fileViewCollapsed ? (
            <div className="insp-mr-review-collapsed">
              <div className="insp-mr-review-collapsed-copy">
                <strong>{fileViewLabel}</strong>
                <span>
                  {formatCount(scopedFiles)} {scopedFiles === 1 ? "file" : "files"}
                  {" · "}+{formatCount(scopedAdditions)} -{formatCount(scopedDeletions)}
                  {selectedRows.size > 0 && ` · ${selectedRows.size.toLocaleString()} selected`}
                </span>
              </div>
              <button type="button" className="insp-mr-button quiet" onClick={refreshMergeRequest}>
                Refresh
              </button>
              <button type="button" className="insp-mr-button primary" onClick={toggleFileView}>
                Show file view
              </button>
            </div>
          ) : (
            <div
              className={`insp-mr-review ${wideLayout ? "wide" : ""} ${filesCollapsed ? "files-collapsed" : ""}`.trim()}
              style={reviewStyle}
            >
            <div className="insp-mr-diff-controls">
              <button type="button" className="insp-mr-button quiet" onClick={toggleFiles}>
                {filesCollapsed ? `Show files (${review.files})` : "Hide files"}
              </button>
              <button type="button" className="insp-mr-button quiet" onClick={refreshMergeRequest}>
                Refresh
              </button>
              <div className="insp-mr-search-wrap">
                <input
                  className="insp-mr-search"
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || searchMatches === 0) return;
                    event.preventDefault();
                    cycleSearchMatch(event.shiftKey ? -1 : 1);
                  }}
                  placeholder="Search MR diff"
                  aria-label="Search merge request diff"
                />
              </div>
              {searchQuery.trim() && (
                <div className="insp-mr-search-nav" aria-label="Search result navigation">
                  <span className="insp-mr-search-count">
                    {searchMatches > 0
                      ? `${Math.min(activeSearchMatchIndex + 1, searchMatches).toLocaleString()} / ${searchMatches.toLocaleString()}`
                      : "0 matches"}
                  </span>
                  <button
                    type="button"
                    className="insp-mr-search-nav-button"
                    onClick={() => cycleSearchMatch(-1)}
                    disabled={searchMatches < 2}
                    aria-label="Previous search result"
                    title="Previous search result"
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M4.5 9.5 8 6l3.5 3.5" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="insp-mr-search-nav-button"
                    onClick={() => cycleSearchMatch(1)}
                    disabled={searchMatches < 2}
                    aria-label="Next search result"
                    title="Next search result"
                  >
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M4.5 6.5 8 10l3.5-3.5" />
                    </svg>
                  </button>
                </div>
              )}
              {selectedRows.size > 0 && (
                <>
                  <button type="button" className="insp-mr-button primary" onClick={addSelectedToChat}>
                    Add {selectedRows.size.toLocaleString()} selected
                  </button>
                  <button
                    type="button"
                    className="insp-mr-button quiet"
                    onClick={() => {
                      setSelectedRows(new Set());
                      lastSelectedRowRef.current = null;
                      rowSelectionDragRef.current = null;
                    }}
                  >
                    Clear
                  </button>
                </>
              )}
              <button type="button" className="insp-mr-button quiet" onClick={toggleFileView}>
                Hide view
              </button>
            </div>

            {!filesCollapsed && (
              <>
                <div className="insp-mr-files">
                  <button
                    type="button"
                    className={`insp-mr-file-row ${selectedPath === null ? "active" : ""}`}
                    onClick={() => setSelectedPath(null)}
                  >
                    <span className="insp-mr-file-name">All changed files</span>
                    <span className="insp-mr-file-stat">+{formatCount(review.additions)} -{formatCount(review.deletions)}</span>
                  </button>
                  {filteredFiles.map((file) => {
                    const active = selectedFile === file;
                    const flags = fileFlags(file);
                    return (
                      <button
                        key={`${file.oldPath}:${file.newPath}`}
                        type="button"
                        className={`insp-mr-file-row ${active ? "active" : ""}`}
                        onClick={() => setSelectedPath(file.newPath)}
                        title={file.newPath}
                      >
                        <span className="insp-mr-file-name">{file.newPath}</span>
                        {file.renamedFile && file.oldPath !== file.newPath && (
                          <span className="insp-mr-file-old">from {file.oldPath}</span>
                        )}
                        <span className="insp-mr-file-stat">+{formatCount(file.additions)} -{formatCount(file.deletions)}</span>
                        {flags.length > 0 && <span className="insp-mr-file-flags">{flags.join(", ")}</span>}
                      </button>
                    );
                  })}
                  {filteredFiles.length === 0 && (
                    <div className="insp-mr-files-empty">No files match the search.</div>
                  )}
                </div>
                <button
                  type="button"
                  className="insp-mr-files-resizer"
                  onPointerDown={startFilePanelResize}
                  onDoubleClick={resetFilePanelSize}
                  aria-label={wideLayout ? "Resize file list width" : "Resize file list height"}
                  title="Drag to resize the file list. Double-click to reset."
                />
              </>
            )}

            <div className="insp-mr-diff">
              <div className="file-viewer-diff-meta">
                <span>{selectedFile?.newPath ?? "All changed files"}</span>
                <span>{formatCount(scopedFiles)} {scopedFiles === 1 ? "file" : "files"}</span>
                <span className="file-viewer-diff-stat add">+{formatCount(scopedAdditions)}</span>
                <span className="file-viewer-diff-stat del">-{formatCount(scopedDeletions)}</span>
              </div>
              <MergeRequestDiff
                parsed={parsedDiff}
                searchQuery={searchQuery}
                activeSearchRowIndex={activeSearchRowIndex}
                comments={review.comments}
                instanceUrl={review.instanceUrl}
                sourceByPath={sourceByPath}
                selectedRows={selectedRows}
                expandedContext={expandedContext}
                onToggleRow={toggleDiffRow}
                onStartRowSelection={startRowSelection}
                onEnterRowSelection={enterRowSelection}
                onToggleContext={toggleContext}
              />
            </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
