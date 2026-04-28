"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useState } from "react";
import type { StreamEvent } from "@/lib/events";
import type { CLI } from "@/lib/runs";
import { formatReasoningEffort, type ModelReasoningEffort } from "@/lib/models";
import { toClaudeAlias } from "@/lib/claude-models";
import { CLI_SHORT_LABELS } from "@/lib/clis";
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
  sessionId?: string;
  hiddenMcpImageServers?: string[];
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

function AssistantBlock({ events, streaming, sessionId, hiddenMcpImageServers }: AssistantProps) {
  const [hovered, setHovered] = useState(false);

  // Collect all text for copy
  const allText = events
    .filter((ev) => ev.kind === "assistant_text")
    .map((ev) => (ev as Extract<StreamEvent, { kind: "assistant_text" }>).text)
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
    if (ev.kind === "assistant_text") {
      const mediaRefs = extractMediaRefsFromText(ev.text);
      rendered.push(
        <article key={i} className="prose-dashboard leading-relaxed">
          <ReactMarkdown
            remarkPlugins={MARKDOWN_PLUGINS}
            components={{
              img: ({ src, alt }) => (
                <MediaPreview src={String(src ?? "")} alt={alt ?? undefined} sessionId={sessionId} />
              ),
              // Use div instead of p when a paragraph contains only an image to avoid invalid HTML
              p: ({ children, ...props }) => {
                const childArr = Array.isArray(children) ? children : [children];
                const hasImg = childArr.some((c) => c && typeof c === "object" && (c as React.ReactElement).type === "img");
                return hasImg ? <div {...(props as React.HTMLAttributes<HTMLDivElement>)}>{children}</div> : <p {...props}>{children}</p>;
              },
            }}
          >
            {ev.text}
          </ReactMarkdown>
          <MediaPreviewGrid refs={mediaRefs} sessionId={sessionId} />
        </article>
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
        className="assistant-streaming-empty relative pl-4 border-l-2 text-[13px] text-muted"
        style={{ borderLeftColor: "var(--accent)" }}
      >
        <span className="assistant-streaming-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span>Thinking</span>
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
        <span className="assistant-stream-cursor" aria-hidden="true" />
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
