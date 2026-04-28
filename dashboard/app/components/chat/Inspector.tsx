"use client";

import { useEffect, useMemo, useState } from "react";
import type { StreamEvent, TokenBreakdown } from "@/lib/events";
import type { SessionMeta } from "@/lib/runs";
import { formatDuration } from "@/lib/format";
import { toClaudeAlias } from "@/lib/claude-models";
import { formatReasoningEffort } from "@/lib/models";
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
};

type TabKey = "tool" | "run" | "files" | "tokens";

function toJsonString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

const FILE_PATH_KEYS = new Set(["file_path", "path", "new_path", "old_path"]);

function isLikelyFilePath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /[\r\n]/.test(trimmed)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed.startsWith("file://");
  if (/^(\/|~\/|\$HOME\/|\$CODEX_HOME\/|\.{1,2}\/)/.test(trimmed)) return true;
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return true;
  return trimmed.includes("/") || /^[^/]+\.[A-Za-z0-9]{1,12}$/.test(trimmed);
}

function addPath(files: Set<string>, value: unknown) {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (isLikelyFilePath(trimmed)) files.add(trimmed);
}

function collectFilePathsFromValue(value: unknown, files: Set<string>, depth = 0) {
  if (depth > 8 || value == null) return;

  if (Array.isArray(value)) {
    for (const item of value) collectFilePathsFromValue(item, files, depth + 1);
    return;
  }

  if (typeof value !== "object") return;
  const rec = value as Record<string, unknown>;
  for (const [key, pathValue] of Object.entries(rec)) {
    if (FILE_PATH_KEYS.has(key)) addPath(files, pathValue);
    if (key === "file_paths" && Array.isArray(pathValue)) {
      for (const item of pathValue) addPath(files, item);
    }
    collectFilePathsFromValue(pathValue, files, depth + 1);
  }
}

// Tools that produce file writes/edits — only these show up in the Files tab.
const EDIT_TOOL_NAMES = new Set([
  "Write", "Edit", "str_replace", "str_replace_editor",
  "create_file", "write_file", "edit_file", "apply_patch",
  "NotebookEdit",
]);

function collectEditedFiles(tools: InspectorTool[]): string[] {
  const files = new Set<string>();
  for (const t of tools) {
    if (!EDIT_TOOL_NAMES.has(t.name)) continue;
    collectFilePathsFromValue(t.input, files);
  }
  return Array.from(files).slice(0, 64);
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

function Section({ title, children }: { title?: string; children: React.ReactNode }) {
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

export function Inspector({ session, activeTool, tools, tokens, events }: Props) {
  const [tab, setTab] = useState<TabKey>("run");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

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

  const files = useMemo(() => collectEditedFiles(tools), [tools]);
  const result = events.find((e) => e.kind === "result");
  const resultMeta = result?.kind === "result" ? result : null;

  const lastTurn = session.turns[session.turns.length - 1];
  const finishedAt = lastTurn?.finished_at ?? session.finished_at;
  const durationMs =
    finishedAt && lastTurn?.started_at
      ? new Date(finishedAt).getTime() - new Date(lastTurn.started_at).getTime()
      : undefined;

  const modelDisplay = toClaudeAlias(lastTurn?.model ?? session.agent_snapshot?.model ?? undefined)
    ?? lastTurn?.model ?? session.agent_snapshot?.model ?? null;

  return (
    <aside className="inspector">
      {/* Tab bar */}
      <div className="tab-bar">
        {(["tool", "run", "files", "tokens"] as TabKey[]).map((t) => {
          const badge =
            t === "tool" ? tools.length :
            t === "files" ? files.length :
            null;
          return (
            <button
              key={t}
              type="button"
              className={`tab ${tab === t ? "active" : ""}`}
              onClick={() => setTab(t)}
            >
              {t === "tool" ? "Tool" : t === "run" ? "Run" : t === "files" ? "Files" : "Tokens"}
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

      {/* ── Run tab ── */}
      {tab === "run" && (
        <div className="flex-1 overflow-y-auto min-h-0">
          <Section title="Session">
            <div className="kv-stack">
              <KVRow label="Status" value={session.status} />
              <KVRow label="Turns" value={String(session.turns.length)} />
              <KVRow label="Started" value={new Date(session.started_at).toLocaleTimeString()} />
              <KVRow label="Duration" value={formatDuration(durationMs)} />
              <KVRow label="CLI" value={lastTurn?.cli ?? null} />
              <KVRow label="Model" value={modelDisplay} />
              <KVRow label="Effort" value={formatReasoningEffort(lastTurn?.reasoningEffort ?? session.agent_snapshot?.reasoningEffort)} />
            </div>
          </Section>
          {resultMeta && (
            <Section title="Last result">
              <div className="kv-stack">
                <KVRow label="Success" value={resultMeta.success ? "yes" : "no"} />
                <KVRow label="Tokens" value={resultMeta.totalTokens.toLocaleString()} />
                <KVRow label="Turns" value={String(resultMeta.numTurns)} />
              </div>
            </Section>
          )}
        </div>
      )}

      {/* ── Files tab ── */}
      {tab === "files" && (
        selectedFile ? (
          <FileViewer
            filePath={selectedFile}
            sessionId={session.session_id ?? ""}
            onClose={() => setSelectedFile(null)}
          />
        ) : (
          <div className="flex-1 overflow-y-auto min-h-0">
            <Section title="Edited files">
              {files.length === 0 ? (
                <div className="insp-empty">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-2 opacity-30">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                    <line x1="16" y1="13" x2="8" y2="13"/>
                    <line x1="16" y1="17" x2="8" y2="17"/>
                    <polyline points="10 9 9 9 8 9"/>
                  </svg>
                  No files edited yet.
                </div>
              ) : (
                <div className="insp-file-list">
                  {files.map((f) => {
                    const name = f.split("/").pop() ?? f;
                    const dir = f.length > name.length ? f.slice(0, f.length - name.length - 1) : "";
                    return (
                      <button
                        key={f}
                        type="button"
                        className="insp-file-row insp-file-row-btn"
                        onClick={() => setSelectedFile(f)}
                        title={f}
                      >
                        <svg className="insp-file-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                          <polyline points="14 2 14 8 20 8"/>
                        </svg>
                        <span className="insp-file-name">{name}</span>
                        {dir && <span className="insp-file-dir">{dir}</span>}
                        <svg className="insp-file-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                          <path d="M9 18l6-6-6-6"/>
                        </svg>
                      </button>
                    );
                  })}
                </div>
              )}
            </Section>
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
