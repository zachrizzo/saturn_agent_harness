"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { IDisposable } from "@xterm/xterm";
import type { StreamEvent, TokenBreakdown } from "@/lib/events";
import type { SessionMeta } from "@/lib/runs";
import { projectNameFromPath, type TerminalListResponse, type TerminalRecord } from "@/lib/terminal-types";
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
  onInsertIntoComposer?: (text: string) => void;
  onClose?: () => void;
};

function sameInspectorTool(a: InspectorTool, b: InspectorTool): boolean {
  return a.id === b.id
    && a.name === b.name
    && a.status === b.status
    && a.startedAt === b.startedAt
    && a.input === b.input
    && a.result === b.result;
}

function useStableToolList(tools: InspectorTool[]): InspectorTool[] {
  const previousRef = useRef<{ tools: InspectorTool[]; byId: Map<string, InspectorTool> } | null>(null);

  return useMemo(() => {
    const previous = previousRef.current;
    if (!previous) {
      previousRef.current = { tools, byId: new Map(tools.map((tool) => [tool.id, tool])) };
      return tools;
    }

    let changed = previous.tools.length !== tools.length;
    const byId = new Map<string, InspectorTool>();
    const next = tools.map((tool, index) => {
      const previousTool = previous.tools[index]?.id === tool.id
        ? previous.tools[index]
        : previous.byId.get(tool.id);
      const stableTool = previousTool && sameInspectorTool(previousTool, tool)
        ? previousTool
        : tool;

      if (stableTool !== previous.tools[index]) changed = true;
      byId.set(stableTool.id, stableTool);
      return stableTool;
    });

    if (!changed) return previous.tools;

    previousRef.current = { tools: next, byId };
    return next;
  }, [tools]);
}

const INSPECTOR_TABS = [
  { key: "tool", label: "Tool" },
  { key: "terminal", label: "Terminal" },
  { key: "files", label: "Files" },
  { key: "web", label: "Web" },
  { key: "tokens", label: "Tokens" },
] as const;
type TabKey = typeof INSPECTOR_TABS[number]["key"];
type FilesFilter = "all" | "changes" | "files";

type WebAnnotation = {
  id: number;
  x: number;
  y: number;
  label: string;
  elementSelector?: string;
  elementTag?: string;
  elementText?: string;
  elementLabel?: string;
};

type WebElementDetails = Pick<WebAnnotation, "elementSelector" | "elementTag" | "elementText" | "elementLabel" | "label">;

type WebElementTarget = WebElementDetails & {
  box: {
    left: number;
    top: number;
    width: number;
    height: number;
  };
};

const TERMINAL_DETAIL_MIN_HEIGHT = 220;
const TERMINAL_LIST_MIN_HEIGHT = 140;
const INSPECTOR_TOP_OFFSET = 48;
const INSPECTOR_TAB_BAR_HEIGHT = 40;
const RUNNING_TOOL_LIST_LIMIT = 160;
const TERMINAL_TRANSCRIPT_MAX_CHARS = 250_000;

function terminalDetailMaxHeight(): number {
  if (typeof window === "undefined") return 520;
  return Math.max(
    TERMINAL_DETAIL_MIN_HEIGHT,
    window.innerHeight - INSPECTOR_TOP_OFFSET - INSPECTOR_TAB_BAR_HEIGHT - TERMINAL_LIST_MIN_HEIGHT,
  );
}

function terminalDetailDefaultHeight(): number {
  if (typeof window === "undefined") return 420;
  return Math.min(Math.round(window.innerHeight / 2), terminalDetailMaxHeight());
}

function clampTerminalDetailHeight(height: number): number {
  return Math.round(Math.min(terminalDetailMaxHeight(), Math.max(TERMINAL_DETAIL_MIN_HEIGHT, height)));
}

function terminalFontSizeForWidth(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return 11.5;
  const ratio = Math.min(1, Math.max(0, (width - 420) / 320));
  return Math.round((10 + ratio * 2) * 2) / 2;
}

function normalizeWebUrl(raw: string): { url?: string; error?: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { error: "Enter a URL." };
  if (trimmed.startsWith("/")) return { url: trimmed };

  let candidate = trimmed;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) {
    candidate = /^(localhost|127\.|0\.0\.0\.0|\[::1\]|::1)(?::|\/|$)/i.test(candidate)
      ? `http://${candidate}`
      : `https://${candidate}`;
  }

  try {
    const parsed = new URL(candidate, window.location.origin);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { error: "Use an http or https URL." };
    }
    return { url: parsed.toString() };
  } catch {
    return { error: "That URL does not look valid." };
  }
}

function compactWebAnnotationText(value: string | null | undefined, maxLength = 96): string {
  const compacted = (value ?? "").replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) return compacted;
  return `${compacted.slice(0, maxLength - 3).trimEnd()}...`;
}

function cssIdentifier(value: string): string {
  return globalThis.CSS?.escape?.(value) ?? value.replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}

