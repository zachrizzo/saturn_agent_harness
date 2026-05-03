"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { StreamEvent } from "@/lib/events";
import { ToolChip } from "./ToolChip";

const MARKDOWN_PLUGINS = [remarkGfm];

type Status = "run" | "ok" | "err";

type Props = {
  id: string;
  input: unknown;
  result?: unknown;
  status: Status;
  active?: boolean;
  onClick?: () => void;
  onRunInBackground?: (id: string) => void;
  runInBackgroundDisabled?: boolean;
  subEvents?: StreamEvent[];
};

function parseInput(input: unknown): { description?: string; prompt?: string; subagent_type?: string } {
  if (!input || typeof input !== "object") return {};
  const r = input as Record<string, unknown>;
  return {
    description: typeof r.description === "string" ? r.description : undefined,
    prompt: typeof r.prompt === "string" ? r.prompt : undefined,
    subagent_type: typeof r.subagent_type === "string" ? r.subagent_type : undefined,
  };
}

function parseResult(result: unknown): string | null {
  if (result == null) return null;
  if (typeof result === "string") return result;
  if (Array.isArray(result)) {
    return result
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object") {
          const r = item as Record<string, unknown>;
          return typeof r.text === "string" ? r.text : null;
        }
        return null;
      })
      .filter(Boolean)
      .join("\n") || null;
  }
  if (typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (typeof r.text === "string") return r.text;
    if (typeof r.output === "string") return r.output;
    try { return JSON.stringify(r, null, 2); } catch { return null; }
  }
  return null;
}

type ToolRow = {
  id: string;
  name: string;
  input: unknown;
  result?: unknown;
  isError: boolean;
  hasResult: boolean;
};

function buildToolRows(subEvents: StreamEvent[]): ToolRow[] {
  const results = new Map<string, { content: unknown; isError: boolean }>();
  for (const ev of subEvents) {
    if (ev.kind === "tool_result") results.set(ev.toolUseId, { content: ev.content, isError: ev.isError });
  }
  const rows: ToolRow[] = [];
  for (const ev of subEvents) {
    if (ev.kind !== "tool_use") continue;
    const res = results.get(ev.id);
    rows.push({
      id: ev.id,
      name: ev.name,
      input: ev.input,
      result: res?.content,
      isError: res?.isError ?? false,
      hasResult: res !== undefined,
    });
  }
  return rows;
}

function getSubAgentTexts(subEvents: StreamEvent[]): string[] {
  return subEvents
    .filter((ev) => ev.kind === "assistant_text")
    .map((ev) => (ev as Extract<StreamEvent, { kind: "assistant_text" }>).text)
    .filter(Boolean);
}

function AgentIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      style={{ transform: open ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 150ms ease" }}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function SubAgentCard({
  id,
  input,
  result,
  status,
  active,
  onClick,
  onRunInBackground,
  runInBackgroundDisabled,
  subEvents = [],
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const { description, prompt, subagent_type } = parseInput(input);
  const resultText = parseResult(result);
  const toolRows = buildToolRows(subEvents);
  const agentTexts = getSubAgentTexts(subEvents);

  const title = description ?? subagent_type ?? "Sub-agent";
  const typeLabel = subagent_type ?? null;
  const hasContent = toolRows.length > 0 || agentTexts.length > 0 || !!prompt || !!resultText;

  return (
    <div className={`subagent-card ${active ? "active" : ""}`.trim()}>
      {/* Header */}
      <div
        className="subagent-card-header"
        onClick={() => { if (hasContent) { setExpanded((v) => !v); onClick?.(); } }}
        role={hasContent ? "button" : undefined}
        tabIndex={hasContent ? 0 : undefined}
        onKeyDown={(e) => { if (hasContent && (e.key === "Enter" || e.key === " ")) { setExpanded((v) => !v); onClick?.(); } }}
        style={{ cursor: hasContent ? "pointer" : "default" }}
      >
        <span className="subagent-icon">
          <AgentIcon />
        </span>

        <div className="subagent-card-title-group">
          <div className="subagent-card-top-row">
            <span className="subagent-card-label">Agent</span>
            {typeLabel && <span className="subagent-type-badge">{typeLabel}</span>}
          </div>
          <span className="subagent-card-name">{title}</span>
        </div>

        {toolRows.length > 0 && (
          <span className="subagent-tool-count">
            {toolRows.length} tool{toolRows.length !== 1 ? "s" : ""}
          </span>
        )}

        <span className={`subagent-status ${status}`} aria-label={status === "run" ? "running" : status === "ok" ? "done" : "failed"}>
          {status === "run" && <span className="subagent-pulse" />}
          {status === "run" ? "running" : status === "ok" ? "done" : "failed"}
        </span>

        {status === "run" && onRunInBackground && (
          <button
            type="button"
            className="subagent-background-button"
            disabled={runInBackgroundDisabled}
            onClick={(event) => {
              event.stopPropagation();
              onRunInBackground(id);
            }}
            title="Keep this sub-agent running in the background and continue from the last completed turn"
            aria-label="Run sub-agent in background"
          >
            {runInBackgroundDisabled ? "Moving..." : "Background"}
          </button>
        )}

        {hasContent && (
          <span className="subagent-chevron" style={{ color: "var(--text-subtle)" }}>
            <ChevronIcon open={expanded} />
          </span>
        )}
      </div>

      {/* Collapsed prompt preview */}
      {!expanded && prompt && (
        <div className="subagent-prompt-preview">{prompt.slice(0, 140)}{prompt.length > 140 ? "…" : ""}</div>
      )}

      {/* Expanded body */}
      {expanded && (
        <div className="subagent-card-body">
          {/* Prompt */}
          {prompt && (
            <div className="subagent-section">
              <div className="subagent-section-label">Prompt</div>
              <div className="subagent-section-content subagent-prompt-full">{prompt}</div>
            </div>
          )}

          {/* Tool calls timeline */}
          {toolRows.length > 0 && (
            <div className="subagent-section">
              <div className="subagent-section-label">Tool calls ({toolRows.length})</div>
              <div className="subagent-tools-list">
                {toolRows.map((row) => (
                  <ToolChip
                    key={row.id}
                    tool={{
                      id: row.id,
                      name: row.name,
                      input: row.input,
                      result: row.result,
                      status: !row.hasResult ? "run" : row.isError ? "err" : "ok",
                    }}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Intermediate assistant text (thinking out loud) */}
          {agentTexts.length > 0 && (
            <div className="subagent-section">
              <div className="subagent-section-label">Reasoning</div>
              <div className="subagent-reasoning-list">
                {agentTexts.map((text, i) => (
                  <div key={i} className="subagent-reasoning-chunk prose-dashboard">
                    <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS}>{text}</ReactMarkdown>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Running indicator */}
          {status === "run" && !resultText && (
            <div className="subagent-running-indicator">
              <span className="subagent-pulse" />
              <span style={{ color: "var(--text-muted)", fontStyle: "italic", fontSize: "12px" }}>Running…</span>
            </div>
          )}

          {/* Final result */}
          {resultText && (
            <div className="subagent-section">
              <div className="subagent-section-label" style={{ color: status === "err" ? "var(--fail)" : undefined }}>
                {status === "err" ? "Error" : "Result"}
              </div>
              <div
                className="subagent-result-content"
                style={{ color: status === "err" ? "var(--fail)" : undefined }}
              >
                {status === "err" ? (
                  <pre className="subagent-section-content">{resultText}</pre>
                ) : (
                  <div className="prose-dashboard subagent-result-prose">
                    <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS}>{resultText}</ReactMarkdown>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
