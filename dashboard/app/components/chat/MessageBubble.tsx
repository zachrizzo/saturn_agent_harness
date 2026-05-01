"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Children, isValidElement, useEffect, useId, useMemo, useState } from "react";
import type { ReactNode } from "react";
import type { StreamEvent } from "@/lib/events";
import type { CLI } from "@/lib/runs";
import { formatReasoningEffort, type ModelReasoningEffort } from "@/lib/models";
import { toClaudeAlias } from "@/lib/claude-models";
import { CLI_SHORT_LABELS } from "@/lib/clis";
import { Portal } from "../Portal";
import { ToolInvocation } from "./ToolInvocation";
import { SubAgentCard } from "./SubAgentCard";

const MARKDOWN_PLUGINS = [remarkGfm];

type UserProps = {
  kind: "user";
  message: string;
  cli: CLI;
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  sessionId?: string;
  turnIndex?: number;
  editing?: boolean;
  onFork?: (message: string, turnIndex: number) => void;
  onEdit?: (message: string, turnIndex: number) => void;
};

type AssistantProps = {
  kind: "assistant";
  events: StreamEvent[];
  streaming?: boolean;
  liveActivity?: string;
  liveDetail?: string;
  sessionId?: string;
  hiddenMcpImageServers?: string[];
  onOpenFile?: (path: string) => void;
};

type Props = UserProps | AssistantProps;

export function MessageBubble(props: Props) {
  if (props.kind === "user") {
    return <UserBubble {...props} />;
  }
  return <AssistantBlock {...props} />;
}

function CopyButton({ getText }: { getText: () => string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(getText()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button
      type="button"
      onClick={copy}
      title="Copy"
      className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] text-muted hover:text-fg hover:bg-bg-hover transition-colors"
    >
      {copied ? (
        <svg className="w-3 h-3 text-success" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      )}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function UserBubble({ message, cli, model, reasoningEffort, sessionId, turnIndex, editing, onFork, onEdit }: UserProps) {
  const [hovered, setHovered] = useState(false);
  const mediaRefs = extractMediaRefsFromText(message);

  return (
    <div
      className="flex flex-col items-end gap-1"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Action bar — visible on hover */}
      <div
        className="flex items-center gap-0.5 px-1 py-0.5 rounded-lg border border-border transition-all duration-150"
        style={{
          background: "var(--bg-elev)",
          boxShadow: "var(--shadow-sm)",
          opacity: hovered ? 1 : 0,
          pointerEvents: hovered ? "auto" : "none",
          transform: hovered ? "translateY(0)" : "translateY(4px)",
        }}
      >
        <CopyButton getText={() => message} />
        {onEdit && (
          <button
            type="button"
            onClick={() => onEdit(message, turnIndex ?? 0)}
            title="Edit & resend"
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] text-muted hover:text-fg hover:bg-bg-hover transition-colors"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            Edit
          </button>
        )}
        {onFork && (
          <button
            type="button"
            onClick={() => onFork(message, turnIndex ?? 0)}
            title="Fork from here"
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] text-muted hover:text-fg hover:bg-bg-hover transition-colors"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
            </svg>
            Fork
          </button>
        )}
      </div>

      {/* Editing label above bubble */}
      {editing && (
        <div className="flex items-center gap-1 text-[10px] text-accent font-medium uppercase tracking-wider">
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
          editing from here
        </div>
      )}

      <div
        className="max-w-[85%] rounded-2xl rounded-tr-md px-3.5 py-2 text-[13px] transition-all duration-200"
        style={{
          background: "var(--user-bubble-bg)",
          color: "#fff",
          boxShadow: editing
            ? "0 0 0 2px var(--accent), 0 0 16px color-mix(in srgb, var(--accent) 30%, transparent)"
            : "var(--user-bubble-shadow)",
          opacity: editing ? 1 : undefined,
        }}
      >
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider mb-1" style={{ color: "rgba(255,255,255,0.6)" }}>
          <span>you</span>
          <span>·</span>
          <span>{CLI_SHORT_LABELS[cli]}</span>
          {model && (
            <>
              <span>·</span>
              <span className="mono truncate max-w-[160px]">{toClaudeAlias(model) ?? model}</span>
            </>
          )}
          {reasoningEffort && (
            <>
              <span>·</span>
              <span>{formatReasoningEffort(reasoningEffort)} effort</span>
            </>
          )}
        </div>
        <div className="whitespace-pre-wrap">{message}</div>
        <MediaPreviewGrid refs={mediaRefs} sessionId={sessionId} />
      </div>
    </div>
  );
}

const MEDIA_EXTENSIONS = [
  "avif",
  "bmp",
  "gif",
  "jpg",
  "jpeg",
  "png",
  "svg",
  "webp",
  "m4a",
  "mp3",
  "oga",
  "ogg",
  "wav",
  "webm",
  "mov",
  "mp4",
];

