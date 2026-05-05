"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Children, isValidElement, memo, useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { StreamEvent } from "@/lib/events";
import type { CLI } from "@/lib/runs";
import { formatReasoningEffort, type ModelReasoningEffort } from "@/lib/models";
import { toClaudeAlias } from "@/lib/claude-models";
import { CLI_SHORT_LABELS } from "@/lib/clis";
import { Button } from "@/app/components/ui";
import { Portal } from "../Portal";
import { ToolInvocation } from "./ToolInvocation";
import { SubAgentCard } from "./SubAgentCard";

const MARKDOWN_PLUGINS = [remarkGfm];
const STREAMING_EVENT_RENDER_LIMIT = 96;

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
  onRunSubAgentInBackground?: (id: string, title: string) => void;
  backgroundSubAgentIds?: Set<string>;
  onBedrockAuthReady?: () => Promise<void> | void;
};

type Props = UserProps | AssistantProps;

type SaturnFailureInfo = {
  phase: string;
  exitCode: number | null;
  stderrTail: string | null;
};

function extractSaturnFailure(raw: unknown): SaturnFailureInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const failure = (raw as Record<string, unknown>).saturn_failure;
  if (!failure || typeof failure !== "object") return null;
  const f = failure as Record<string, unknown>;
  return {
    phase: typeof f.phase === "string" && f.phase ? f.phase : "cli",
    exitCode: typeof f.exit_code === "number" ? f.exit_code : null,
    stderrTail: typeof f.stderr_tail === "string" ? f.stderr_tail : null,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function errorMessageFromPayload(payload: unknown): string | undefined {
  const record = asRecord(payload);
  if (typeof record.error === "string" && record.error.trim()) return record.error;
  if (typeof record.message === "string" && record.message.trim()) return record.message;
  const error = asRecord(record.error);
  if (typeof error.message === "string" && error.message.trim()) return error.message;
  return undefined;
}

function isBedrockAuthFailureText(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("bedrock is not authenticated") ||
    lower.includes("aws sso login") ||
    lower.includes("sso session associated with this profile") ||
    lower.includes("sso session has expired")
  );
}

function bedrockAuthTargetFromText(text: string): { profile?: string; region?: string } {
  const profile = text.match(/AWS profile '([^']+)'/)?.[1]
    ?? text.match(/AWS_PROFILE=([^\s]+)/)?.[1];
  const region = text.match(/\bin ([a-z]{2}-[a-z]+-\d)\b/)?.[1]
    ?? text.match(/AWS_REGION=([^\s]+)/)?.[1];
  return { profile, region };
}

function bedrockAuthCalloutDetail(text: string): string {
  const { profile, region } = bedrockAuthTargetFromText(text);
  const target = [
    profile ? `profile ${profile}` : "the configured AWS profile",
    region ? `in ${region}` : "",
  ].filter(Boolean).join(" ");
  return `Bedrock needs an AWS SSO session for ${target}. Sign in, then retry your message.`;
}

