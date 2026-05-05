"use client";

import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

type Props = {
  filePath: string;
  sessionId: string;
  refreshKey?: string | number;
  onClose: () => void;
};

type FileKind = "audio" | "binary" | "csv" | "image" | "pdf" | "spreadsheet" | "text" | "video";

type TableSheet = {
  name: string;
  rows: string[][];
  rowCount: number;
  columnCount: number;
  truncated: boolean;
};

type FileContent = {
  kind: FileKind;
  mimeType: string;
  name: string;
  path: string;
  resolvedPath: string;
  size: number;
  content?: string;
  truncated?: boolean;
  sheets?: TableSheet[];
};

type FileState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; data: FileContent };

type DiffContent = {
  isGitRepo: boolean;
  hasChanges: boolean;
  diff: string;
  gitRoot?: string;
  relativePath?: string;
  status?: string;
  truncated?: boolean;
  message?: string;
};

type DiffState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; data: DiffContent };

type ViewMode = "preview" | "source" | "diff";
type DiffLineKind = "add" | "del" | "ctx";

const MARKDOWN_PLUGINS = [remarkGfm];

type ParsedDiffRow =
  | { kind: "section"; text: string }
  | { kind: "file"; text: string }
  | { kind: "meta"; text: string }
  | { kind: "hunk"; text: string }
  | { kind: "line"; lineKind: DiffLineKind; text: string; oldLine?: number; newLine?: number };

type ParsedDiff = {
  rows: ParsedDiffRow[];
  additions: number;
  deletions: number;
  files: number;
};

