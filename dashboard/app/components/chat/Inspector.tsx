"use client";

import { useEffect, useMemo, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import type { StreamEvent, TokenBreakdown } from "@/lib/events";
import type { SessionMeta } from "@/lib/runs";
import { FileViewer } from "@/app/components/chat/FileViewer";

export type InspectorTool = {
  id: string;
  name: string;
  input: unknown;
  result?: unknown;
  status: "ok" | "err" | "run";
  startedAt?: string;
};

type Props = {
  session: SessionMeta;
  activeTool: InspectorTool | null;
  tools: InspectorTool[];
  tokens: TokenBreakdown;
  events: StreamEvent[];
  width: number;
  onWidthChange: (width: number) => void;
  referencedFiles?: string[];
  fileOpenRequest?: { path: string; requestId: number } | null;
};

const INSPECTOR_TABS = ["tool", "files", "tokens"] as const;
type TabKey = typeof INSPECTOR_TABS[number];
type FilesFilter = "all" | "changes" | "files";

type GitChange = {
  path: string;
  absolutePath: string;
  status: string;
  staged: string;
  unstaged: string;
  untracked: boolean;
  exists: boolean;
};

type GitChangesState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; isGitRepo: boolean; files: GitChange[]; message?: string };

function toJsonString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

const FILE_PATH_KEYS = new Set(["file_path", "path", "new_path", "old_path", "filename"]);
const INSPECTABLE_EXTENSIONS = [
  "avif", "bash", "bmp", "c", "clj", "cpp", "cs", "css", "csv", "cts", "doc",
  "docx", "ex", "exs", "fish", "gif", "go", "gql", "graphql", "h", "hpp",
  "hs", "htm", "html", "java", "jpeg", "jpg", "js", "json", "jsonc", "jsx",
  "kt", "less", "lua", "mjs", "md", "mdx", "ml", "mts", "pdf", "php", "png",
  "ppt", "pptx", "prisma", "ps1", "py", "r", "rb", "rs", "sass", "scala",
  "scss", "sh", "sql", "svg", "svelte", "swift", "toml", "ts", "tsx", "tsv",
  "txt", "vue", "webp", "xls", "xlsx", "xml", "yaml", "yml", "zsh",
];
const INSPECTABLE_EXTENSION_SET = new Set(INSPECTABLE_EXTENSIONS);
const INSPECTABLE_EXTENSION_PATTERN = INSPECTABLE_EXTENSIONS.join("|");

function isLikelyFilePath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed.startsWith("file://");
  if (/^(\/|~\/|\$HOME\/|\$CODEX_HOME\/|\.{1,2}\/)/.test(trimmed)) return true;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return true;
  return trimmed.includes("/") || /^[^/]+\.[A-Za-z0-9]{1,12}$/.test(trimmed);
}

