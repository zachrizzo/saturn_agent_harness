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

const MARKDOWN_PLUGINS = [remarkGfm];

type ReviewState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; data: GitLabMergeRequestReviewData };

type Props = {
  cacheKey?: string;
  panelWidth?: number;
  onInsertIntoComposer?: (text: string) => void;
  onAttachToComposer?: (attachment: ComposerContextAttachment) => void;
  onPinContext?: (text: string, label: string) => void | Promise<void>;
};

const MR_URL_STORAGE_PREFIX = "saturn.gitlabMergeRequest.url";
const MR_FILES_WIDTH_STORAGE_PREFIX = "saturn.gitlabMergeRequest.filesWidth";
const MR_FILES_HEIGHT_STORAGE_PREFIX = "saturn.gitlabMergeRequest.filesHeight";
const MR_FILE_VIEW_COLLAPSED_STORAGE_PREFIX = "saturn.gitlabMergeRequest.fileViewCollapsed";
const FILE_PANEL_MIN_WIDTH = 180;
const FILE_PANEL_MAX_WIDTH = 520;
const FILE_PANEL_MIN_DIFF_WIDTH = 320;
const FILE_PANEL_MIN_HEIGHT = 96;
const FILE_PANEL_MAX_HEIGHT = 360;
const FILE_PANEL_DEFAULT_HEIGHT = 150;

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

const SHIKI_THEME = "github-light";
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

async function highlightDiffRows(rows: DiffRowWithContext[]): Promise<Map<number, HighlightToken[]>> {
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
      theme: SHIKI_THEME,
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

function MarkdownComment({ body, instanceUrl }: { body: string; instanceUrl: string }) {
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
    <div className="insp-mr-comment-body prose-dashboard">
      <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS} components={components}>
        {body}
      </ReactMarkdown>
    </div>
  );
}