const MEDIA_EXTENSION_PATTERN = MEDIA_EXTENSIONS.join("|");

const FILE_REF_EXTENSIONS = [
  "avif", "bmp", "c", "clj", "cpp", "cs", "css", "csv", "cts", "doc", "docx",
  "ex", "exs", "fish", "gif", "go", "gql", "graphql", "h", "hpp", "hs",
  "htm", "html", "java", "jpeg", "jpg", "js", "json", "jsonc", "jsx", "kt",
  "less", "lua", "mjs", "md", "mdx", "ml", "mts", "pdf", "php", "png", "ppt",
  "pptx", "prisma", "ps1", "py", "r", "rb", "rs", "sass", "scala", "scss",
  "sh", "sql", "svg", "svelte", "swift", "toml", "ts", "tsx", "tsv", "txt",
  "vue", "webp", "xls", "xlsx", "xml", "yaml", "yml", "zsh",
];
const FILE_REF_EXTENSION_PATTERN = FILE_REF_EXTENSIONS.join("|");

function normalizeFileRef(value: string): string {
  return value.trim().replace(/^<|>$/g, "").replace(/[),.;:]+$/g, "");
}

function isExternalHref(value: string): boolean {
  return /^(https?:|mailto:|tel:|#|data:|blob:)/i.test(value);
}

function looksLikeFileRef(value: string): boolean {
  const cleaned = normalizeFileRef(value);
  if (!cleaned || /[\r\n]/.test(cleaned) || isExternalHref(cleaned)) return false;
  return new RegExp(`\\.(?:${FILE_REF_EXTENSION_PATTERN})(?:$|[?#])`, "i").test(cleaned);
}

function FileRefButton({
  path,
  children,
  onOpenFile,
}: {
  path: string;
  children: React.ReactNode;
  onOpenFile: (path: string) => void;
}) {
  const cleaned = normalizeFileRef(path);
  return (
    <button
      type="button"
      className="chat-file-ref"
      onClick={() => onOpenFile(cleaned)}
      title="Open in Files"
      aria-label={`Open ${cleaned} in Files`}
    >
      {children}
    </button>
  );
}

function isExternalMediaSrc(src: string): boolean {
  return /^(https?:|data:|blob:|\/api\/)/i.test(src);
}

function chatMediaSrc(src: string, sessionId?: string): string {
  if (!sessionId || isExternalMediaSrc(src)) return src;
  return `/api/sessions/${encodeURIComponent(sessionId)}/files?path=${encodeURIComponent(src)}`;
}

function markdownImageSources(text: string): Set<string> {
  const found = new Set<string>();
  const pattern = /!\[[^\]]*]\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/g;
  for (const match of text.matchAll(pattern)) {
    found.add(match[1]);
  }
  return found;
}

function normalizeMediaRef(src: string): string {
  return src.trim().replace(/[),.;:]+$/g, "");
}

function looksLikeMediaRef(value: string): boolean {
  const cleaned = normalizeMediaRef(value);
  if (/^data:/i.test(cleaned)) return cleaned.startsWith("data:image/") || cleaned.startsWith("data:video/") || cleaned.startsWith("data:audio/");
  return new RegExp(`\\.(?:${MEDIA_EXTENSION_PATTERN})(?:$|[?#])`, "i").test(cleaned);
}

function isRenderableMediaRef(value: string): boolean {
  const cleaned = normalizeMediaRef(value);
  if (!looksLikeMediaRef(cleaned) || /[\r\n]/.test(cleaned)) return false;
  if (!isExternalMediaSrc(cleaned)) {
    const extIndex = cleaned.search(new RegExp(`\\.(?:${MEDIA_EXTENSION_PATTERN})(?:$|[?#])`, "i"));
    const beforeExt = extIndex >= 0 ? cleaned.slice(0, extIndex) : cleaned;
    if (beforeExt.includes("?")) return false;
  }
  return true;
}