function extOf(value: string): string {
  const base = value.split(/[\\/]/).pop() ?? value;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function isInspectablePath(value: string): boolean {
  return INSPECTABLE_EXTENSION_SET.has(extOf(value));
}

function isBareFilename(value: string): boolean {
  return !/[\\/]/.test(value) && !/^(~|\$HOME|\$CODEX_HOME|file:\/\/|[A-Za-z]:)/.test(value);
}

function cleanPath(value: string): string {
  let trimmed = value.trim();
  if (trimmed.startsWith("file://")) {
    try {
      trimmed = decodeURIComponent(new URL(trimmed).pathname);
    } catch {
      trimmed = trimmed.replace(/^file:\/\//, "");
    }
  }
  return trimmed.replace(/["'`<>{}\]]+$/g, "").replace(/[),;:]+$/g, "");
}

function addPath(files: Set<string>, value: unknown, inspectableOnly = false) {
  if (typeof value !== "string") return;
  const trimmed = cleanPath(value);
  if (!isLikelyFilePath(trimmed)) return;
  if (inspectableOnly && !isInspectablePath(trimmed)) return;
  if (inspectableOnly && isBareFilename(trimmed)) return;
  files.add(trimmed);
}

function collectPathsFromText(text: string, files: Set<string>) {
  const markdownLinks = text.matchAll(/\[[^\]]*]\(([^)]+)\)/g);
  for (const match of markdownLinks) addPath(files, match[1], true);

  const absoluteRe = new RegExp(
    "(?:file:\\/\\/)?(?:\\/|~\\/|\\$HOME\\/|\\$CODEX_HOME\\/|\\.{1,2}\\/)(?:(?![\\r\\n\"'<>]).)+?\\.(" +
      INSPECTABLE_EXTENSION_PATTERN +
      ")\\b",
    "gi",
  );
  for (const match of text.matchAll(absoluteRe)) addPath(files, match[0], true);

  const relativeRe = new RegExp(
    "(?:^|[\\s([])((?:[A-Za-z0-9_.-]+\\/)+(?:[^\\/\\r\\n\"'<>`)]+)\\.(" +
      INSPECTABLE_EXTENSION_PATTERN +
      ")\\b)",
    "gi",
  );
  for (const match of text.matchAll(relativeRe)) addPath(files, match[1], true);
}

function collectFilePathsFromValue(
  value: unknown,
  files: Set<string>,
  options: { scanText?: boolean; inspectableOnly?: boolean } = {},
  depth = 0,
) {
  if (depth > 8 || value == null) return;

  if (typeof value === "string") {
    if (options.scanText) collectPathsFromText(value, files);
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectFilePathsFromValue(item, files, options, depth + 1);
    return;
  }

  if (typeof value !== "object") return;
  const rec = value as Record<string, unknown>;
  for (const [key, pathValue] of Object.entries(rec)) {
    if (FILE_PATH_KEYS.has(key)) addPath(files, pathValue, options.inspectableOnly);
    if (key === "file_paths" && Array.isArray(pathValue)) {
      for (const item of pathValue) addPath(files, item, options.inspectableOnly);
    }
    collectFilePathsFromValue(pathValue, files, options, depth + 1);
  }
}

// ── File tree ────────────────────────────────────────────────────────────────

type PathTreeNode = {
  name: string;
  fullPath: string;
  isDir: boolean;
  children: PathTreeNode[];
  gitChange?: GitChange;
};

function commonPathPrefix(paths: string[]): string {
  const abs = paths.filter((p) => p.startsWith("/"));
  if (abs.length === 0) return "";
  const parts = abs[0].split("/");
  let prefix = "";
  for (let i = 1; i < parts.length; i++) {
    const candidate = parts.slice(0, i + 1).join("/");
    if (abs.every((p) => p === candidate || p.startsWith(candidate + "/"))) prefix = candidate;
    else break;
  }
  return prefix;
}

function insertPath(root: PathTreeNode, parts: string[], fullPath: string, gitChange?: GitChange) {
  let node = root;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const isLast = i === parts.length - 1;
    let child = node.children.find((c) => c.name === part);
    if (!child) {
      child = { name: part, fullPath: isLast ? fullPath : "", isDir: !isLast, children: [], gitChange: isLast ? gitChange : undefined };
      node.children.push(child);
    } else if (isLast) {
      child.fullPath = fullPath;
      if (gitChange) child.gitChange = gitChange;
    }
    node = child;
  }
}

function buildFilePathTree(filePaths: string[]): { root: PathTreeNode; prefix: string } {
  const prefix = commonPathPrefix(filePaths);
  const root: PathTreeNode = { name: "", fullPath: "", isDir: true, children: [] };
  for (const p of filePaths) {
    const rel = prefix ? p.slice(prefix.length + 1) : p.replace(/^\//, "");
    const parts = rel.split("/").filter(Boolean);
    if (parts.length) insertPath(root, parts, p);
  }
  return { root, prefix };
}

function buildGitTree(gitFiles: GitChange[]): PathTreeNode {
  const root: PathTreeNode = { name: "", fullPath: "", isDir: true, children: [] };
  for (const change of gitFiles) {
    const parts = change.path.split("/").filter(Boolean);
    if (parts.length) insertPath(root, parts, change.absolutePath, change);
  }
  return root;
}

function collectDirKeys(root: PathTreeNode, treeId: string): string[] {
  const keys: string[] = [];

  const visit = (node: PathTreeNode, key: string) => {
    if (!node.isDir) return;
    keys.push(key);
    for (const child of node.children) {
      if (child.isDir) visit(child, `${key}/${child.name}`);
    }
  };

  for (const child of root.children) {
    if (child.isDir) visit(child, `${treeId}:${child.name}`);
  }

  return keys;
}

// Tools that produce file writes/edits. Rich document paths are discovered from output too.
const EDIT_TOOL_NAMES = new Set([
  "Write", "Edit", "str_replace", "str_replace_editor",
  "create_file", "write_file", "edit_file", "apply_patch",
  "NotebookEdit",
]);

function collectInspectableFiles(
  tools: InspectorTool[],
  events: StreamEvent[],
  session: SessionMeta,
  referencedFiles: string[] = [],
): string[] {
  const priorityFiles = new Set<string>();
  const files = new Set<string>();

  for (const file of referencedFiles) addPath(priorityFiles, file);
  for (const turn of session.turns) {
    if (turn.final_text) collectPathsFromText(turn.final_text, priorityFiles);
  }
  for (const event of events) {
    if (event.kind === "assistant_text") collectPathsFromText(event.text, priorityFiles);
  }

  for (const t of tools) {
    if (EDIT_TOOL_NAMES.has(t.name)) collectFilePathsFromValue(t.input, files);
    collectFilePathsFromValue(t.input, files, { scanText: true, inspectableOnly: true });
    collectFilePathsFromValue(t.result, files, { scanText: true, inspectableOnly: true });
  }
  for (const event of events) {
    if (event.kind === "tool_result") {
      collectFilePathsFromValue(event.content, files, { scanText: true, inspectableOnly: true });
    }
  }

  const paths = [
    ...priorityFiles,
    ...Array.from(files).filter((file) => !priorityFiles.has(file)),
  ];
  const basenamesWithContext = new Set(
    paths
      .filter((file) => !isBareFilename(file))
      .map((file) => file.split(/[\\/]/).pop() ?? file),
  );
  return paths
    .filter((file) => priorityFiles.has(file) || !(isBareFilename(file) && basenamesWithContext.has(file)))
    .slice(0, 240);
}

const STATUS_COLOR: Record<InspectorTool["status"], string> = {
  ok: "var(--success)",
  err: "var(--fail)",
  run: "var(--warn)",
};
const STATUS_LABEL: Record<InspectorTool["status"], string> = { ok: "ok", err: "err", run: "…" };

function StatusDot({ status }: { status: InspectorTool["status"] }) {
  return (
    <span
      className="inline-block w-[7px] h-[7px] rounded-full flex-shrink-0"
      style={{ background: STATUS_COLOR[status] }}
    />
  );
}

function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="insp-section">
      {title && <div className="insp-heading">{title}</div>}
      {children}
    </div>
  );
}