function cssAttribute(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function selectorSegmentForElement(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const id = element.getAttribute("id");
  if (id) return `${tag}#${cssIdentifier(id)}`;

  const classes = Array.from(element.classList)
    .filter(Boolean)
    .slice(0, 3)
    .map((className) => `.${cssIdentifier(className)}`)
    .join("");
  if (classes) return `${tag}${classes}`;

  const ariaLabel = element.getAttribute("aria-label");
  if (ariaLabel) return `${tag}[aria-label="${cssAttribute(compactWebAnnotationText(ariaLabel, 48))}"]`;

  const parent = element.parentElement;
  if (!parent) return tag;
  const sameTagSiblings = Array.from(parent.children).filter((child) => child.tagName === element.tagName);
  if (sameTagSiblings.length <= 1) return tag;
  return `${tag}:nth-of-type(${sameTagSiblings.indexOf(element) + 1})`;
}

function selectorForWebElement(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;

  while (current && current.tagName.toLowerCase() !== "html" && parts.length < 4) {
    parts.unshift(selectorSegmentForElement(current));
    if (current.getAttribute("id")) break;
    current = current.parentElement;
  }

  return parts.join(" > ");
}

function percentBoxForWebElement(frame: HTMLIFrameElement, element: Element): WebElementTarget["box"] | null {
  const document = frame.contentDocument;
  if (!document) return null;

  const rect = element.getBoundingClientRect();
  const viewportWidth = frame.contentWindow?.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = frame.contentWindow?.innerHeight || document.documentElement.clientHeight;
  if (viewportWidth <= 0 || viewportHeight <= 0 || rect.width <= 0 || rect.height <= 0) return null;

  const left = Math.max(0, Math.min(viewportWidth, rect.left));
  const top = Math.max(0, Math.min(viewportHeight, rect.top));
  const right = Math.max(0, Math.min(viewportWidth, rect.right));
  const bottom = Math.max(0, Math.min(viewportHeight, rect.bottom));
  if (right <= left || bottom <= top) return null;

  return {
    left: (left / viewportWidth) * 100,
    top: (top / viewportHeight) * 100,
    width: ((right - left) / viewportWidth) * 100,
    height: ((bottom - top) / viewportHeight) * 100,
  };
}

function describeWebElementAtPoint(
  frame: HTMLIFrameElement | null,
  clientX: number,
  clientY: number,
): WebElementTarget | null {
  if (!frame) return null;

  try {
    const rect = frame.getBoundingClientRect();
    const document = frame.contentDocument;
    if (!document) return null;

    const element = document.elementFromPoint(clientX - rect.left, clientY - rect.top);
    if (!element || element === document.documentElement || element === document.body) return null;
    const box = percentBoxForWebElement(frame, element);
    if (!box) return null;

    const tag = element.tagName.toLowerCase();
    const htmlElement = element as HTMLElement;
    const accessibleLabel = compactWebAnnotationText(
      element.getAttribute("aria-label")
        ?? element.getAttribute("title")
        ?? element.getAttribute("alt")
        ?? element.getAttribute("name")
        ?? "",
      80,
    );
    const visibleText = compactWebAnnotationText(
      "innerText" in htmlElement ? htmlElement.innerText : element.textContent,
      110,
    );
    const label = accessibleLabel || visibleText || selectorSegmentForElement(element);

    return {
      elementSelector: selectorForWebElement(element),
      elementTag: tag,
      elementText: visibleText || undefined,
      elementLabel: accessibleLabel || undefined,
      label,
      box,
    };
  } catch {
    return null;
  }
}

function sameWebElementTarget(a: WebElementTarget | null, b: WebElementTarget | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.elementSelector !== b.elementSelector || a.label !== b.label) return false;
  return Math.abs(a.box.left - b.box.left) < 0.1
    && Math.abs(a.box.top - b.box.top) < 0.1
    && Math.abs(a.box.width - b.box.width) < 0.1
    && Math.abs(a.box.height - b.box.height) < 0.1;
}

function formatWebAnnotationForChat(url: string, annotation: WebAnnotation): string {
  const lines = [
    "Web annotation:",
    `- URL: ${url}`,
    `- Target: ${annotation.label || "Selected element"}`,
  ];

  if (annotation.elementSelector) lines.push(`- Selector: ${annotation.elementSelector}`);
  if (annotation.elementLabel) lines.push(`- Element label: ${annotation.elementLabel}`);
  if (annotation.elementText) lines.push(`- Element text: ${annotation.elementText}`);
  lines.push(`- Position: ${annotation.x.toFixed(1)}% x, ${annotation.y.toFixed(1)}% y`);

  return lines.join("\n");
}

function webAnnotationMeta(annotation: WebAnnotation): string {
  const parts = [
    annotation.elementSelector,
    annotation.elementLabel ? `label: ${annotation.elementLabel}` : null,
    annotation.elementText ? `text: ${annotation.elementText}` : null,
  ].filter(Boolean);

  return parts.join(" | ");
}

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

const TERMINAL_STATUS_LABEL: Record<TerminalRecord["status"], string> = {
  running: "running",
  success: "done",
  failed: "failed",
};

type TerminalStreamPayload =
  | { type: "data"; data: string }
  | { type: "meta"; terminal: TerminalRecord }
  | { type: "end"; terminal: TerminalRecord }
  | { type: "error"; message: string };

function isBashInspectorTool(tool: InspectorTool): boolean {
  const name = tool.name.toLowerCase();
  return name === "bash" || name.includes("bash");
}