function extractMediaRefsFromText(text: string): string[] {
  const markdownSources = markdownImageSources(text);
  // Strip fenced code blocks and inline code so example paths inside ``` or ` don't match
  const stripped = text
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`\n]+`/g, "");
  const refs: string[] = [];
  const seen = new Set<string>();
  const addRef = (raw: string) => {
    const ref = normalizeMediaRef(raw);
    if (markdownSources.has(ref) || seen.has(ref)) return;
    if (!ref.startsWith("/") && Array.from(seen).some((existing) => existing.endsWith(ref))) return;
    seen.add(ref);
    refs.push(ref);
  };

  const localPattern = new RegExp(
    "(?:^|[\\s('\"])" +
      `((?:file:\\/\\/|~\\/|[$]HOME\\/|[$]CODEX_HOME\\/|\\/|\\.{1,2}\\/)[^'"<>\`)?\\r\\n]*?\\.(?:${MEDIA_EXTENSION_PATTERN})(?:[?#][^\\s'"<>\`)]*)?)` +
      "(?:$|[\\s)'\"`,.])",
    "gi",
  );
  for (const match of stripped.matchAll(localPattern)) {
    addRef(match[1]);
  }

  const strictPattern = new RegExp(
    "(?:^|[\\s('\"])" +
      `((?:https?:\\/\\/|data:|blob:|[A-Za-z0-9_.-]+\\/)[^\\s'"<>\`)]*\\.(?:${MEDIA_EXTENSION_PATTERN})(?:[?#][^\\s'"<>\`)]*)?)` +
      "(?:$|[\\s)'\"`,.])",
    "gi",
  );
  for (const match of stripped.matchAll(strictPattern)) {
    const ref = normalizeMediaRef(match[1]);
    if (Array.from(seen).some((existing) => existing.endsWith(ref))) continue;
    addRef(ref);
  }
  return refs;
}

function collectMediaRefs(value: unknown, refs = new Set<string>(), depth = 0): Set<string> {
  if (depth > 6 || value == null) return refs;
  if (typeof value === "string") {
    for (const ref of extractMediaRefsFromText(value)) refs.add(ref);
    const cleaned = normalizeMediaRef(value);
    if (looksLikeMediaRef(cleaned)) refs.add(cleaned);
    return refs;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectMediaRefs(item, refs, depth + 1);
    return refs;
  }
  if (typeof value === "object") {
    const rec = value as Record<string, unknown>;
    const mimeType = typeof rec.mimeType === "string" ? rec.mimeType : typeof rec.mime_type === "string" ? rec.mime_type : undefined;
    const data = typeof rec.data === "string" ? rec.data : undefined;
    if (data && mimeType && /^(image|video|audio)\//i.test(mimeType)) {
      refs.add(data.startsWith("data:") ? data : `data:${mimeType};base64,${data}`);
    }
    for (const item of Object.values(rec)) {
      collectMediaRefs(item, refs, depth + 1);
    }
  }
  return refs;
}