function sameEventArray(a: StreamEvent[], b: StreamEvent[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function sameStringArray(a?: string[], b?: string[]): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((item, index) => item === b[index]);
}

function sameSet(a?: Set<string>, b?: Set<string>): boolean {
  if (a === b) return true;
  if (!a || !b || a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}

function areMessageBubblePropsEqual(prev: Props, next: Props): boolean {
  if (prev.kind !== next.kind) return false;
  if (prev.kind === "user" && next.kind === "user") {
    return (
      prev.message === next.message &&
      prev.cli === next.cli &&
      prev.model === next.model &&
      prev.reasoningEffort === next.reasoningEffort &&
      prev.sessionId === next.sessionId &&
      prev.turnIndex === next.turnIndex &&
      prev.editing === next.editing &&
      Boolean(prev.onFork) === Boolean(next.onFork) &&
      Boolean(prev.onEdit) === Boolean(next.onEdit)
    );
  }
  if (prev.kind === "assistant" && next.kind === "assistant") {
    return (
      prev.streaming === next.streaming &&
      prev.liveActivity === next.liveActivity &&
      prev.liveDetail === next.liveDetail &&
      prev.sessionId === next.sessionId &&
      prev.onOpenFile === next.onOpenFile &&
      prev.onRunSubAgentInBackground === next.onRunSubAgentInBackground &&
      prev.onBedrockAuthReady === next.onBedrockAuthReady &&
      sameSet(prev.backgroundSubAgentIds, next.backgroundSubAgentIds) &&
      sameStringArray(prev.hiddenMcpImageServers, next.hiddenMcpImageServers) &&
      sameEventArray(prev.events, next.events)
    );
  }
  return false;
}

export const MessageBubble = memo(function MessageBubble(props: Props) {
  if (props.kind === "user") {
    return <UserBubble {...props} />;
  }
  return <AssistantBlock {...props} />;
}, areMessageBubblePropsEqual);

function CopyButton({ getText }: { getText: () => string }) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    };
  }, []);
  const copy = () => {
    navigator.clipboard.writeText(getText()).then(() => {
      if (!mountedRef.current) return;
      setCopied(true);
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = window.setTimeout(() => {
        resetTimerRef.current = null;
        if (!mountedRef.current) return;
        setCopied(false);
      }, 1500);
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
      <span className="live-thinking-indicator" aria-hidden="true">
        <span className="live-thinking-dot dot-a" />
        <span className="live-thinking-dot dot-b" />
        <span className="live-thinking-dot dot-c" />
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

function ToolRow({ tools }: { tools: React.ReactNode[] }) {
  const count = Children.count(tools);
  const label = `${count} grouped tool calls`;
  return (
    <div
      className={count > 1 ? "tool-row grouped" : "tool-row"}
      aria-label={count > 1 ? label : "Tool call"}
    >
      {count > 1 && (
        <div
          className="tool-row-label"
          title="Adjacent tool calls are grouped for compactness. This does not necessarily mean they ran in parallel."
        >
          {label}
        </div>
      )}
      <div className="tool-row-chips">
        {tools}
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

function PlainTextArticle({ text }: { text: string }) {
  return (
    <article className="prose-dashboard leading-relaxed whitespace-pre-wrap">
      {text}
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

function BedrockAuthCallout({
  sourceText,
  onReady,
}: {
  sourceText: string;
  onReady?: () => Promise<void> | void;
}) {
  const [launching, setLaunching] = useState(false);
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const detail = bedrockAuthCalloutDetail(sourceText);
  const authTarget = bedrockAuthTargetFromText(sourceText);

  const launch = async () => {
    setLaunching(true);
    setStatus(null);
    try {
      const res = await fetch("/api/bedrock/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile: authTarget.profile,
          region: authTarget.region,
        }),
      });
      const data = await res.json().catch(() => null) as unknown;
      if (!res.ok) throw new Error(errorMessageFromPayload(data) ?? "failed to open AWS SSO login");
      const ready = asRecord(asRecord(data).status).ready === true;
      setStatus(ready ? "Bedrock is authenticated. Retry your message." : "AWS SSO login opened. Complete it, then retry your message.");
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "failed to open AWS SSO login");
    } finally {
      setLaunching(false);
    }
  };

  const check = async () => {
    setChecking(true);
    setStatus(null);
    try {
      const params = new URLSearchParams();
      if (authTarget.profile) params.set("profile", authTarget.profile);
      if (authTarget.region) params.set("region", authTarget.region);
      const query = params.size > 0 ? `?${params.toString()}` : "";
      const res = await fetch(`/api/bedrock/auth${query}`);
      const data = await res.json().catch(() => null) as unknown;
      if (!res.ok) throw new Error(errorMessageFromPayload(data) ?? "failed to check Bedrock auth");
      const authStatus = asRecord(asRecord(data).status);
      const ready = authStatus.ready === true;
      const profile = typeof authStatus.profile === "string" ? authStatus.profile : "the configured AWS profile";
      const region = typeof authStatus.region === "string" ? authStatus.region : "";
      if (ready && onReady) {
        await onReady();
      }
      setStatus(ready
        ? `Bedrock is authenticated for ${profile}${region ? ` in ${region}` : ""}. Retry your message.`
        : `Bedrock still needs an AWS SSO session for ${profile}${region ? ` in ${region}` : ""}.`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "failed to check Bedrock auth");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div
      className="rounded-xl border px-3 py-3 text-[12px]"
      style={{
        borderColor: "color-mix(in srgb, var(--warning, #f59e0b) 35%, var(--border))",
        background: "color-mix(in srgb, var(--warning, #f59e0b) 9%, var(--bg-elev))",
      }}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-bg-subtle text-accent">
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-fg">Bedrock auth required</div>
          <div className="mt-0.5 text-muted leading-snug">{detail}</div>
          {status && <div className="mt-1 text-subtle" aria-live="polite">{status}</div>}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="primary" onClick={launch} disabled={launching}>
              {launching ? "Opening..." : "Sign in to AWS"}
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={check} disabled={checking}>
              {checking ? "Checking..." : "Check again"}
            </Button>
          </div>
        </div>
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
  onRunSubAgentInBackground,
  backgroundSubAgentIds,
  onBedrockAuthReady,
}: AssistantProps) {
  const [hovered, setHovered] = useState(false);
  const displayEvents = useMemo(
    () => streaming && events.length > STREAMING_EVENT_RENDER_LIMIT
      ? events.slice(-STREAMING_EVENT_RENDER_LIMIT)
      : events,
    [events, streaming],
  );
  const hiddenStreamingEventCount = events.length - displayEvents.length;

  // Collect all text for copy
  const allText = displayEvents
    .filter((ev) => ev.kind === "assistant_text" || ev.kind === "plan_text")
    .map((ev) => (ev as Extract<StreamEvent, { kind: "assistant_text" | "plan_text" }>).text)
    .join("\n\n");
  const bedrockAuthSourceText = displayEvents
    .map((ev) => {
      if (ev.kind === "assistant_text" || ev.kind === "plan_text") return ev.text;
      if (ev.kind === "result" && !ev.success) return extractSaturnFailure(ev.raw)?.stderrTail ?? "";
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
  const showBedrockAuthCallout = !streaming && isBedrockAuthFailureText(bedrockAuthSourceText);

  // Group sub-agent child events by their parentToolUseId
  const subEventsByParent = new Map<string, StreamEvent[]>();
  for (const ev of displayEvents) {
    const pid = (ev as { parentToolUseId?: string }).parentToolUseId;
    if (!pid) continue;
    if (!subEventsByParent.has(pid)) subEventsByParent.set(pid, []);
    subEventsByParent.get(pid)!.push(ev);
  }

  // Pair top-level (non-sub-agent) tool_use with tool_result
  const toolResults = new Map<string, Extract<StreamEvent, { kind: "tool_result" }>>();
  for (const ev of displayEvents) {
    if (ev.kind === "tool_result" && !(ev as { parentToolUseId?: string }).parentToolUseId) {
      toolResults.set(ev.toolUseId, ev);
    }
  }

  const rendered: React.ReactNode[] = [];
  if (hiddenStreamingEventCount > 0) {
    rendered.push(
      <div key="stream-hidden-events" className="text-[11px] text-subtle italic">
        {hiddenStreamingEventCount.toLocaleString()} earlier live events hidden while streaming
      </div>,
    );
  }
  let toolBuffer: React.ReactNode[] = [];
  const flushToolRow = () => {
    if (toolBuffer.length === 0) return;
    rendered.push(
      <ToolRow key={`tr-${rendered.length}`} tools={toolBuffer} />
    );
    toolBuffer = [];
  };

  displayEvents.forEach((ev, i) => {
    const eventKey = hiddenStreamingEventCount + i;
    // Skip sub-agent events — they're rendered inside SubAgentCard
    if ((ev as { parentToolUseId?: string }).parentToolUseId) return;
    const rawType = (ev.raw as { type?: string } | undefined)?.type;
    if (rawType === "saturn.turn_start") return;
    if (rawType === "saturn.turn_aborted") {
      flushToolRow();
      rendered.push(
        <div key={eventKey} className="text-[12px] text-subtle italic">
          stopped before a reply completed
        </div>
      );
      return;
    }
    if (ev.kind === "tool_result") return;
    if (ev.kind === "todo_list") {
      flushToolRow();
      rendered.push(<PlanChecklist key={eventKey} items={ev.items} />);
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
        const remaining = displayEvents.slice(i + 1);
        const isLast = remaining.every((e) => e.kind === "tool_result" || (e as { parentToolUseId?: string }).parentToolUseId);
        const status = !res ? "run" : res.isError ? "err" : "ok";
        rendered.push(
          <SubAgentCard
            key={eventKey}
            id={ev.id}
            input={ev.input}
            result={res?.content}
            status={status}
            active={status === "run" && streaming && isLast}
            backgrounded={backgroundSubAgentIds?.has(ev.id)}
            onRunInBackground={onRunSubAgentInBackground}
            subEvents={subEventsByParent.get(ev.id)}
          />
        );
        if (uniqueMediaRefs.length > 0) {
          rendered.push(<MediaPreviewGrid key={`media-${eventKey}`} refs={uniqueMediaRefs} sessionId={sessionId} />);
        }
        return;
      }
      if (uniqueMediaRefs.length > 0) {
        // Tool has media (e.g. screenshot) — flush current chip row first,
        // then render chip + image as a standalone full-width block.
        flushToolRow();
        rendered.push(
          <div key={eventKey} className="tool-media-block">
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
            key={eventKey}
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
        <PlanProposal key={eventKey} text={ev.text} sessionId={sessionId} onOpenFile={onOpenFile} />
      );
      return;
    }
    if (ev.kind === "assistant_text") {
      const segments = splitProposedPlanBlocks(ev.text);
      rendered.push(
        <div key={eventKey} className="assistant-text-stack">
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
                streaming ? (
                  <PlainTextArticle key={`${index}-text`} text={segment.text} />
                ) : (
                  <MarkdownArticle
                    key={`${index}-text`}
                    text={segment.text}
                    sessionId={sessionId}
                    onOpenFile={onOpenFile}
                  />
                )
              )
          ))}
        </div>
      );
      return;
    }
    if (ev.kind === "thinking") {
      rendered.push(
        <details key={eventKey} className="text-[11px]">
          <summary className="cursor-pointer uppercase tracking-wider text-subtle">thinking</summary>
          <div className="whitespace-pre-wrap mt-1 text-muted italic">
            {ev.text || <span className="text-subtle">[redacted]</span>}
          </div>
        </details>
      );
      return;
    }
    if (ev.kind === "result") {
      const failure = !ev.success ? extractSaturnFailure(ev.raw) : null;
      rendered.push(
        <div key={eventKey} className="flex flex-col gap-1 text-[10px] text-subtle">
          <div className="flex items-center gap-3">
            <span className={ev.success ? "text-success" : "text-fail"}>
              {ev.success ? "✓ done" : "✗ failed"}
            </span>
            {ev.totalTokens > 0 && <span>{ev.totalTokens.toLocaleString()} tokens</span>}
            {failure && (
              <span className="text-fail/80">
                {failure.phase} (exit {failure.exitCode})
              </span>
            )}
          </div>
          {failure?.stderrTail && (
            <pre className="whitespace-pre-wrap break-words text-[10px] text-fail/80 max-h-32 overflow-auto">
              {failure.stderrTail}
            </pre>
          )}
        </div>
      );
    }
  });
  flushToolRow();
  if (showBedrockAuthCallout) {
    rendered.push(
      <BedrockAuthCallout
        key="bedrock-auth"
        sourceText={bedrockAuthSourceText}
        onReady={onBedrockAuthReady}
      />,
    );
  }

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