function extOf(p: string): string {
  const base = p.split("/").pop() ?? p;
  if (base.toLowerCase() === "dockerfile") return "dockerfile";
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function isHtmlFile(data: FileContent): boolean {
  const mime = data.mimeType.toLowerCase();
  return mime.startsWith("text/html") || ["html", "htm"].includes(extOf(data.name || data.path));
}

function isMarkdownFile(data: FileContent): boolean {
  const mime = data.mimeType.toLowerCase();
  return mime.startsWith("text/markdown") || ["md", "mdx"].includes(extOf(data.name || data.path));
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function columnLabel(index: number): string {
  let n = index + 1;
  let label = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

function formatDiffPath(raw: string): string {
  const match = /^diff --git a\/(.+) b\/(.+)$/.exec(raw);
  if (match) return match[2];
  return raw.replace(/^diff --git\s+/, "");
}

function parseUnifiedDiff(diff: string): ParsedDiff {
  const rows: ParsedDiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let additions = 0;
  let deletions = 0;
  let files = 0;

  for (const raw of diff.split(/\r?\n/)) {
    if (!raw) continue;

    if (raw.startsWith("## ")) {
      rows.push({ kind: "section", text: raw.replace(/^##\s*/, "") });
      continue;
    }

    if (raw.startsWith("diff --git ")) {
      files += 1;
      rows.push({ kind: "file", text: formatDiffPath(raw) });
      continue;
    }

    if (raw.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (match) {
        oldLine = Number(match[1]);
        newLine = Number(match[2]);
      }
      rows.push({ kind: "hunk", text: raw });
      continue;
    }

    if (raw.startsWith("--- ") || raw.startsWith("+++ ") || raw.startsWith("index ") || raw.startsWith("new file mode ") || raw.startsWith("deleted file mode ") || raw.startsWith("similarity index ") || raw.startsWith("rename from ") || raw.startsWith("rename to ") || raw.startsWith("\\ ")) {
      rows.push({ kind: "meta", text: raw });
      continue;
    }

    if (raw.startsWith("+")) {
      rows.push({ kind: "line", lineKind: "add", text: raw.slice(1), newLine });
      newLine += 1;
      additions += 1;
      continue;
    }

    if (raw.startsWith("-")) {
      rows.push({ kind: "line", lineKind: "del", text: raw.slice(1), oldLine });
      oldLine += 1;
      deletions += 1;
      continue;
    }

    if (raw.startsWith(" ")) {
      rows.push({ kind: "line", lineKind: "ctx", text: raw.slice(1), oldLine, newLine });
      oldLine += 1;
      newLine += 1;
      continue;
    }

    rows.push({ kind: "meta", text: raw });
  }

  return { rows, additions, deletions, files };
}

export function FileViewer({ filePath, sessionId, refreshKey, onClose }: Props) {
  const [state, setState] = useState<FileState>({ status: "loading" });
  const [diffState, setDiffState] = useState<DiffState>({ status: "idle" });
  const [mode, setMode] = useState<ViewMode>("preview");
  const [expanded, setExpanded] = useState(false);
  const [activeSheetIndex, setActiveSheetIndex] = useState(0);
  const loadSeqRef = useRef(0);
  const diffSeqRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const diffAbortRef = useRef<AbortController | null>(null);

  const rawUrl = useMemo(
    () => `/api/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(filePath)}`,
    [filePath, sessionId],
  );

  const load = useCallback(async () => {
    const requestId = loadSeqRef.current + 1;
    loadSeqRef.current = requestId;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    const isCurrent = () => requestId === loadSeqRef.current && !controller.signal.aborted;
    setState({ status: "loading" });
    setMode("preview");
    setDiffState({ status: "idle" });
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/file-content?path=${encodeURIComponent(filePath)}`,
        { signal: controller.signal },
      );
      if (!isCurrent()) return;
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "failed" })) as { error?: string };
        if (!isCurrent()) return;
        setState({ status: "error", message: err.error ?? `HTTP ${res.status}` });
        return;
      }
      const data = await res.json() as FileContent;
      if (!isCurrent()) return;
      setActiveSheetIndex(0);
      setState({ status: "ok", data });
    } catch (e) {
      if (controller.signal.aborted) return;
      setState({ status: "error", message: e instanceof Error ? e.message : "unknown error" });
    } finally {
      if (loadAbortRef.current === controller) loadAbortRef.current = null;
    }
  }, [filePath, refreshKey, sessionId]);

  const loadDiff = useCallback(async () => {
    const requestId = diffSeqRef.current + 1;
    diffSeqRef.current = requestId;
    diffAbortRef.current?.abort();
    const controller = new AbortController();
    diffAbortRef.current = controller;
    const isCurrent = () => requestId === diffSeqRef.current && !controller.signal.aborted;
    setDiffState({ status: "loading" });
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/file-diff?path=${encodeURIComponent(filePath)}`,
        { signal: controller.signal },
      );
      if (!isCurrent()) return;
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "failed" })) as { error?: string };
        if (!isCurrent()) return;
        setDiffState({ status: "error", message: err.error ?? `HTTP ${res.status}` });
        return;
      }
      const data = await res.json() as DiffContent;
      if (!isCurrent()) return;
      setDiffState({ status: "ok", data });
    } catch (e) {
      if (controller.signal.aborted) return;
      setDiffState({ status: "error", message: e instanceof Error ? e.message : "unknown error" });
    } finally {
      if (diffAbortRef.current === controller) diffAbortRef.current = null;
    }
  }, [filePath, refreshKey, sessionId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    return () => {
      loadAbortRef.current?.abort();
      diffAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (mode === "diff" && diffState.status === "idle") loadDiff();
  }, [diffState.status, loadDiff, mode]);

  const parts = filePath.split("/");
  const fileName = parts.pop() ?? filePath;
  const dirPart = parts.join("/");
  const viewModes = state.status === "ok" && isMarkdownFile(state.data)
    ? ([
        ["preview", "Rendered"],
        ["source", "Source"],
        ["diff", "Diff"],
      ] as const)
    : state.status === "ok" && isHtmlFile(state.data)
    ? ([
        ["preview", "Preview"],
        ["source", "Source"],
        ["diff", "Diff"],
      ] as const)
    : ([
        ["preview", "Preview"],
        ["diff", "Diff"],
      ] as const);

  return (
    <div className={`file-viewer ${expanded ? "expanded" : ""}`}>
      <div className="file-viewer-header">
        <button
          type="button"
          className="file-viewer-back"
          onClick={onClose}
          aria-label="Back to file list"
          title="Back"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 5l-7 7 7 7" />
          </svg>
        </button>
        <div className="file-viewer-title">
          <span className="file-viewer-filename">{fileName}</span>
          {dirPart && <span className="file-viewer-dir">{dirPart}</span>}
        </div>
        {state.status === "ok" && (
          <span className="file-viewer-meta">
            {formatBytes(state.data.size)}{state.data.truncated && " - truncated"}
          </span>
        )}
        {state.status === "ok" && (
          <div className="file-viewer-modes" aria-label="File view mode">
            {viewModes.map(([key, label]) => (
              <button
                key={key}
                type="button"
                className={`file-viewer-mode ${mode === key ? "active" : ""}`}
                onClick={() => setMode(key)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <a
          className="file-viewer-open"
          href={rawUrl}
          target="_blank"
          rel="noreferrer"
          title="Open raw file"
        >
          Open
        </a>
        <button
          type="button"
          className="file-viewer-expand"
          onClick={() => setExpanded((value) => !value)}
          aria-label={expanded ? "Collapse file viewer" : "Expand file viewer"}
          title={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 3v5H3" />
              <path d="M16 3v5h5" />
              <path d="M8 21v-5H3" />
              <path d="M16 21v-5h5" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 3H3v5" />
              <path d="M16 3h5v5" />
              <path d="M8 21H3v-5" />
              <path d="M16 21h5v-5" />
            </svg>
          )}
        </button>
      </div>

      <div className="file-viewer-body">
        {state.status === "loading" && (
          <div className="file-viewer-status">
            <svg className="animate-spin" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" strokeOpacity="0.2"/>
              <path d="M21 12a9 9 0 00-9-9"/>
            </svg>
            Loading…
          </div>
        )}
        {state.status === "error" && (
          <div className="file-viewer-status file-viewer-err">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            {state.message}
          </div>
        )}
        {state.status === "ok" && (
          mode === "diff" ? (
            <DiffPreview state={diffState} onRetry={loadDiff} />
          ) : (
            <FilePreview
              data={state.data}
              mode={mode}
              rawUrl={rawUrl}
              activeSheetIndex={activeSheetIndex}
              setActiveSheetIndex={setActiveSheetIndex}
            />
          )
        )}
      </div>
    </div>
  );
}

function DiffPreview({ state, onRetry }: { state: DiffState; onRetry: () => void }) {
  if (state.status === "idle" || state.status === "loading") {
    return (
      <div className="file-viewer-status">
        <svg className="animate-spin" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" strokeOpacity="0.2"/>
          <path d="M21 12a9 9 0 00-9-9"/>
        </svg>
        Loading diff...
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="file-viewer-empty">
        <span>{state.message}</span>
        <button type="button" className="file-viewer-empty-open" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }

  if (!state.data.isGitRepo || !state.data.hasChanges || !state.data.diff.trim()) {
    return (
      <EmptyPreview
        label={state.data.message ?? "No local Git changes for this file."}
      />
    );
  }

  const parsed = parseUnifiedDiff(state.data.diff);

  return (
    <div className="file-viewer-diff-pane">
      <div className="file-viewer-diff-meta">
        {state.data.status && <span>{state.data.status}</span>}
        {state.data.relativePath && <span>{state.data.relativePath}</span>}
        {parsed.files > 0 && <span>{parsed.files.toLocaleString()} {parsed.files === 1 ? "file" : "files"}</span>}
        <span className="file-viewer-diff-stat add">+{parsed.additions.toLocaleString()}</span>
        <span className="file-viewer-diff-stat del">-{parsed.deletions.toLocaleString()}</span>
        {state.data.truncated && <span>truncated</span>}
      </div>
      <StructuredDiff parsed={parsed} />
    </div>
  );
}

function StructuredDiff({ parsed }: { parsed: ParsedDiff }) {
  if (parsed.rows.length === 0) {
    return <EmptyPreview label="No textual diff is available for this file." />;
  }

  return (
    <div className="file-viewer-diff" role="region" aria-label="File diff">
      <div className="file-viewer-diff-table">
        {parsed.rows.map((row, index) => {
          if (row.kind === "section") {
            return (
              <div key={index} className="file-viewer-diff-section">
                {row.text}
              </div>
            );
          }

          if (row.kind === "file") {
            return (
              <div key={index} className="file-viewer-diff-file">
                {row.text}
              </div>
            );
          }

          if (row.kind === "line") {
            return (
              <div key={index} className={`file-viewer-diff-row ${row.lineKind}`}>
                <span className="file-viewer-diff-gutter old">{row.oldLine ?? ""}</span>
                <span className="file-viewer-diff-gutter new">{row.newLine ?? ""}</span>
                <span className="file-viewer-diff-sign">{row.lineKind === "add" ? "+" : row.lineKind === "del" ? "-" : ""}</span>
                <span className="file-viewer-diff-code">{row.text}</span>
              </div>
            );
          }

          return (
            <div key={index} className={`file-viewer-diff-row ${row.kind}`}>
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

function FilePreview({
  activeSheetIndex,
  data,
  mode,
  rawUrl,
  setActiveSheetIndex,
}: {
  activeSheetIndex: number;
  data: FileContent;
  mode: ViewMode;
  rawUrl: string;
  setActiveSheetIndex: (index: number) => void;
}) {
  if (data.kind === "text" && isMarkdownFile(data) && mode === "preview" && typeof data.content === "string") {
    return <MarkdownPreview content={data.content} />;
  }

  if (isHtmlFile(data) && mode === "preview") {
    return <HtmlPreview name={data.name} rawUrl={rawUrl} />;
  }

  if (data.kind === "text" && typeof data.content === "string") {
    return (
      <div className="file-viewer-code">
        <pre>
          <code>{data.content}</code>
        </pre>
      </div>
    );
  }

  if (data.kind === "csv" || data.kind === "spreadsheet") {
    const sheets = data.sheets ?? [];
    const safeIndex = Math.min(activeSheetIndex, Math.max(sheets.length - 1, 0));
    const sheet = sheets[safeIndex];
    return (
      <div className="file-viewer-table-pane">
        {sheets.length > 1 && (
          <div className="file-viewer-sheets" role="tablist" aria-label="Workbook sheets">
            {sheets.map((s, index) => (
              <button
                key={`${s.name}-${index}`}
                type="button"
                className={`file-viewer-sheet ${index === safeIndex ? "active" : ""}`}
                onClick={() => setActiveSheetIndex(index)}
              >
                {s.name || `Sheet ${index + 1}`}
              </button>
            ))}
          </div>
        )}
        {sheet ? <DataTable sheet={sheet} /> : <EmptyPreview label="No rows found in this file." />}
      </div>
    );
  }

  if (data.kind === "pdf") {
    return <iframe className="file-viewer-frame" src={rawUrl} title={data.name} />;
  }

  if (data.kind === "image") {
    return (
      <div className="file-viewer-media-wrap">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="file-viewer-image" src={rawUrl} alt={data.name} />
      </div>
    );
  }

  if (data.kind === "video") {
    return (
      <div className="file-viewer-media-wrap">
        <video className="file-viewer-media" src={rawUrl} controls />
      </div>
    );
  }

  if (data.kind === "audio") {
    return (
      <div className="file-viewer-media-wrap">
        <audio className="file-viewer-audio" src={rawUrl} controls />
      </div>
    );
  }

  return <EmptyPreview label="Preview is not available for this file type." rawUrl={rawUrl} />;
}

const markdownComponents: Components = {
  a: ({ href, children, ...props }) => (
    <a href={href} target="_blank" rel="noreferrer" {...props}>
      {children}
    </a>
  ),
};

function MarkdownPreview({ content }: { content: string }) {
  return (
    <article className="file-viewer-markdown prose-dashboard">
      <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS} components={markdownComponents}>
        {content}
      </ReactMarkdown>
    </article>
  );
}

function HtmlPreview({ name, rawUrl }: { name: string; rawUrl: string }) {
  return (
    <iframe
      className="file-viewer-frame file-viewer-html-frame"
      src={rawUrl}
      title={name}
      sandbox="allow-forms allow-modals allow-popups allow-scripts"
      referrerPolicy="no-referrer"
    />
  );
}

function DataTable({ sheet }: { sheet: TableSheet }) {
  const columnTotal = Math.max(sheet.columnCount, 1);
  const columns = Array.from({ length: columnTotal }, (_, index) => columnLabel(index));

  return (
    <div className="file-viewer-table-wrap">
      <div className="file-viewer-table-meta">
        <span>{sheet.rowCount.toLocaleString()} rows</span>
        <span>{sheet.columnCount.toLocaleString()} columns</span>
        {sheet.truncated && <span>showing first {sheet.rows.length.toLocaleString()} rows</span>}
      </div>
      <table className="file-viewer-table">
        <thead>
          <tr>
            <th className="file-viewer-row-head" aria-label="Row number" />
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sheet.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              <th className="file-viewer-row-head">{rowIndex + 1}</th>
              {columns.map((column, columnIndex) => (
                <td key={column}>{row[columnIndex] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmptyPreview({ label, rawUrl }: { label: string; rawUrl?: string }) {
  return (
    <div className="file-viewer-empty">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6" />
        <path d="M8 13h8" />
        <path d="M8 17h5" />
      </svg>
      <span>{label}</span>
      {rawUrl && (
        <a className="file-viewer-empty-open" href={rawUrl} target="_blank" rel="noreferrer">
          Open file
        </a>
      )}
    </div>
  );
}