function KVRow({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="kv-row">
      <span className="kv-label">{label}</span>
      <span className="kv-value">{value || "—"}</span>
    </div>
  );
}

function JsonBlock({ value, error }: { value: unknown; error?: boolean }) {
  const text = value === undefined || value === null ? "" : toJsonString(value);
  if (!text) return <span className="text-[11px] text-subtle italic">—</span>;
  return (
    <pre className="json-block" style={error ? { color: "var(--fail)" } : {}}>
      {text}
    </pre>
  );
}

function GitStatusBadge({ change }: { change: GitChange }) {
  const label = change.untracked ? "new" : change.status.trim() || change.status;
  const tone = change.untracked
    ? "var(--accent)"
    : change.status.includes("D")
      ? "var(--fail)"
      : change.staged
        ? "var(--success)"
        : "var(--warn)";
  return (
    <span
      className="insp-git-status"
      aria-label={`Git status: ${label}`}
      title={`Git status: ${label}`}
      style={{
        color: tone,
        background: `color-mix(in srgb, ${tone} 12%, transparent)`,
        borderColor: `color-mix(in srgb, ${tone} 32%, var(--border))`,
      }}
    >
      {label}
    </span>
  );
}

function FileTreeNode({
  node, depth, nodeKey, collapsedDirs, onToggleDir, onSelect, selectedFile,
}: {
  node: PathTreeNode;
  depth: number;
  nodeKey: string;
  collapsedDirs: Set<string>;
  onToggleDir: (key: string) => void;
  onSelect: (path: string) => void;
  selectedFile: string | null;
}) {
  const open = !collapsedDirs.has(nodeKey);
  const indent = depth * 12;

  if (node.isDir) {
    return (
      <div>
        <button type="button" className="insp-tree-dir" style={{ paddingLeft: `${indent + 6}px` }} onClick={() => onToggleDir(nodeKey)}>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ flexShrink: 0, transition: "transform 0.1s", transform: open ? "rotate(90deg)" : "rotate(0deg)" }}>
            <path d="M9 18l6-6-6-6" />
          </svg>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ flexShrink: 0, color: "var(--accent)", opacity: 0.7 }}>
            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
          </svg>
          <span className="insp-tree-dir-name">{node.name}</span>
        </button>
        {open && node.children.map((child) => (
          <FileTreeNode
            key={child.name + child.fullPath}
            node={child}
            depth={depth + 1}
            nodeKey={`${nodeKey}/${child.name}`}
            collapsedDirs={collapsedDirs}
            onToggleDir={onToggleDir}
            onSelect={onSelect}
            selectedFile={selectedFile}
          />
        ))}
      </div>
    );
  }

  const active = selectedFile === node.fullPath;
  const canOpen = Boolean(node.fullPath) && (!node.gitChange || node.gitChange.exists);

  return (
    <button
      type="button"
      className={`insp-tree-file${active ? " active" : ""}`}
      style={{ paddingLeft: `${indent + 6}px` }}
      onClick={() => canOpen && node.fullPath && onSelect(node.fullPath)}
      title={node.fullPath || node.name}
      disabled={!canOpen}
    >
      <svg className="insp-tree-file-icon" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
        <polyline points="14 2 14 8 20 8" />
      </svg>
      <span className="insp-tree-file-name">{node.name}</span>
      {node.gitChange && <GitStatusBadge change={node.gitChange} />}
      {node.gitChange && !node.gitChange.exists && <span className="insp-file-missing">deleted</span>}
    </button>
  );
}