function mediaKind(src: string): "image" | "video" | "audio" {
  if (src.startsWith("data:video/")) return "video";
  if (src.startsWith("data:audio/")) return "audio";
  const ext = (src.match(/\.([a-z0-9]+)(?:[?#].*)?$/i)?.[1] ?? "").toLowerCase();
  if (["mp4", "mov", "webm"].includes(ext)) return "video";
  if (["m4a", "mp3", "oga", "ogg", "wav"].includes(ext)) return "audio";
  return "image";
}

function MediaPreview({ src, alt, sessionId }: { src: string; alt?: string; sessionId?: string }) {
  if (!isRenderableMediaRef(src)) return null;
  const resolvedSrc = chatMediaSrc(src, sessionId);
  const kind = mediaKind(src);
  if (kind === "video") {
    return (
      <video
        src={resolvedSrc}
        controls
        preload="metadata"
        className="max-h-[520px] max-w-full rounded-lg border border-border bg-black"
      />
    );
  }
  if (kind === "audio") {
    return <audio src={resolvedSrc} controls preload="metadata" className="w-full max-w-[520px]" />;
  }
  return (
    <a href={resolvedSrc} target="_blank" rel="noreferrer" className="block w-fit max-w-full">
      <img
        src={resolvedSrc}
        alt={alt ?? ""}
        loading="lazy"
        className="max-h-[520px] max-w-full rounded-lg border border-border object-contain"
      />
    </a>
  );
}

function MediaPreviewGrid({ refs, sessionId, className }: { refs: string[]; sessionId?: string; className?: string }) {
  if (refs.length === 0) return null;
  return (
    <div className={`mt-3 grid gap-3 ${className ?? ""}`.trim()}>
      {refs.map((src) => (
        <MediaPreview key={src} src={src} alt={src} sessionId={sessionId} />
      ))}
    </div>
  );
}

function mcpServerNameFromTool(ev: Extract<StreamEvent, { kind: "tool_use" }>): string | undefined {
  const raw = (ev.raw && typeof ev.raw === "object" ? ev.raw : {}) as Record<string, unknown>;
  const item = raw.item && typeof raw.item === "object" ? raw.item as Record<string, unknown> : {};
  if (typeof item.server === "string" && item.server.trim()) return item.server.trim();

  const claudeMatch = ev.name.match(/^mcp__(.+?)__.+/);
  if (claudeMatch) return claudeMatch[1];

  const dotMatch = ev.name.match(/^([^.\s]+)\.[^.\s]+$/);
  if (dotMatch) return dotMatch[1];

  return undefined;
}

function shouldHideMcpMedia(
  ev: Extract<StreamEvent, { kind: "tool_use" }>,
  hiddenMcpImageServers?: string[],
): boolean {
  if (!hiddenMcpImageServers || hiddenMcpImageServers.length === 0) return false;
  const server = mcpServerNameFromTool(ev);
  return Boolean(server && hiddenMcpImageServers.includes(server));
}

function LiveThinkingRow({ activity, detail }: { activity?: string; detail?: string }) {
  const statusParts = ["Thinking", activity, detail].filter(Boolean);

  return (
    <div
      className="live-thinking-row"
      role="status"
      aria-live="polite"
      aria-label={statusParts.join(", ")}
    >
      <span className="live-neural-field" aria-hidden="true">
        <svg className="live-neural-map" viewBox="0 0 120 58" preserveAspectRatio="xMidYMid meet">
          <g className="live-neural-layer layer-back">
            <path className="live-neural-axon axon-a" d="M6 33 C25 10 47 15 59 28 S87 50 115 27" />
            <path className="live-neural-axon axon-b" d="M14 46 C36 30 53 51 72 31 S95 8 114 36" />
          </g>
          <g className="live-neural-layer layer-front">
            <path className="live-neural-edge edge-1" d="M12 32 L31 18 L53 27 L72 12 L96 24 L112 39" />
            <path className="live-neural-edge edge-2" d="M20 45 L53 27 L66 46 L96 24" />
            <path className="live-neural-edge edge-3" d="M31 18 L44 7 L72 12" />
            <path className="live-neural-edge edge-4" d="M12 32 L20 45 L66 46 L112 39" />
            <circle className="live-neural-pulse pulse-a" r="2.8">
              <animateMotion dur="2.05s" repeatCount="indefinite" path="M12 32 L31 18 L53 27 L72 12 L96 24 L112 39" />
            </circle>
            <circle className="live-neural-pulse pulse-b" r="2.4">
              <animateMotion dur="2.7s" begin="-0.9s" repeatCount="indefinite" path="M20 45 L53 27 L66 46 L96 24" />
            </circle>
            <circle className="live-neural-pulse pulse-c" r="2.2">
              <animateMotion dur="2.45s" begin="-1.35s" repeatCount="indefinite" path="M112 39 L96 24 L72 12 L44 7 L31 18" />
            </circle>
            <circle className="live-neural-node node-a" cx="12" cy="32" r="3.8" />
            <circle className="live-neural-node node-b" cx="20" cy="45" r="3.2" />
            <circle className="live-neural-node node-c" cx="31" cy="18" r="4.1" />
            <circle className="live-neural-node node-d" cx="44" cy="7" r="2.9" />
            <circle className="live-neural-node node-e" cx="53" cy="27" r="4.4" />
            <circle className="live-neural-node node-f" cx="66" cy="46" r="3.2" />
            <circle className="live-neural-node node-g" cx="72" cy="12" r="3.7" />
            <circle className="live-neural-node node-h" cx="96" cy="24" r="4.1" />
            <circle className="live-neural-node node-i" cx="112" cy="39" r="3.5" />
          </g>
        </svg>
      </span>
      <span className="live-thinking-copy">
        <span className="live-thinking-label">Thinking</span>
        {activity && <span className="live-thinking-activity">{activity}</span>}
      </span>
      {detail && <span className="live-thinking-detail">{detail}</span>}
    </div>
  );
}

function PlanChecklist({ items }: { items: Extract<StreamEvent, { kind: "todo_list" }>["items"] }) {
  return (
    <div className="plan-checklist" aria-label="Plan">
      <div className="plan-checklist-title">Plan</div>
      <div className="plan-checklist-items">
        {items.map((item, index) => (
          <div key={`${index}-${item.text}`} className="plan-checklist-item">
            <span className={item.completed ? "plan-checklist-box done" : "plan-checklist-box"} aria-hidden="true">
              {item.completed ? "✓" : ""}
            </span>
            <span className={item.completed ? "plan-checklist-text done" : "plan-checklist-text"}>
              {item.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

type TextSegment = { kind: "text" | "plan"; text: string };

type MermaidTheme = "default" | "dark";
type MermaidSvgState = { cacheKey: string; svg: string };
type MermaidCacheEntry = {
  cacheId: string;
  svg?: string;
  promise?: Promise<string>;
};

const MERMAID_CACHE_LIMIT = 48;
const mermaidSvgCache = new Map<string, MermaidCacheEntry>();

function currentMermaidTheme(): MermaidTheme {
  if (typeof document === "undefined") return "default";
  return document.documentElement.dataset.theme === "dark" ? "dark" : "default";
}

function mermaidCacheKey(chart: string): string {
  return `${currentMermaidTheme()}\0${chart}`;
}

function mermaidThemeFromCacheKey(cacheKey: string): MermaidTheme {
  return cacheKey.startsWith("dark\0") ? "dark" : "default";
}

function hashMermaidKey(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function rememberMermaidEntry(cacheKey: string, entry: MermaidCacheEntry) {
  mermaidSvgCache.delete(cacheKey);
  mermaidSvgCache.set(cacheKey, entry);
  while (mermaidSvgCache.size > MERMAID_CACHE_LIMIT) {
    const oldest = mermaidSvgCache.keys().next().value;
    if (!oldest) break;
    mermaidSvgCache.delete(oldest);
  }
}

function materializeMermaidSvg(svg: string, cacheId: string, instanceId: string): string {
  return cacheId === instanceId ? svg : svg.split(cacheId).join(instanceId);
}

function cachedMermaidSvg(chart: string, instanceId: string, cacheKey = mermaidCacheKey(chart)): string | null {
  const entry = mermaidSvgCache.get(cacheKey);
  if (!entry?.svg) return null;
  rememberMermaidEntry(cacheKey, entry);
  return materializeMermaidSvg(entry.svg, entry.cacheId, instanceId);
}

async function renderMermaidSvg(
  chart: string,
  instanceId: string,
  cacheKey = mermaidCacheKey(chart),
): Promise<MermaidSvgState> {
  let entry = mermaidSvgCache.get(cacheKey);
  if (!entry) {
    entry = { cacheId: `saturn-mermaid-cache-${hashMermaidKey(cacheKey)}` };
    rememberMermaidEntry(cacheKey, entry);
  }

  if (entry.svg) {
    rememberMermaidEntry(cacheKey, entry);
    return {
      cacheKey,
      svg: materializeMermaidSvg(entry.svg, entry.cacheId, instanceId),
    };
  }

  if (!entry.promise) {
    const cacheId = entry.cacheId;
    const theme = mermaidThemeFromCacheKey(cacheKey);
    entry.promise = renderMermaidTemplate(chart, cacheId, theme)
      .then((svg) => {
        entry!.svg = svg;
        entry!.promise = undefined;
        rememberMermaidEntry(cacheKey, entry!);
        return svg;
      })
      .catch((err) => {
        entry!.promise = undefined;
        if (!entry!.svg) mermaidSvgCache.delete(cacheKey);
        throw err;
      });
  }

  const templateSvg = await entry.promise;
  return {
    cacheKey,
    svg: materializeMermaidSvg(templateSvg, entry.cacheId, instanceId),
  };
}

async function renderMermaidTemplate(chart: string, id: string, theme: MermaidTheme): Promise<string> {
  const mermaid = (await import("mermaid")).default;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme,
  });
  const result = await mermaid.render(id, chart);
  return result.svg;
}

function MermaidDiagram({ chart }: { chart: string }) {
  const renderId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const cacheKey = mermaidCacheKey(chart);
  const inlineInstanceId = `saturn-mermaid-${renderId}`;
  const modalInstanceId = `saturn-mermaid-${renderId}-expanded`;
  const [svgState, setSvgState] = useState<MermaidSvgState>(() => ({
    cacheKey,
    svg: cachedMermaidSvg(chart, inlineInstanceId, cacheKey) ?? "",
  }));
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [modalSvg, setModalSvg] = useState("");
  const [modalError, setModalError] = useState<string | null>(null);
  const svg = svgState.cacheKey === cacheKey
    ? svgState.svg
    : cachedMermaidSvg(chart, inlineInstanceId, cacheKey) ?? "";

  useEffect(() => {
    let cancelled = false;
    setError(null);
    const cachedSvg = cachedMermaidSvg(chart, inlineInstanceId, cacheKey);
    if (cachedSvg) {
      setSvgState({ cacheKey, svg: cachedSvg });
      return;
    }
    setSvgState({ cacheKey, svg: "" });

    async function renderMermaid() {
      try {
        const nextSvg = await renderMermaidSvg(chart, inlineInstanceId, cacheKey);
        if (!cancelled) setSvgState(nextSvg);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Unable to render Mermaid diagram.");
        }
      }
    }

    void renderMermaid();
    return () => {
      cancelled = true;
    };
  }, [cacheKey, chart, inlineInstanceId]);

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded]);

  useEffect(() => {
    if (!expanded) {
      setModalSvg("");
      setModalError(null);
      return;
    }

    let cancelled = false;
    setModalError(null);
    const cachedSvg = cachedMermaidSvg(chart, modalInstanceId, cacheKey);
    if (cachedSvg) {
      setModalSvg(cachedSvg);
      return;
    }
    setModalSvg("");

    async function renderExpandedMermaid() {
      try {
        const nextSvg = await renderMermaidSvg(chart, modalInstanceId, cacheKey);
        if (!cancelled) setModalSvg(nextSvg.svg);
      } catch (err) {
        if (!cancelled) {
          setModalError(err instanceof Error ? err.message : "Unable to render Mermaid diagram.");
        }
      }
    }

    void renderExpandedMermaid();
    return () => {
      cancelled = true;
    };
  }, [cacheKey, chart, expanded, modalInstanceId]);

  if (error) {
    return (
      <div className="mermaid-diagram mermaid-diagram-error">
        <div className="mermaid-diagram-error-title">Unable to render Mermaid diagram</div>
        <pre><code>{chart}</code></pre>
        <div className="mermaid-diagram-error-message">{error}</div>
      </div>
    );
  }

  if (!svg) {
    return <div className="mermaid-diagram mermaid-diagram-loading">Rendering diagram...</div>;
  }

  return (
    <>
      <div className="mermaid-diagram-shell">
        <button
          type="button"
          className="mermaid-expand-button"
          aria-label="Expand Mermaid map"
          title="Expand map"
          onClick={() => setExpanded(true)}
        >
          <IconExpand />
        </button>
        <div
          className="mermaid-diagram"
          aria-label="Mermaid diagram"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>

      {expanded && (
        <Portal>
          <div
            className="mermaid-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`mermaid-modal-title-${renderId}`}
          >
            <div
              className="mermaid-modal-backdrop"
              onClick={() => setExpanded(false)}
            />
            <div className="mermaid-modal-panel">
              <div className="mermaid-modal-header">
                <div id={`mermaid-modal-title-${renderId}`} className="mermaid-modal-title">
                  Mermaid map
                </div>
                <button
                  type="button"
                  className="mermaid-modal-close"
                  aria-label="Close Mermaid map"
                  title="Close"
                  onClick={() => setExpanded(false)}
                >
                  <IconClose />
                </button>
              </div>
              <div className="mermaid-modal-body">
                {modalError ? (
                  <div className="mermaid-diagram mermaid-diagram-error">
                    <div className="mermaid-diagram-error-title">Unable to render Mermaid diagram</div>
                    <pre><code>{chart}</code></pre>
                    <div className="mermaid-diagram-error-message">{modalError}</div>
                  </div>
                ) : modalSvg ? (
                  <div
                    className="mermaid-modal-diagram"
                    aria-label="Expanded Mermaid diagram"
                    dangerouslySetInnerHTML={{ __html: modalSvg }}
                  />
                ) : (
                  <div className="mermaid-diagram mermaid-diagram-loading">Rendering diagram...</div>
                )}
              </div>
            </div>
          </div>
        </Portal>
      )}
    </>
  );
}

function IconExpand() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 3H3v5" />
      <path d="M3 3l7 7" />
      <path d="M16 3h5v5" />
      <path d="M21 3l-7 7" />
      <path d="M8 21H3v-5" />
      <path d="M3 21l7-7" />
      <path d="M16 21h5v-5" />
      <path d="M21 21l-7-7" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 6l12 12M6 18 18 6" />
    </svg>
  );
}

function mermaidSourceFromPre(children: ReactNode): string | null {
  for (const child of Children.toArray(children)) {
    if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) continue;
    const className = child.props.className ?? "";
    const source = String(child.props.children ?? "").replace(/\n$/, "");
    if (/\blanguage-mermaid\b/i.test(className) || looksLikeMermaidSource(source)) return source;
  }
  return null;
}

function looksLikeMermaidSource(source: string): boolean {
  const firstLine = source.trimStart().split(/\r?\n/, 1)[0]?.trim() ?? "";
  return /^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|quadrantChart|requirementDiagram|C4Context|sankey-beta|block-beta|packet-beta|architecture-beta|xychart-beta)\b/i.test(firstLine);
}

function splitProposedPlanBlocks(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const pattern = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/gi;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    const before = text.slice(cursor, index);
    if (before.trim()) segments.push({ kind: "text", text: before });
    const plan = match[1] ?? "";
    if (plan.trim()) segments.push({ kind: "plan", text: plan.trim() });
    cursor = index + match[0].length;
  }
  const tail = text.slice(cursor);
  if (tail.trim()) segments.push({ kind: "text", text: tail });
  return segments.length > 0 ? segments : [{ kind: "text", text }];
}

function markdownComponents(sessionId?: string, onOpenFile?: (path: string) => void) {
  return {
    a: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => {
      const target = String(href ?? "");
      if (onOpenFile && target && looksLikeFileRef(target)) {
        return (
          <FileRefButton path={target} onOpenFile={onOpenFile}>
            {children}
          </FileRefButton>
        );
      }
      return <a href={href} {...props}>{children}</a>;
    },
    pre: ({ children, ...props }: React.HTMLAttributes<HTMLPreElement>) => {
      const mermaidSource = mermaidSourceFromPre(children);
      if (mermaidSource) return <MermaidDiagram chart={mermaidSource} />;
      return <pre {...props}>{children}</pre>;
    },
    code: ({ className, children, ...props }: React.HTMLAttributes<HTMLElement> & { className?: string }) => {
      const text = String(children).replace(/\n$/, "");
      const isBlock = Boolean(className) || text.includes("\n");
      if (!isBlock && onOpenFile && looksLikeFileRef(text)) {
        return (
          <FileRefButton path={text} onOpenFile={onOpenFile}>
            {text}
          </FileRefButton>
        );
      }
      return <code className={className} {...props}>{children}</code>;
    },
    img: ({ src, alt }: React.ImgHTMLAttributes<HTMLImageElement>) => (
      <MediaPreview src={String(src ?? "")} alt={alt ?? undefined} sessionId={sessionId} />
    ),
    // Use div instead of p when a paragraph contains only an image to avoid invalid HTML
    p: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => {
      const childArr = Array.isArray(children) ? children : [children];
      const hasImg = childArr.some((c) => c && typeof c === "object" && (c as React.ReactElement).type === "img");
      return hasImg ? <div {...(props as React.HTMLAttributes<HTMLDivElement>)}>{children}</div> : <p {...props}>{children}</p>;
    },
  };
}

function MarkdownArticle({
  text,
  sessionId,
  onOpenFile,
}: {
  text: string;
  sessionId?: string;
  onOpenFile?: (path: string) => void;
}) {
  const mediaRefs = extractMediaRefsFromText(text);
  const components = useMemo(() => markdownComponents(sessionId, onOpenFile), [sessionId, onOpenFile]);
  return (
    <article className="prose-dashboard leading-relaxed">
      <ReactMarkdown
        remarkPlugins={MARKDOWN_PLUGINS}
        components={components}
      >
        {text}
      </ReactMarkdown>
      <MediaPreviewGrid refs={mediaRefs} sessionId={sessionId} />
    </article>
  );
}

function PlanProposal({
  text,
  sessionId,
  onOpenFile,
}: {
  text: string;
  sessionId?: string;
  onOpenFile?: (path: string) => void;
}) {
  const components = useMemo(() => markdownComponents(sessionId, onOpenFile), [sessionId, onOpenFile]);
  return (
    <div className="plan-proposal" aria-label="Proposed plan">
      <div className="plan-proposal-title">Proposed plan</div>
      <div className="plan-proposal-body prose-dashboard">
        <ReactMarkdown
          remarkPlugins={MARKDOWN_PLUGINS}
          components={components}
        >
          {text}
        </ReactMarkdown>
      </div>
    </div>
  );
}

function AssistantBlock({
  events,
  streaming,
  liveActivity,
  liveDetail,
  sessionId,
  hiddenMcpImageServers,
  onOpenFile,
}: AssistantProps) {
  const [hovered, setHovered] = useState(false);

  // Collect all text for copy
  const allText = events
    .filter((ev) => ev.kind === "assistant_text" || ev.kind === "plan_text")
    .map((ev) => (ev as Extract<StreamEvent, { kind: "assistant_text" | "plan_text" }>).text)
    .join("\n\n");

  // Group sub-agent child events by their parentToolUseId
  const subEventsByParent = new Map<string, StreamEvent[]>();
  for (const ev of events) {
    const pid = (ev as { parentToolUseId?: string }).parentToolUseId;
    if (!pid) continue;
    if (!subEventsByParent.has(pid)) subEventsByParent.set(pid, []);
    subEventsByParent.get(pid)!.push(ev);
  }

  // Pair top-level (non-sub-agent) tool_use with tool_result
  const toolResults = new Map<string, Extract<StreamEvent, { kind: "tool_result" }>>();
  for (const ev of events) {
    if (ev.kind === "tool_result" && !(ev as { parentToolUseId?: string }).parentToolUseId) {
      toolResults.set(ev.toolUseId, ev);
    }
  }

  const rendered: React.ReactNode[] = [];
  let toolBuffer: React.ReactNode[] = [];
  const flushToolRow = () => {
    if (toolBuffer.length === 0) return;
    rendered.push(
      <div key={`tr-${rendered.length}`} className="tool-row">
        {toolBuffer}
      </div>
    );
    toolBuffer = [];
  };

  events.forEach((ev, i) => {
    // Skip sub-agent events — they're rendered inside SubAgentCard
    if ((ev as { parentToolUseId?: string }).parentToolUseId) return;
    const rawType = (ev.raw as { type?: string } | undefined)?.type;
    if (rawType === "saturn.turn_start") return;
    if (rawType === "saturn.turn_aborted") {
      flushToolRow();
      rendered.push(
        <div key={i} className="text-[12px] text-subtle italic">
          stopped before a reply completed
        </div>
      );
      return;
    }
    if (ev.kind === "tool_result") return;
    if (ev.kind === "todo_list") {
      flushToolRow();
      rendered.push(<PlanChecklist key={i} items={ev.items} />);
      return;
    }
    if (ev.kind === "tool_use") {
      const res = toolResults.get(ev.id);
      const mediaSet = collectMediaRefs(ev.input);
      collectMediaRefs(ev.raw, mediaSet);
      if (res) {
        collectMediaRefs(res.content, mediaSet);
        collectMediaRefs(res.raw, mediaSet);
      }
      const uniqueMediaRefs = shouldHideMcpMedia(ev, hiddenMcpImageServers) ? [] : Array.from(mediaSet);
      const isAgent = ev.name === "Agent";
      if (isAgent) {
        flushToolRow();
        const remaining = events.slice(i + 1);
        const isLast = remaining.every((e) => e.kind === "tool_result" || (e as { parentToolUseId?: string }).parentToolUseId);
        const status = !res ? "run" : res.isError ? "err" : "ok";
        rendered.push(
          <SubAgentCard
            key={i}
            id={ev.id}
            input={ev.input}
            result={res?.content}
            status={status}
            active={status === "run" && streaming && isLast}
            subEvents={subEventsByParent.get(ev.id)}
          />
        );
        if (uniqueMediaRefs.length > 0) {
          rendered.push(<MediaPreviewGrid key={`media-${i}`} refs={uniqueMediaRefs} sessionId={sessionId} />);
        }
        return;
      }
      if (uniqueMediaRefs.length > 0) {
        // Tool has media (e.g. screenshot) — flush current chip row first,
        // then render chip + image as a standalone full-width block.
        flushToolRow();
        rendered.push(
          <div key={i} className="tool-media-block">
            <ToolInvocation
              id={ev.id}
              name={ev.name}
              input={ev.input}
              result={res?.content}
              isError={Boolean(res?.isError)}
              hasResult={res !== undefined}
            />
            <MediaPreviewGrid refs={uniqueMediaRefs} sessionId={sessionId} className="mt-0" />
          </div>
        );
      } else {
        toolBuffer.push(
          <ToolInvocation
            key={i}
            id={ev.id}
            name={ev.name}
            input={ev.input}
            result={res?.content}
            isError={Boolean(res?.isError)}
            hasResult={res !== undefined}
          />
        );
      }
      return;
    }
    flushToolRow();
    if (ev.kind === "plan_text") {
      rendered.push(
        <PlanProposal key={i} text={ev.text} sessionId={sessionId} onOpenFile={onOpenFile} />
      );
      return;
    }
    if (ev.kind === "assistant_text") {
      const segments = splitProposedPlanBlocks(ev.text);
      rendered.push(
        <div key={i} className="assistant-text-stack">
          {segments.map((segment, index) => (
            segment.kind === "plan"
              ? (
                <PlanProposal
                  key={`${index}-plan`}
                  text={segment.text}
                  sessionId={sessionId}
                  onOpenFile={onOpenFile}
                />
              )
              : (
                <MarkdownArticle
                  key={`${index}-text`}
                  text={segment.text}
                  sessionId={sessionId}
                  onOpenFile={onOpenFile}
                />
              )
          ))}
        </div>
      );
      return;
    }
    if (ev.kind === "thinking") {
      rendered.push(
        <details key={i} className="text-[11px]">
          <summary className="cursor-pointer uppercase tracking-wider text-subtle">thinking</summary>
          <div className="whitespace-pre-wrap mt-1 text-muted italic">
            {ev.text || <span className="text-subtle">[redacted]</span>}
          </div>
        </details>
      );
      return;
    }
    if (ev.kind === "result") {
      rendered.push(
        <div key={i} className="flex items-center gap-3 text-[10px] text-subtle">
          <span className={ev.success ? "text-success" : "text-fail"}>
            {ev.success ? "✓ done" : "✗ failed"}
          </span>
          {ev.totalTokens > 0 && <span>{ev.totalTokens.toLocaleString()} tokens</span>}
        </div>
      );
    }
  });
  flushToolRow();

  if (rendered.length === 0 && streaming) {
    return (
      <div
        className="assistant-streaming-empty relative pl-4 border-l-2"
        style={{ borderLeftColor: "var(--accent)" }}
      >
        <LiveThinkingRow activity={liveActivity} detail={liveDetail} />
      </div>
    );
  }

  return (
    <div
      className={`relative pl-4 border-l-2 space-y-2 ${streaming ? "assistant-streaming" : ""}`.trim()}
      style={{ borderLeftColor: "var(--accent)" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {rendered}
      {streaming && (
        <LiveThinkingRow activity={liveActivity} detail={liveDetail} />
      )}
      {allText && (
        <div
          className="flex items-center gap-0.5 transition-all duration-150"
          style={{ opacity: hovered ? 1 : 0, pointerEvents: hovered ? "auto" : "none" }}
        >
          <CopyButton getText={() => allText} />
        </div>
      )}
    </div>
  );
}
