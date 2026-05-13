"use client";

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
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

type SyntaxLanguage = "python" | "typescript" | "generic";

function languageForPath(pathValue?: string): SyntaxLanguage {
  const lower = (pathValue ?? "").toLowerCase();
  if (lower.endsWith(".py")) return "python";
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(lower)) return "typescript";
  return "generic";
}

function syntaxPattern(language: Exclude<SyntaxLanguage, "generic">): RegExp {
  if (language === "python") {
    return /(?<comment>#.*$)|(?<decorator>@[A-Za-z_][\w.]*)|(?<string>[rRuUbBfF]{0,3}(?:"""[^\r\n]*(?:"""|$)|'''[^\r\n]*(?:'''|$)|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))|(?<keyword>\b(?:and|as|assert|async|await|break|case|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|match|nonlocal|not|or|pass|raise|return|try|while|with|yield)\b)|(?<constant>\b(?:None|True|False)\b)|(?<builtin>\b(?:self|cls|Exception|ValueError|TypeError|NotImplementedError|str|int|float|bool|dict|list|set|tuple|len|range|enumerate|print|super|object|property|staticmethod|classmethod|isinstance|issubclass)\b)|(?<function>\b[A-Za-z_]\w*(?=\s*\())|(?<number>\b\d+(?:\.\d+)?\b)|(?<operator>->|==|!=|<=|>=|:=|\*\*|[=+\-*/%<>:])/g;
  }

  return /(?<comment>\/\/.*$|\/\*[^\r\n]*(?:\*\/|$))|(?<string>"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(?<keyword>\b(?:as|async|await|break|case|catch|class|const|continue|default|delete|else|export|extends|finally|for|from|function|if|import|in|instanceof|interface|let|new|of|return|satisfies|switch|throw|try|type|typeof|var|while|yield)\b)|(?<constant>\b(?:true|false|null|undefined)\b)|(?<builtin>\b(?:Array|Boolean|Date|Error|JSON|Map|Math|Number|Object|Promise|React|Set|String|console|document|window)\b)|(?<function>\b[A-Za-z_$][\w$]*(?=\s*\())|(?<number>\b\d+(?:\.\d+)?\b)|(?<operator>=>|===|!==|==|!=|<=|>=|\+\+|--|&&|\|\||[=+\-*/%<>?:])/g;
}

function tokenClass(groups: Record<string, string | undefined>): string {
  if (groups.comment) return "diff-token-comment";
  if (groups.decorator) return "diff-token-decorator";
  if (groups.string) return "diff-token-string";
  if (groups.keyword) return "diff-token-keyword";
  if (groups.constant) return "diff-token-constant";
  if (groups.builtin) return "diff-token-builtin";
  if (groups.function) return "diff-token-function";
  if (groups.number) return "diff-token-number";
  if (groups.operator) return "diff-token-operator";
  return "";
}

function highlightCode(text: string, pathValue?: string): ReactNode {
  const language = languageForPath(pathValue);
  if (language === "generic" || !text) return text;

  const regex = syntaxPattern(language);
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(regex)) {
    const value = match[0];
    const index = match.index ?? 0;
    if (index > lastIndex) parts.push(text.slice(lastIndex, index));
    const className = tokenClass(match.groups ?? {});
    parts.push(className ? <span key={`${index}-${value}`} className={className}>{value}</span> : value);
    lastIndex = index + value.length;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts;
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
  const normalizedSearch = searchQuery.trim().toLowerCase();

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
                  <span className="file-viewer-diff-code">{highlightCode(row.text, filePath)}</span>
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
  const [draftUrl, setDraftUrl] = useState("");
  const [state, setState] = useState<ReviewState>({ status: "idle" });
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [pinning, setPinning] = useState(false);
  const [pinStatus, setPinStatus] = useState<string | null>(null);
  const [urlEditorOpen, setUrlEditorOpen] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [filesCollapsed, setFilesCollapsed] = useState(false);
  const [filesTouched, setFilesTouched] = useState(false);
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const lastSelectedRowRef = useRef<number | null>(null);
  const rowSelectionDragRef = useRef<{ anchor: number; mode: RowSelectionMode } | null>(null);
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
  const wideLayout = (panelWidth ?? 0) >= 760;
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
      if (persist) window.localStorage.setItem(storageKey, url);
    } catch (err) {
      setState({ status: "error", message: err instanceof Error ? err.message : "Could not load that merge request." });
    }
  }, [storageKey]);

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
                {pinStatus && <span className="insp-mr-pin-status">{pinStatus}</span>}
              </div>
            </div>
          </details>

          <div className={`insp-mr-review ${wideLayout ? "wide" : ""} ${filesCollapsed ? "files-collapsed" : ""}`.trim()}>
            <div className="insp-mr-diff-controls">
              <button type="button" className="insp-mr-button quiet" onClick={toggleFiles}>
                {filesCollapsed ? `Show files (${review.files})` : "Hide files"}
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
            </div>

            {!filesCollapsed && (
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
        </>
      )}
    </div>
  );
}