function FileTree({
  root,
  treeId,
  collapsedDirs,
  onToggleDir,
  onSelect,
  selectedFile,
}: {
  root: PathTreeNode;
  treeId: string;
  collapsedDirs: Set<string>;
  onToggleDir: (key: string) => void;
  onSelect: (path: string) => void;
  selectedFile: string | null;
}) {
  if (root.children.length === 0) return null;
  return (
    <div className="insp-file-tree">
      {root.children.map((child) => (
        <FileTreeNode
          key={child.name + child.fullPath}
          node={child}
          depth={0}
          nodeKey={`${treeId}:${child.name}`}
          collapsedDirs={collapsedDirs}
          onToggleDir={onToggleDir}
          onSelect={onSelect}
          selectedFile={selectedFile}
        />
      ))}
    </div>
  );
}

export function Inspector({
  session,
  activeTool,
  tools,
  tokens,
  events,
  width,
  onWidthChange,
  referencedFiles = [],
  fileOpenRequest,
}: Props) {
  const [tab, setTab] = useState<TabKey>("tool");
  const [filesFilter, setFilesFilter] = useState<FilesFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const [gitChanges, setGitChanges] = useState<GitChangesState>({ status: "loading" });
  const latestTurn = session.turns.at(-1);
  const fileRefreshKey = `${events.length}:${session.status}:${latestTurn?.finished_at ?? ""}`;

  const startResize = (ev: ReactPointerEvent<HTMLButtonElement>) => {
    ev.preventDefault();
    const startX = ev.clientX;
    const startWidth = width;
    const maxWidth = Math.max(360, Math.min(1100, window.innerWidth - 520));
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (moveEv: PointerEvent) => {
      const next = Math.round(Math.min(maxWidth, Math.max(320, startWidth + startX - moveEv.clientX)));
      onWidthChange(next);
    };
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Sync selected tool when parent selects one (chip click)
  useEffect(() => {
    if (activeTool) {
      setSelectedId(activeTool.id);
      setTab("tool");
    }
  }, [activeTool?.id]);

  // Auto-select first tool when switching to tool tab
  useEffect(() => {
    if (tab === "tool" && !selectedId && tools.length > 0) {
      setSelectedId(tools[0].id);
    }
  }, [tab, tools.length]);

  const selectedTool = useMemo(
    () => tools.find((t) => t.id === selectedId) ?? activeTool ?? null,
    [tools, selectedId, activeTool],
  );

  const files = useMemo(
    () => collectInspectableFiles(tools, events, session, referencedFiles),
    [tools, events, session, referencedFiles],
  );
  const gitFiles = gitChanges.status === "ok" ? gitChanges.files : [];
  const { root: fileTreeRoot } = useMemo(() => buildFilePathTree(files), [files]);
  const gitTreeRoot = useMemo(() => buildGitTree(gitFiles), [gitFiles]);
  const selectableFilePaths = useMemo(
    () => new Set([
      ...files,
      ...gitFiles.filter((file) => file.exists).map((file) => file.absolutePath),
    ]),
    [files, gitFiles],
  );
  useEffect(() => {
    if (selectedFile && !selectableFilePaths.has(selectedFile)) setSelectedFile(null);
  }, [selectableFilePaths, selectedFile]);

  useEffect(() => {
    if (!fileOpenRequest?.path) return;
    setTab("files");
    setFilesFilter("files");
    setSelectedFile(fileOpenRequest.path);
  }, [fileOpenRequest?.requestId, fileOpenRequest?.path]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setGitChanges((current) => current.status === "ok" ? current : { status: "loading" });

      fetch(`/api/sessions/${encodeURIComponent(session.session_id)}/git-changes`)
        .then(async (res) => {
          const data = await res.json().catch(() => null) as
            | { isGitRepo?: boolean; files?: GitChange[]; message?: string; error?: string }
            | null;
          if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
          if (!cancelled) {
            setGitChanges({
              status: "ok",
              isGitRepo: Boolean(data?.isGitRepo),
              files: data?.files ?? [],
              message: data?.message,
            });
          }
        })
        .catch((error) => {
          if (!cancelled) {
            setGitChanges({ status: "error", message: error instanceof Error ? error.message : "failed" });
          }
        });
    }, session.status === "running" ? 750 : 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [events.length, session.session_id, session.status]);

  const fileTabCount = files.length + gitFiles.length;
  const showGitChanges = filesFilter !== "files";
  const showFiles = filesFilter !== "changes";
  const visibleDirKeys = useMemo(() => [
    ...(showGitChanges ? collectDirKeys(gitTreeRoot, "git") : []),
    ...(showFiles ? collectDirKeys(fileTreeRoot, "files") : []),
  ], [showGitChanges, showFiles, gitTreeRoot, fileTreeRoot]);
  const hasExpandableDirs = visibleDirKeys.length > 0;
  const allVisibleExpanded = hasExpandableDirs && visibleDirKeys.every((key) => !collapsedDirs.has(key));
  const allVisibleCollapsed = hasExpandableDirs && visibleDirKeys.every((key) => collapsedDirs.has(key));
  const toggleDir = (key: string) => {
    setCollapsedDirs((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const expandVisibleDirs = () => {
    setCollapsedDirs((current) => {
      const next = new Set(current);
      for (const key of visibleDirKeys) next.delete(key);
      return next;
    });
  };
  const collapseVisibleDirs = () => {
    setCollapsedDirs((current) => new Set([...current, ...visibleDirKeys]));
  };
  return (
    <aside className="inspector" style={{ width }}>
      <button
        type="button"
        className="inspector-resizer"
        onPointerDown={startResize}
        aria-label="Resize document panel"
        title="Resize panel"
      />
      {/* Tab bar */}
      <div className="tab-bar">
        {INSPECTOR_TABS.map((t) => {
          const badge =
            t === "tool" ? tools.length :
            t === "files" ? fileTabCount :
            null;
          return (
            <button
              key={t}
              type="button"
              className={`tab ${tab === t ? "active" : ""}`}
              onClick={() => setTab(t)}
            >
              {t === "tool" ? "Tool" : t === "files" ? "Files" : "Tokens"}
              {badge != null && badge > 0 && (
                <span className="n">{badge}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* ── Tool tab ── */}
      {tab === "tool" && (
        <div className="insp-tool-pane">
          {tools.length === 0 ? (
            <div className="insp-empty">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-2 opacity-30">
                <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z"/>
              </svg>
              No tool calls yet.
            </div>
          ) : (
            <>
              {/* Tool list */}
              <div className="insp-tool-list">
                {tools.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`insp-tool-row ${selectedId === t.id ? "active" : ""}`}
                    onClick={() => setSelectedId(t.id)}
                  >
                    <StatusDot status={t.status} />
                    <span className="insp-tool-name">{t.name}</span>
                    <span className="insp-tool-status" style={{ color: STATUS_COLOR[t.status] }}>
                      {STATUS_LABEL[t.status]}
                    </span>
                  </button>
                ))}
              </div>

              {/* Tool detail */}
              {selectedTool && (
                <div className="insp-tool-detail">
                  <div className="insp-detail-header">
                    <span className="insp-detail-name">{selectedTool.name}</span>
                    <span
                      className="insp-detail-badge"
                      style={{
                        color: STATUS_COLOR[selectedTool.status],
                        background: `color-mix(in srgb, ${STATUS_COLOR[selectedTool.status]} 12%, transparent)`,
                      }}
                    >
                      {STATUS_LABEL[selectedTool.status]}
                    </span>
                  </div>
                  <Section title="Input">
                    <JsonBlock value={selectedTool.input} />
                  </Section>
                  <Section title={selectedTool.status === "err" ? "Result · error" : "Result"}>
                    <JsonBlock value={selectedTool.result} error={selectedTool.status === "err"} />
                  </Section>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Files tab ── */}
      {tab === "files" && (
        selectedFile ? (
          <FileViewer
            filePath={selectedFile}
            sessionId={session.session_id ?? ""}
            refreshKey={fileRefreshKey}
            onClose={() => setSelectedFile(null)}
          />
        ) : (
          <div className="flex-1 overflow-y-auto min-h-0">
            <div className="insp-file-toolbar">
              <div className="insp-file-filter" role="tablist" aria-label="Files filter">
                {([
                  ["all", "All", fileTabCount],
                  ["changes", "Changes", gitFiles.length],
                  ["files", "Files", files.length],
                ] as Array<[FilesFilter, string, number]>).map(([key, label, count]) => (
                  <button
                    key={key}
                    type="button"
                    className={`insp-file-filter-btn ${filesFilter === key ? "active" : ""}`}
                    onClick={() => setFilesFilter(key)}
                  >
                    {label}
                    <span>{count}</span>
                  </button>
                ))}
              </div>
              {hasExpandableDirs && (
                <div className="insp-file-tree-actions" aria-label="File tree controls">
                  <button type="button" onClick={expandVisibleDirs} disabled={allVisibleExpanded}>
                    Expand all
                  </button>
                  <button type="button" onClick={collapseVisibleDirs} disabled={allVisibleCollapsed}>
                    Collapse all
                  </button>
                </div>
              )}
            </div>
            {showGitChanges && (
              <Section title="Git changes">
                {gitChanges.status === "loading" ? (
                  <div className="insp-file-muted">Loading Git status...</div>
                ) : gitChanges.status === "error" ? (
                  <div className="insp-file-muted">{gitChanges.message}</div>
                ) : !gitChanges.isGitRepo ? (
                  <div className="insp-file-muted">{gitChanges.message ?? "No Git repository found."}</div>
                ) : gitChanges.files.length === 0 ? (
                  <div className="insp-file-muted">No local Git changes.</div>
                ) : (
                  <FileTree
                    root={gitTreeRoot}
                    treeId="git"
                    collapsedDirs={collapsedDirs}
                    onToggleDir={toggleDir}
                    onSelect={setSelectedFile}
                    selectedFile={selectedFile}
                  />
                )}
              </Section>
            )}
            {showFiles && (
              <Section title="Files">
                {files.length === 0 ? (
                  <div className="insp-empty">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-2 opacity-30">
                      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                      <polyline points="14 2 14 8 20 8"/>
                      <line x1="16" y1="13" x2="8" y2="13"/>
                      <line x1="16" y1="17" x2="8" y2="17"/>
                      <polyline points="10 9 9 9 8 9"/>
                    </svg>
                    No files found yet.
                  </div>
                ) : (
                  <FileTree
                    root={fileTreeRoot}
                    treeId="files"
                    collapsedDirs={collapsedDirs}
                    onToggleDir={toggleDir}
                    onSelect={setSelectedFile}
                    selectedFile={selectedFile}
                  />
                )}
              </Section>
            )}
          </div>
        )
      )}

      {/* ── Tokens tab ── */}
      {tab === "tokens" && (
        <div className="flex-1 overflow-y-auto min-h-0">
          <Section title="Usage">
            <div className="kv-stack">
              <KVRow label="Input" value={tokens.input.toLocaleString()} />
              <KVRow label="Output" value={tokens.output.toLocaleString()} />
              <KVRow label="Cache read" value={tokens.cacheRead.toLocaleString()} />
              <KVRow label="Cache write" value={tokens.cacheCreation.toLocaleString()} />
              <KVRow label="Total" value={tokens.total.toLocaleString()} />
            </div>
          </Section>
          {tokens.total > 0 && (
            <Section>
              <div className="insp-token-bar">
                {tokens.input > 0 && (
                  <div className="insp-token-seg" style={{ width: `${(tokens.input / tokens.total) * 100}%`, background: "var(--accent)" }} title={`Input: ${tokens.input.toLocaleString()}`} />
                )}
                {tokens.output > 0 && (
                  <div className="insp-token-seg" style={{ width: `${(tokens.output / tokens.total) * 100}%`, background: "var(--success)" }} title={`Output: ${tokens.output.toLocaleString()}`} />
                )}
                {tokens.cacheCreation > 0 && (
                  <div className="insp-token-seg" style={{ width: `${(tokens.cacheCreation / tokens.total) * 100}%`, background: "var(--warn)" }} title={`Cache write: ${tokens.cacheCreation.toLocaleString()}`} />
                )}
                {tokens.cacheRead > 0 && (
                  <div className="insp-token-seg" style={{ width: `${(tokens.cacheRead / tokens.total) * 100}%`, background: "color-mix(in srgb,var(--accent) 50%,transparent)" }} title={`Cache read: ${tokens.cacheRead.toLocaleString()}`} />
                )}
              </div>
              <div className="insp-token-legend">
                {[
                  { label: "Input", color: "var(--accent)", value: tokens.input },
                  { label: "Output", color: "var(--success)", value: tokens.output },
                  { label: "Cache write", color: "var(--warn)", value: tokens.cacheCreation },
                  { label: "Cache read", color: "color-mix(in srgb,var(--accent) 50%,transparent)", value: tokens.cacheRead },
                ].filter(({ value }) => value > 0).map(({ label, color }) => (
                  <div key={label} className="insp-legend-item">
                    <span className="insp-legend-dot" style={{ background: color }} />
                    <span>{label}</span>
                  </div>
                ))}
              </div>
              <div className="insp-cache-eff">
                Cache efficiency: <strong>{tokens.cacheEfficiency.toFixed(1)}%</strong>
              </div>
            </Section>
          )}
        </div>
      )}
    </aside>
  );
}