function MergeRequestDiff({
  parsed,
  searchQuery,
  comments,
  instanceUrl,
  selectedRows,
  onToggleRow,
  onStartRowSelection,
  onEnterRowSelection,
}: {
  parsed: ParsedDiff;
  searchQuery: string;
  comments: GitLabMergeRequestComment[];
  instanceUrl: string;
  selectedRows: Set<number>;
  onToggleRow: (index: number, event: ReactMouseEvent<HTMLButtonElement>) => void;
  onStartRowSelection: (index: number, event: ReactPointerEvent<HTMLButtonElement>) => void;
  onEnterRowSelection: (index: number, event: ReactPointerEvent<HTMLButtonElement>) => void;
}) {
  const rows = useMemo(() => rowsWithFileContext(parsed), [parsed]);
  const commentsByLine = useMemo(() => commentMap(comments), [comments]);
  const [highlightedRows, setHighlightedRows] = useState(() => plainHighlightedRows(rows));
  const normalizedSearch = searchQuery.trim().toLowerCase();

  useEffect(() => {
    let cancelled = false;
    setHighlightedRows(plainHighlightedRows(rows));
    highlightDiffRows(rows)
      .then((next) => {
        if (!cancelled) setHighlightedRows(next);
      })
      .catch(() => {
        if (!cancelled) setHighlightedRows(plainHighlightedRows(rows));
      });
    return () => {
      cancelled = true;
    };
  }, [rows]);

  if (parsed.rows.length === 0) {
    return <div className="insp-mr-empty">No textual diff is available for this file.</div>;
  }

  return (
    <div className="file-viewer-diff" role="region" aria-label="File diff">
      <div className="file-viewer-diff-table">
        {rows.map(({ row, index, filePath }) => {
          const searchHit = normalizedSearch.length > 0 && rowSearchText({ row, index, filePath }).toLowerCase().includes(normalizedSearch);
          if (row.kind === "section") {
            return <div key={index} className="file-viewer-diff-section">{row.text}</div>;
          }

          if (row.kind === "file") {
            return <div key={index} className="file-viewer-diff-file">{row.text}</div>;
          }

          if (row.kind === "line") {
            const rowComments = commentsForRow(commentsByLine, filePath, row);
            const selected = selectedRows.has(index);
            return (
              <div key={index} className="insp-mr-diff-line-wrap">
                <button
                  type="button"
                  className={`file-viewer-diff-row ${row.lineKind} selectable ${selected ? "selected" : ""} ${searchHit ? "search-hit" : ""}`}
                  onPointerDown={(event) => onStartRowSelection(index, event)}
                  onPointerEnter={(event) => onEnterRowSelection(index, event)}
                  onClick={(event) => onToggleRow(index, event)}
                  title="Select this line for chat context. Drag or shift-click to select a range."
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
            <div key={index} className={`file-viewer-diff-row ${row.kind} ${searchHit ? "search-hit" : ""}`}>
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

export function GitLabMergeRequestReview({ cacheKey, panelWidth, onInsertIntoComposer, onAttachToComposer, onPinContext }: Props) {
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
  const [filesCollapsed, setFilesCollapsed] = useState(false);
  const [filesTouched, setFilesTouched] = useState(false);
  const [fileViewCollapsed, setFileViewCollapsed] = useState(false);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [filePanelWidth, setFilePanelWidth] = useState(() => defaultFilePanelWidth(panelWidth));
  const [filePanelHeight, setFilePanelHeight] = useState(FILE_PANEL_DEFAULT_HEIGHT);
  const lastSelectedRowRef = useRef<number | null>(null);
  const rowSelectionDragRef = useRef<{ anchor: number; mode: RowSelectionMode } | null>(null);
  const filePanelResizeRef = useRef<FilePanelResizeState | null>(null);
  const filePanelWidthRef = useRef(filePanelWidth);
  const filePanelHeightRef = useRef(filePanelHeight);
  const suppressNextRowClickRef = useRef(false);
  const restoredStorageKeyRef = useRef<string | null>(null);

  const review = state.status === "ok" ? state.data : null;
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
  const searchMatches = useMemo(
    () => searchText
      ? diffRows.filter((item) => rowSearchText(item).toLowerCase().includes(searchText)).length
      : 0,
    [diffRows, searchText],
  );
  const filteredFiles = useMemo(() => {
    if (!review || !searchText) return review?.diffs ?? [];
    return review.diffs.filter((file) => (
      file.newPath.toLowerCase().includes(searchText) ||
      file.oldPath.toLowerCase().includes(searchText) ||
      file.diff.toLowerCase().includes(searchText)
    ));
  }, [review, searchText]);

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

  const loadMergeRequestUrl = useCallback(async (rawUrl: string, persist = true) => {
    const url = normalizeUrl(rawUrl);
    if (!url) {
      setState({ status: "error", message: "Enter a GitLab merge request URL." });
      return;
    }

    setDraftUrl(url);
    setState({ status: "loading" });
    setSelectedPath(null);
    setPinStatus(null);
    setSelectedRows(new Set());
    lastSelectedRowRef.current = null;
    rowSelectionDragRef.current = null;
    setFilesTouched(false);
    setSearchQuery("");
    try {
      const res = await fetch(`/api/gitlab/merge-request?url=${encodeURIComponent(url)}`, {
        cache: "no-store",
      });
      const data = await res.json().catch(() => null) as (GitLabMergeRequestReviewData & { error?: string; hint?: string }) | null;
      if (!res.ok) {
        const message = [data?.error || `GitLab returned HTTP ${res.status}`, data?.hint].filter(Boolean).join(" ");
        throw new Error(message);
      }
      if (!data || !Array.isArray(data.diffs)) throw new Error("GitLab response did not include diff data.");
      setState({ status: "ok", data });
      setUrlEditorOpen(false);
      if (persist) {
        window.localStorage.setItem(storageKey, url);
        window.localStorage.setItem(fileViewCollapsedStorageKey, "0");
        setFileViewCollapsed(false);
      }
    } catch (err) {
      setState({ status: "error", message: err instanceof Error ? err.message : "Could not load that merge request." });
    }
  }, [fileViewCollapsedStorageKey, storageKey]);

  useEffect(() => {
    if (restoredStorageKeyRef.current === storageKey) return;
    restoredStorageKeyRef.current = storageKey;
    const cachedUrl = window.localStorage.getItem(storageKey)?.trim();
    if (!cachedUrl) return;
    void loadMergeRequestUrl(cachedUrl, false);
  }, [loadMergeRequestUrl, storageKey]);

  const loadMergeRequest = async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    await loadMergeRequestUrl(draftUrl);
  };

  const refreshMergeRequest = () => {
    if (!review) return;
    void loadMergeRequestUrl(review.sourceUrl || review.webUrl || draftUrl, false);
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
          <details className="insp-mr-summary">
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
                  {review.warnings.slice(0, 3).map((warning) => (
                    <div key={warning}>{warning}</div>
                  ))}
                </div>
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
                  placeholder="Search MR diff"
                  aria-label="Search merge request diff"
                />
              </div>
              {searchQuery.trim() && (
                <span className="insp-mr-search-count">
                  {searchMatches.toLocaleString()} match{searchMatches === 1 ? "" : "es"}
                </span>
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
                comments={review.comments}
                instanceUrl={review.instanceUrl}
                selectedRows={selectedRows}
                onToggleRow={toggleDiffRow}
                onStartRowSelection={startRowSelection}
                onEnterRowSelection={enterRowSelection}
              />
            </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