function agentBashTerminalId(sessionId: string, toolUseId: string): string {
  const raw = `${sessionId}:${toolUseId}`;
  return `agent-bash-${btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

function terminalStatusFromTool(status: InspectorTool["status"]): TerminalRecord["status"] {
  if (status === "run") return "running";
  if (status === "err") return "failed";
  return "success";
}

function terminalStatusClass(status: TerminalRecord["status"]): string {
  if (status === "running") return "terminal-status running";
  if (status === "failed") return "terminal-status failed";
  return "terminal-status success";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function commandFromToolInput(input: unknown): string {
  if (typeof input === "string") return input;
  const rec = asRecord(input);
  for (const key of ["command", "cmd", "script"]) {
    const value = rec[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return toJsonString(input || {});
}

function terminalTitleFromCommand(command: string): string {
  const firstLine = command.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "Bash";
  return firstLine.length > 84 ? `${firstLine.slice(0, 81)}...` : firstLine;
}

type TerminalToolSession = {
  sessionId: string;
  cwd: string | null;
  startedAt: string;
  finishedAt?: string;
  latestTurnStartedAt: string;
  latestTurnFinishedAt: string;
};

function buildTerminalRecordFromTool(session: TerminalToolSession, tool: InspectorTool): TerminalRecord {
  const command = commandFromToolInput(tool.input);
  const cwd = session.cwd;
  const toolUpdatedAt = tool.status === "run" ? new Date().toISOString() : session.finishedAt;
  const updatedAt =
    session.latestTurnFinishedAt ||
    toolUpdatedAt ||
    session.latestTurnStartedAt ||
    session.startedAt;

  return {
    id: agentBashTerminalId(session.sessionId, tool.id),
    source: "agent-bash",
    readOnly: true,
    title: terminalTitleFromCommand(command),
    projectPath: cwd,
    projectName: projectNameFromPath(cwd),
    cwd,
    status: terminalStatusFromTool(tool.status),
    createdAt: tool.startedAt ?? (session.latestTurnStartedAt || session.startedAt),
    updatedAt,
    sessionId: session.sessionId,
    toolUseId: tool.id,
    command,
    exitCode: null,
    isError: tool.status === "err",
  };
}

function upsertTerminalRecord(list: TerminalRecord[], terminal: TerminalRecord): TerminalRecord[] {
  const next = list.some((item) => item.id === terminal.id)
    ? list.map((item) => item.id === terminal.id ? terminal : item)
    : [terminal, ...list];
  return next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function mergeTerminalRecords(...groups: TerminalRecord[][]): TerminalRecord[] {
  const byId = new Map<string, TerminalRecord>();
  for (const group of groups) {
    for (const terminal of group) {
      byId.set(terminal.id, { ...byId.get(terminal.id), ...terminal });
    }
  }
  return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function terminalSubtitle(terminal: TerminalRecord): string {
  if (terminal.source === "pty") return terminal.cwd ?? "Interactive shell";
  return terminal.command ?? "Agent Bash transcript";
}

function terminalKindLabel(terminal: TerminalRecord): string {
  return terminal.source === "pty" ? "shell" : "agent Bash";
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data as T;
}

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

const JsonBlock = memo(function JsonBlock({ value, error }: { value: unknown; error?: boolean }) {
  const text = value === undefined || value === null ? "" : toJsonString(value);
  if (!text) return <span className="text-[11px] text-subtle italic">—</span>;
  return (
    <pre className="json-block" style={error ? { color: "var(--fail)" } : {}}>
      {text}
    </pre>
  );
});

const ToolRow = memo(function ToolRow({
  id,
  name,
  status,
  active,
  onSelect,
}: {
  id: string;
  name: string;
  status: InspectorTool["status"];
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const handleSelect = useCallback(() => onSelect(id), [id, onSelect]);

  return (
    <button
      type="button"
      className={`insp-tool-row ${active ? "active" : ""}`}
      onClick={handleSelect}
    >
      <StatusDot status={status} />
      <span className="insp-tool-name">{name}</span>
      <span className="insp-tool-status" style={{ color: STATUS_COLOR[status] }}>
        {STATUS_LABEL[status]}
      </span>
    </button>
  );
}, (prev, next) => (
  prev.id === next.id
  && prev.name === next.name
  && prev.status === next.status
  && prev.active === next.active
  && prev.onSelect === next.onSelect
));

const ToolList = memo(function ToolList({
  tools,
  selectedId,
  hiddenToolCount,
  onSelect,
}: {
  tools: InspectorTool[];
  selectedId: string | null;
  hiddenToolCount: number;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="insp-tool-list">
      {hiddenToolCount > 0 && (
        <div className="insp-tool-row insp-tool-row-muted">
          <span className="insp-tool-name">
            {hiddenToolCount.toLocaleString()} older tools hidden while streaming
          </span>
        </div>
      )}
      {tools.map((tool) => (
        <ToolRow
          key={tool.id}
          id={tool.id}
          name={tool.name}
          status={tool.status}
          active={selectedId === tool.id}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
});

const ToolDetail = memo(function ToolDetail({
  tool,
  onViewTerminal,
}: {
  tool: InspectorTool;
  onViewTerminal: (toolId: string) => void;
}) {
  const isBashTool = isBashInspectorTool(tool);
  const handleViewTerminal = useCallback(() => onViewTerminal(tool.id), [onViewTerminal, tool.id]);

  return (
    <div className="insp-tool-detail">
      <div className="insp-detail-header">
        <span className="insp-detail-name">{tool.name}</span>
        <span
          className="insp-detail-badge"
          style={{
            color: STATUS_COLOR[tool.status],
            background: `color-mix(in srgb, ${STATUS_COLOR[tool.status]} 12%, transparent)`,
          }}
        >
          {STATUS_LABEL[tool.status]}
        </span>
        {isBashTool && (
          <button
            type="button"
            className="insp-terminal-link"
            onClick={handleViewTerminal}
          >
            View terminal
          </button>
        )}
      </div>
      <Section title="Input">
        <JsonBlock value={tool.input} />
      </Section>
      <Section title={tool.status === "err" ? "Result · error" : "Result"}>
        <JsonBlock value={tool.result} error={tool.status === "err"} />
      </Section>
    </div>
  );
}, (prev, next) => (
  prev.onViewTerminal === next.onViewTerminal
  && sameInspectorTool(prev.tool, next.tool)
));

const TerminalRow = memo(function TerminalRow({
  terminal,
  active,
  onSelect,
}: {
  terminal: TerminalRecord;
  active: boolean;
  onSelect: (id: string) => void;
}) {
  const handleSelect = useCallback(() => onSelect(terminal.id), [onSelect, terminal.id]);

  return (
    <button
      type="button"
      className={`insp-terminal-row ${active ? "active" : ""}`}
      onClick={handleSelect}
    >
      <span className="insp-terminal-row-title">{terminal.title}</span>
      <span className={terminalStatusClass(terminal.status)}>
        {TERMINAL_STATUS_LABEL[terminal.status]}
      </span>
      <span className="insp-terminal-row-subtitle">{terminalKindLabel(terminal)}</span>
    </button>
  );
}, (prev, next) => (
  prev.active === next.active
  && prev.onSelect === next.onSelect
  && prev.terminal.id === next.terminal.id
  && prev.terminal.title === next.terminal.title
  && prev.terminal.status === next.terminal.status
  && prev.terminal.source === next.terminal.source
));

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

const FileTreeNode = memo(function FileTreeNode({
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
}, (prev, next) => {
  if (
    prev.node !== next.node
    || prev.depth !== next.depth
    || prev.nodeKey !== next.nodeKey
    || prev.collapsedDirs !== next.collapsedDirs
    || prev.onToggleDir !== next.onToggleDir
    || prev.onSelect !== next.onSelect
  ) {
    return false;
  }
  if (prev.selectedFile === next.selectedFile) return true;
  if (prev.node.isDir) return false;

  const wasActive = prev.selectedFile === prev.node.fullPath;
  const isActive = next.selectedFile === next.node.fullPath;
  return wasActive === isActive;
});

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

export const Inspector = memo(function Inspector({
  session,
  activeTool,
  tools,
  tokens,
  events,
  width,
  onWidthChange,
  referencedFiles = [],
  fileOpenRequest,
  onInsertIntoComposer,
  onClose,
}: Props) {
  const [tab, setTab] = useState<TabKey>("tool");
  const [filesFilter, setFilesFilter] = useState<FilesFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const [gitChanges, setGitChanges] = useState<GitChangesState>({ status: "loading" });
  const [sessionTerminals, setSessionTerminals] = useState<TerminalRecord[]>([]);
  const [selectedTerminalId, setSelectedTerminalId] = useState<string | null>(null);
  const [terminalTranscript, setTerminalTranscript] = useState("");
  const [terminalStreamError, setTerminalStreamError] = useState<string | null>(null);
  const [terminalDetailHeight, setTerminalDetailHeight] = useState<number | null>(null);
  const [terminalDefaultCwd, setTerminalDefaultCwd] = useState<string | null>(null);
  const [creatingTerminal, setCreatingTerminal] = useState(false);
  const [terminalCreateError, setTerminalCreateError] = useState<string | null>(null);
  const [webDraftUrl, setWebDraftUrl] = useState("");
  const [webUrl, setWebUrl] = useState("");
  const [webError, setWebError] = useState<string | null>(null);
  const [webAnnotating, setWebAnnotating] = useState(false);
  const [webAnnotations, setWebAnnotations] = useState<WebAnnotation[]>([]);
  const [selectedWebAnnotationId, setSelectedWebAnnotationId] = useState<number | null>(null);
  const [webHoverTarget, setWebHoverTarget] = useState<WebElementTarget | null>(null);
  const webFrameRef = useRef<HTMLIFrameElement | null>(null);
  const xtermHostRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const xtermDataListenerRef = useRef<IDisposable | null>(null);
  const xtermResizeListenerRef = useRef<IDisposable | null>(null);
  const pendingPtyDataRef = useRef("");
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const latestTurn = session.turns.at(-1);
  const latestTurnStartedAt = latestTurn?.started_at ?? "";
  const latestTurnFinishedAt = latestTurn?.finished_at ?? "";
  const sessionCwd = session.agent_snapshot?.cwd?.trim() || null;
  const firstToolId = tools[0]?.id ?? null;
  const lastToolId = tools[tools.length - 1]?.id ?? null;
  const fileRefreshKey = `${tab === "files" ? events.length : 0}:${session.status}:${latestTurnFinishedAt}`;
  const visibleToolCandidates = useMemo(() => {
    if (session.status !== "running" || tools.length <= RUNNING_TOOL_LIST_LIMIT) return tools;
    const recent = tools.slice(-RUNNING_TOOL_LIST_LIMIT);
    if (!selectedId || recent.some((tool) => tool.id === selectedId)) return recent;
    const selected = tools.find((tool) => tool.id === selectedId);
    return selected ? [selected, ...recent] : recent;
  }, [session.status, selectedId, tools]);
  const visibleTools = useStableToolList(visibleToolCandidates);
  const hiddenToolCount = Math.max(0, tools.length - visibleTools.length);
  const selectToolId = useCallback((toolId: string) => {
    setSelectedId(toolId);
  }, []);
  const viewToolTerminal = useCallback((toolId: string) => {
    setSelectedTerminalId(agentBashTerminalId(session.session_id, toolId));
    setTab("terminal");
  }, [session.session_id]);
  const selectTerminalId = useCallback((terminalId: string) => {
    setSelectedTerminalId(terminalId);
  }, []);

  const startResize = (ev: ReactPointerEvent<HTMLButtonElement>) => {
    ev.preventDefault();
    resizeCleanupRef.current?.();
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
      resizeCleanupRef.current = null;
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    resizeCleanupRef.current = onUp;
  };

  const setClampedTerminalDetailHeight = (height: number) => {
    setTerminalDetailHeight(clampTerminalDetailHeight(height));
  };

  const startTerminalDetailResize = (ev: ReactPointerEvent<HTMLButtonElement>) => {
    ev.preventDefault();
    resizeCleanupRef.current?.();
    const startY = ev.clientY;
    const detailEl = ev.currentTarget.closest(".insp-terminal-detail") as HTMLElement | null;
    const startHeight = detailEl?.getBoundingClientRect().height
      ?? terminalDetailHeight
      ?? terminalDetailDefaultHeight();
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    const onMove = (moveEv: PointerEvent) => {
      setClampedTerminalDetailHeight(startHeight + startY - moveEv.clientY);
    };
    const onUp = () => {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      resizeCleanupRef.current = null;
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    resizeCleanupRef.current = onUp;
  };

  const nudgeTerminalDetailHeight = (delta: number) => {
    setTerminalDetailHeight((current) => clampTerminalDetailHeight((current ?? terminalDetailDefaultHeight()) + delta));
  };

  useEffect(() => {
    return () => {
      resizeCleanupRef.current?.();
      resizeCleanupRef.current = null;
    };
  }, []);

  const openWebUrl = (ev?: FormEvent<HTMLFormElement>) => {
    ev?.preventDefault();
    const normalized = normalizeWebUrl(webDraftUrl);
    if (normalized.error || !normalized.url) {
      setWebError(normalized.error ?? "Could not open that URL.");
      return;
    }
    setWebError(null);
    setWebUrl(normalized.url);
    setWebAnnotations([]);
    setSelectedWebAnnotationId(null);
  };

  const addWebAnnotation = (ev: ReactMouseEvent<HTMLDivElement>) => {
    if (!webAnnotating) return;
    const rect = ev.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const id = Date.now();
    const x = Math.min(100, Math.max(0, ((ev.clientX - rect.left) / rect.width) * 100));
    const y = Math.min(100, Math.max(0, ((ev.clientY - rect.top) / rect.height) * 100));
    const elementTarget = describeWebElementAtPoint(webFrameRef.current, ev.clientX, ev.clientY);
    const elementDetails: WebElementDetails | null = elementTarget
      ? {
          elementSelector: elementTarget.elementSelector,
          elementTag: elementTarget.elementTag,
          elementText: elementTarget.elementText,
          elementLabel: elementTarget.elementLabel,
          label: elementTarget.label,
        }
      : null;

    setWebAnnotations((current) => [
      ...current,
      {
        id,
        x,
        y,
        label: elementDetails?.label || `Annotation ${current.length + 1}`,
        ...elementDetails,
      },
    ]);
    setSelectedWebAnnotationId(id);
  };

  const updateWebHoverTarget = (ev: ReactMouseEvent<HTMLDivElement>) => {
    if (!webAnnotating) return;
    const next = describeWebElementAtPoint(webFrameRef.current, ev.clientX, ev.clientY);
    setWebHoverTarget((current) => sameWebElementTarget(current, next) ? current : next);
  };

  const clearWebHoverTarget = () => {
    setWebHoverTarget(null);
  };

  const updateWebAnnotationLabel = (id: number, label: string) => {
    setWebAnnotations((current) => current.map((annotation) => (
      annotation.id === id ? { ...annotation, label } : annotation
    )));
  };

  const removeWebAnnotation = (id: number) => {
    setWebAnnotations((current) => current.filter((annotation) => annotation.id !== id));
    setSelectedWebAnnotationId((current) => current === id ? null : current);
  };

  const addWebAnnotationToComposer = (annotation: WebAnnotation) => {
    if (!webUrl) return;
    onInsertIntoComposer?.(formatWebAnnotationForChat(webUrl, annotation));
  };

  useEffect(() => {
    if (!webAnnotating || !webUrl) setWebHoverTarget(null);
  }, [webAnnotating, webUrl]);

  // Sync selected tool when parent selects one (chip click)
  useEffect(() => {
    if (activeTool) {
      setSelectedId(activeTool.id);
      setTab("tool");
      if (isBashInspectorTool(activeTool)) {
        setSelectedTerminalId(agentBashTerminalId(session.session_id, activeTool.id));
      }
    }
  }, [activeTool?.id, session.session_id]);

  // Auto-select first tool when switching to tool tab
  useEffect(() => {
    if (tab === "tool" && !selectedId) {
      const nextId = session.status === "running" ? lastToolId : firstToolId;
      if (nextId) setSelectedId(nextId);
    }
  }, [firstToolId, lastToolId, session.status, tab, selectedId]);

  const selectedTool = useMemo(
    () => (
      selectedId
        ? visibleTools.find((tool) => tool.id === selectedId) ?? activeTool ?? null
        : activeTool ?? null
    ),
    [visibleTools, selectedId, activeTool],
  );

  const toolTerminals = useMemo(
    () => visibleTools
      .filter(isBashInspectorTool)
      .map((tool) => buildTerminalRecordFromTool({
        sessionId: session.session_id,
        cwd: sessionCwd,
        startedAt: session.started_at,
        finishedAt: session.finished_at,
        latestTurnStartedAt,
        latestTurnFinishedAt,
      }, tool)),
    [
      session.session_id,
      session.started_at,
      session.finished_at,
      sessionCwd,
      latestTurnStartedAt,
      latestTurnFinishedAt,
      visibleTools,
    ],
  );
  const relatedTerminals = useMemo(
    () => mergeTerminalRecords(sessionTerminals, toolTerminals),
    [sessionTerminals, toolTerminals],
  );
  const selectedTerminal = useMemo(
    () => relatedTerminals.find((terminal) => terminal.id === selectedTerminalId) ?? relatedTerminals[0] ?? null,
    [relatedTerminals, selectedTerminalId],
  );
  const terminalCwd = sessionCwd || terminalDefaultCwd || "";

  useEffect(() => {
    setSelectedTerminalId((current) => {
      if (current && relatedTerminals.some((terminal) => terminal.id === current)) return current;
      return relatedTerminals[0]?.id ?? null;
    });
  }, [relatedTerminals]);

  useEffect(() => {
    let cancelled = false;

    const loadTerminals = async () => {
      try {
        const data = await fetchJson<TerminalListResponse>(
          `/api/terminals?sessionId=${encodeURIComponent(session.session_id)}`,
          { cache: "no-store" },
        );
        if (!cancelled) {
          setSessionTerminals(data.terminals ?? []);
          setTerminalDefaultCwd(data.defaultCwd);
        }
      } catch {
        if (!cancelled) setSessionTerminals([]);
      }
    };

    void loadTerminals();
    const timer = window.setInterval(() => {
      void loadTerminals();
    }, session.status === "running" ? 2500 : 8000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [session.session_id, session.status]);

  const createInspectorTerminal = async () => {
    const cwd = terminalCwd.trim();
    if (!cwd) {
      setTerminalCreateError("No working directory is available for this chat.");
      return;
    }

    setCreatingTerminal(true);
    setTerminalCreateError(null);
    try {
      const data = await fetchJson<{ terminal: TerminalRecord }>("/api/terminals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cwd,
          cols: 88,
          rows: 20,
          title: "Chat shell",
          sessionId: session.session_id,
        }),
      });
      setSessionTerminals((current) => upsertTerminalRecord(current, data.terminal));
      setSelectedTerminalId(data.terminal.id);
      setTab("terminal");
    } catch (err) {
      setTerminalCreateError(err instanceof Error ? err.message : "Failed to create terminal.");
    } finally {
      setCreatingTerminal(false);
    }
  };

  const closeSelectedTerminal = async () => {
    if (!selectedTerminal || selectedTerminal.source !== "pty") return;
    try {
      const data = await fetchJson<{ terminal: TerminalRecord }>(
        `/api/terminals/${encodeURIComponent(selectedTerminal.id)}`,
        { method: "DELETE" },
      );
      setSessionTerminals((current) => current.filter((terminal) => terminal.id !== data.terminal.id));
      setSelectedTerminalId((current) => current === data.terminal.id ? null : current);
    } catch (err) {
      setTerminalStreamError(err instanceof Error ? err.message : "Failed to close terminal.");
    }
  };

  useEffect(() => {
    xtermDataListenerRef.current?.dispose();
    xtermResizeListenerRef.current?.dispose();
    xtermRef.current?.dispose();
    xtermDataListenerRef.current = null;
    xtermResizeListenerRef.current = null;
    xtermRef.current = null;
    fitAddonRef.current = null;

    if (!selectedTerminal || selectedTerminal.source !== "pty" || !xtermHostRef.current) return;

    const term = new XTerm({
      cursorBlink: selectedTerminal.status === "running",
      convertEol: true,
      fontFamily: "var(--font-geist-mono), ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 11.5,
      lineHeight: 1.18,
      theme: {
        background: "#0b1114",
        foreground: "#d5e5e0",
        cursor: "#6ee7b7",
        selectionBackground: "#2a4b54",
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(xtermHostRef.current);
    term.focus();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;
    if (pendingPtyDataRef.current) {
      term.write(pendingPtyDataRef.current);
      pendingPtyDataRef.current = "";
    }

    let lastSentCols = 0;
    let lastSentRows = 0;
    let resizeFrame: number | null = null;
    const host = xtermHostRef.current;

    const postResize = () => {
      const dims = fitAddon.proposeDimensions();
      if (!dims) return;
      if (dims.cols === lastSentCols && dims.rows === lastSentRows) return;
      lastSentCols = dims.cols;
      lastSentRows = dims.rows;
      fetch(`/api/terminals/${encodeURIComponent(selectedTerminal.id)}/resize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cols: dims.cols, rows: dims.rows }),
      }).catch(() => {});
    };

    const fitAndResize = () => {
      resizeFrame = null;
      if (!host || host.clientWidth <= 0 || host.clientHeight <= 0) return;
      const nextFontSize = terminalFontSizeForWidth(host.clientWidth);
      if (term.options.fontSize !== nextFontSize) {
        term.options.fontSize = nextFontSize;
      }
      try {
        fitAddon.fit();
        term.refresh(0, Math.max(0, term.rows - 1));
      } catch {
        return;
      }
      postResize();
    };

    const scheduleFitAndResize = () => {
      if (resizeFrame !== null) return;
      resizeFrame = window.requestAnimationFrame(fitAndResize);
    };

    xtermDataListenerRef.current = term.onData((data) => {
      fetch(`/api/terminals/${encodeURIComponent(selectedTerminal.id)}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data }),
      }).catch(() => {});
    });
    xtermResizeListenerRef.current = term.onResize(({ cols, rows }) => {
      if (cols === lastSentCols && rows === lastSentRows) return;
      lastSentCols = cols;
      lastSentRows = rows;
      fetch(`/api/terminals/${encodeURIComponent(selectedTerminal.id)}/resize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cols, rows }),
      }).catch(() => {});
    });

    const resizeObserver = new ResizeObserver(scheduleFitAndResize);
    if (host) {
      resizeObserver.observe(host);
      if (host.parentElement) resizeObserver.observe(host.parentElement);
    }
    document.fonts?.ready.then(scheduleFitAndResize).catch(() => {});
    scheduleFitAndResize();
    window.addEventListener("resize", scheduleFitAndResize);

    return () => {
      window.removeEventListener("resize", scheduleFitAndResize);
      resizeObserver.disconnect();
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      xtermDataListenerRef.current?.dispose();
      xtermResizeListenerRef.current?.dispose();
      term.dispose();
      xtermDataListenerRef.current = null;
      xtermResizeListenerRef.current = null;
      if (xtermRef.current === term) xtermRef.current = null;
      if (fitAddonRef.current === fitAddon) fitAddonRef.current = null;
    };
  }, [selectedTerminal?.id, selectedTerminal?.source]);

  useEffect(() => {
    if (selectedTerminal?.source !== "pty" || !fitAddonRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      fitAddonRef.current?.fit();
      const dims = fitAddonRef.current?.proposeDimensions();
      if (!dims) return;
      fetch(`/api/terminals/${encodeURIComponent(selectedTerminal.id)}/resize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cols: dims.cols, rows: dims.rows }),
      }).catch(() => {});
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedTerminal?.id, selectedTerminal?.source, terminalDetailHeight]);

  useEffect(() => {
    if (!selectedTerminal) {
      setTerminalTranscript("");
      setTerminalStreamError(null);
      pendingPtyDataRef.current = "";
      return;
    }

    setTerminalTranscript("");
    setTerminalStreamError(null);
    pendingPtyDataRef.current = "";
    const source = new EventSource(`/api/terminals/${encodeURIComponent(selectedTerminal.id)}/stream`);
    source.onmessage = (event) => {
      const payload = JSON.parse(event.data) as TerminalStreamPayload;
      if (payload.type === "data") {
        if (selectedTerminal.source === "pty") {
          if (xtermRef.current) xtermRef.current.write(payload.data);
          else pendingPtyDataRef.current += payload.data;
        } else {
          setTerminalTranscript((current) => {
            const next = current + payload.data;
            return next.length > TERMINAL_TRANSCRIPT_MAX_CHARS
              ? next.slice(next.length - TERMINAL_TRANSCRIPT_MAX_CHARS)
              : next;
          });
        }
      } else if (payload.type === "meta" || payload.type === "end") {
        setSessionTerminals((current) => upsertTerminalRecord(current, payload.terminal));
      } else if (payload.type === "error") {
        setTerminalStreamError(payload.message);
      }
    };
    source.onerror = () => {
      source.close();
    };

    return () => source.close();
  }, [selectedTerminal?.id, selectedTerminal?.source]);

  const files = useMemo(
    () => {
      if (session.status === "running" && tab !== "files") return referencedFiles;
      return collectInspectableFiles(tools, events, session, referencedFiles);
    },
    [tools, events, session, referencedFiles, tab],
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
  }, [latestTurnFinishedAt, session.session_id, session.status]);

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
  const toggleDir = useCallback((key: string) => {
    setCollapsedDirs((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const expandVisibleDirs = useCallback(() => {
    setCollapsedDirs((current) => {
      const next = new Set(current);
      for (const key of visibleDirKeys) next.delete(key);
      return next;
    });
  }, [visibleDirKeys]);
  const collapseVisibleDirs = useCallback(() => {
    setCollapsedDirs((current) => new Set([...current, ...visibleDirKeys]));
  }, [visibleDirKeys]);
  return (
    <aside className="inspector" style={{ width }}>
      <button
        type="button"
        className="inspector-resizer"
        onPointerDown={startResize}
        aria-label="Resize document panel"
        title="Resize panel"
      />
      {onClose && (
        <button
          type="button"
          className="inspector-mobile-close"
          onClick={onClose}
          aria-label="Close inspector panel"
          title="Close panel"
        >
          ×
        </button>
      )}
      {/* Tab bar */}
      <div className="tab-bar">
        {INSPECTOR_TABS.map(({ key, label }) => {
          const badge =
            key === "tool" ? tools.length :
            key === "terminal" ? relatedTerminals.length :
            key === "files" ? fileTabCount :
            null;
          return (
            <button
              key={key}
              type="button"
              className={`tab ${tab === key ? "active" : ""}`}
              onClick={() => setTab(key)}
            >
              {label}
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
              <ToolList
                tools={visibleTools}
                selectedId={selectedId}
                hiddenToolCount={hiddenToolCount}
                onSelect={selectToolId}
              />

              {/* Tool detail */}
              {selectedTool && (
                <ToolDetail tool={selectedTool} onViewTerminal={viewToolTerminal} />
              )}
            </>
          )}
        </div>
      )}

      {/* ── Terminal tab ── */}
      {tab === "terminal" && (
        <div className="insp-terminal-pane">
          <div className="insp-terminal-create">
            <button
              type="button"
              className="terminal-primary-button"
              onClick={createInspectorTerminal}
              disabled={creatingTerminal || !terminalCwd}
            >
              {creatingTerminal ? "Starting..." : "New terminal"}
            </button>
            <span className="insp-terminal-cwd" title={terminalCwd || undefined}>
              {terminalCwd || "No working directory"}
            </span>
          </div>
          {terminalCreateError && (
            <div className="terminal-stream-error">{terminalCreateError}</div>
          )}
          {relatedTerminals.length === 0 ? (
            <div className="insp-empty">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-2 opacity-30">
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" y1="19" x2="20" y2="19" />
              </svg>
              No terminals for this chat yet.
            </div>
          ) : (
            <>
              <div className="insp-terminal-list">
                {relatedTerminals.map((terminal) => (
                  <TerminalRow
                    key={terminal.id}
                    terminal={terminal}
                    active={selectedTerminal?.id === terminal.id}
                    onSelect={selectTerminalId}
                  />
                ))}
              </div>

              {selectedTerminal && (
                <div
                  className="insp-terminal-detail"
                  style={terminalDetailHeight
                    ? ({ "--terminal-detail-height": `${terminalDetailHeight}px` } as CSSProperties)
                    : undefined}
                >
                  <button
                    type="button"
                    className="insp-terminal-detail-resizer"
                    onPointerDown={startTerminalDetailResize}
                    onKeyDown={(ev) => {
                      if (ev.key === "ArrowUp") {
                        ev.preventDefault();
                        nudgeTerminalDetailHeight(32);
                      } else if (ev.key === "ArrowDown") {
                        ev.preventDefault();
                        nudgeTerminalDetailHeight(-32);
                      } else if (ev.key === "Home") {
                        ev.preventDefault();
                        setClampedTerminalDetailHeight(TERMINAL_DETAIL_MIN_HEIGHT);
                      } else if (ev.key === "End") {
                        ev.preventDefault();
                        setClampedTerminalDetailHeight(terminalDetailMaxHeight());
                      }
                    }}
                    aria-label="Resize terminal transcript panel"
                    title="Resize terminal panel"
                  />
                  <div className="insp-terminal-header">
                    <div className="insp-terminal-title">
                      <span>{selectedTerminal.title}</span>
                      <small title={terminalSubtitle(selectedTerminal)}>{terminalSubtitle(selectedTerminal)}</small>
                    </div>
                    <a
                      className="insp-terminal-link"
                      href={`/terminals?terminal=${encodeURIComponent(selectedTerminal.id)}`}
                    >
                      Full page
                    </a>
                    {selectedTerminal.source === "pty" && (
                      <button
                        type="button"
                        className="insp-terminal-link danger"
                        onClick={closeSelectedTerminal}
                      >
                        Close
                      </button>
                    )}
                  </div>
                  {terminalStreamError && (
                    <div className="terminal-stream-error">{terminalStreamError}</div>
                  )}
                  {selectedTerminal.source === "pty" ? (
                    <div className="insp-terminal-xterm-shell">
                      <div ref={xtermHostRef} className="insp-terminal-xterm-host" />
                    </div>
                  ) : (
                    <pre className="insp-terminal-transcript" aria-label="Chat terminal transcript">
                      {terminalTranscript || "$ loading transcript...\n"}
                    </pre>
                  )}
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

      {/* ── Web tab ── */}
      {tab === "web" && (
        <div className="insp-web-pane">
          <form className="insp-web-toolbar" onSubmit={openWebUrl}>
            <input
              className="insp-web-url"
              value={webDraftUrl}
              onChange={(ev) => setWebDraftUrl(ev.target.value)}
              placeholder="https://example.com"
              aria-label="Website URL"
            />
            <button type="submit" className="insp-web-button">
              Open
            </button>
            <button
              type="button"
              className={`insp-web-button ${webAnnotating ? "active" : ""}`}
              onClick={() => setWebAnnotating((value) => !value)}
              disabled={!webUrl}
            >
              Annotate
            </button>
          </form>
          {webError && <div className="insp-web-error">{webError}</div>}
          <div className="insp-web-stage">
            {webUrl ? (
              <>
                <iframe
                  key={webUrl}
                  ref={webFrameRef}
                  className="insp-web-frame"
                  src={webUrl}
                  title="Website preview"
                  sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
                  referrerPolicy="no-referrer"
                />
                <div
                  className={`insp-web-annotation-layer ${webAnnotating ? "active" : ""}`}
                  onClick={addWebAnnotation}
                  onMouseMove={updateWebHoverTarget}
                  onMouseLeave={clearWebHoverTarget}
                  aria-label="Website annotation layer"
                >
                  {webHoverTarget && (
                    <div
                      className="insp-web-hover-target"
                      style={{
                        left: `${webHoverTarget.box.left}%`,
                        top: `${webHoverTarget.box.top}%`,
                        width: `${webHoverTarget.box.width}%`,
                        height: `${webHoverTarget.box.height}%`,
                      }}
                    >
                      <span>{webHoverTarget.label}</span>
                    </div>
                  )}
                  {webAnnotations.map((annotation, index) => (
                    <button
                      key={annotation.id}
                      type="button"
                      className={`insp-web-pin ${selectedWebAnnotationId === annotation.id ? "selected" : ""}`}
                      style={{ left: `${annotation.x}%`, top: `${annotation.y}%` }}
                      onClick={(ev) => {
                        ev.stopPropagation();
                        setSelectedWebAnnotationId(annotation.id);
                      }}
                      title={annotation.label}
                    >
                      {index + 1}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div className="insp-web-empty">
                <span>Open a URL to preview it here.</span>
              </div>
            )}
          </div>
          {webUrl && (
            <div className="insp-web-footer">
              <a href={webUrl} target="_blank" rel="noreferrer" className="insp-web-open-link">
                Open in browser
              </a>
              <span className="insp-web-note">Some sites block embedded previews.</span>
            </div>
          )}
          {webAnnotations.length > 0 && (
            <div className="insp-web-annotations">
              {webAnnotations.map((annotation, index) => {
                const meta = webAnnotationMeta(annotation);

                return (
                  <div
                    key={annotation.id}
                    className={`insp-web-annotation-row ${selectedWebAnnotationId === annotation.id ? "selected" : ""}`}
                  >
                    <button
                      type="button"
                      className="insp-web-annotation-index"
                      onClick={() => setSelectedWebAnnotationId(annotation.id)}
                      aria-label={`Select annotation ${index + 1}`}
                    >
                      {index + 1}
                    </button>
                    <input
                      className="insp-web-annotation-label"
                      value={annotation.label}
                      onChange={(ev) => updateWebAnnotationLabel(annotation.id, ev.target.value)}
                      aria-label={`Annotation ${index + 1} label`}
                    />
                    <button
                      type="button"
                      className="insp-web-annotation-action"
                      onClick={() => addWebAnnotationToComposer(annotation)}
                    >
                      Add to chat
                    </button>
                    <button
                      type="button"
                      className="insp-web-annotation-remove"
                      onClick={() => removeWebAnnotation(annotation.id)}
                      aria-label={`Remove annotation ${index + 1}`}
                      title="Remove"
                    >
                      ×
                    </button>
                    {meta && <div className="insp-web-annotation-meta">{meta}</div>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
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
});
