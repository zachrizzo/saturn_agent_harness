"use client";

import { useEffect, useRef, useState } from "react";
import { toEvents, type StreamEvent } from "@/lib/events";
import { Button } from "@/app/components/ui";
import { ApplyPanel } from "@/app/components/ApplyPanel";
import type { SliceEntry } from "./SliceLane";

type Props = {
  sessionId: string;
  entry: SliceEntry | null;
  onRerun?: (newRunId: string) => void;
  onClose?: () => void;
};

type TabKey = "events" | "io" | "meta";

const FAILED_STATUSES = new Set([
  "failed",
  "timeout",
  "budget_exceeded",
  "recursion_limit_exceeded",
]);
const OUTPUT_FAIL_STATUSES = new Set(["failed", "timeout", "budget_exceeded"]);

const TABS: { key: TabKey; label: string }[] = [
  { key: "events", label: "Events" },
  { key: "io", label: "I/O" },
  { key: "meta", label: "Meta" },
];

function toJsonString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function kv(label: string, value: string | null | undefined) {
  return (
    <div>
      <div className="insp-key">{label}</div>
      <div className="insp-val">{value || "—"}</div>
    </div>
  );
}

function kvNumber(label: string, n: number | undefined) {
  return kv(label, n !== undefined ? n.toLocaleString() : null);
}

function kvTime(label: string, iso: string | undefined) {
  return kv(label, iso ? new Date(iso).toLocaleTimeString() : null);
}

function statusColor(status: string): string {
  if (status === "success") return "var(--success)";
  if (status === "running") return "var(--running)";
  if (FAILED_STATUSES.has(status)) return "var(--fail)";
  return "var(--text-muted)";
}

function formatDurationShort(ms?: number): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

export function SliceInspector({ sessionId, entry, onRerun, onClose }: Props) {
  const [tab, setTab] = useState<TabKey>("events");
  const [sliceEvents, setSliceEvents] = useState<StreamEvent[]>([]);
  const [rerunning, setRerunning] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const seenRef = useRef(new Set<string>());
  const bottomRef = useRef<HTMLDivElement>(null);

  // Stream the selected slice's events.
  useEffect(() => {
    esRef.current?.close();
    esRef.current = null;
    setSliceEvents([]);
    seenRef.current.clear();
    if (!entry) return;

    const url = `/api/sessions/${encodeURIComponent(sessionId)}/slices/${encodeURIComponent(
      entry.slice_run_id
    )}/stream`;
    const es = new EventSource(url);
    esRef.current = es;

    es.onmessage = (e) => {
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(e.data);
      } catch {
        return;
      }
      const objType = (obj as { type?: string }).type;
      if (objType === "_meta" || objType === "_slice_done") {
        es.close();
        return;
      }
      const key = JSON.stringify(obj);
      if (seenRef.current.has(key)) return;
      seenRef.current.add(key);
      const parsed = toEvents(obj);
      if (parsed.length === 0) return;
      setSliceEvents((prev) => [...prev, ...parsed]);
    };
    es.onerror = () => es.close();

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [sessionId, entry?.slice_run_id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [sliceEvents.length]);

  const handleRerun = async () => {
    if (!entry) return;
    setRerunning(true);
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/slices/${encodeURIComponent(
          entry.slice_run_id
        )}/rerun`,
        { method: "POST" }
      );
      if (!res.ok) throw new Error("rerun failed");
      const data = await res.json();
      onRerun?.(data.slice_run_id);
    } catch {
      /* ignore */
    } finally {
      setRerunning(false);
    }
  };

  if (!entry) {
    return (
      <aside className="inspector">
        <div className="insp-section">
          <h3>Slice inspector</h3>
          <div className="text-[12px] text-subtle">
            Click a slice lane on the left to inspect its inputs, streamed
            events, and result.
          </div>
        </div>
      </aside>
    );
  }

  // Derive the slice's own input / output / meta from raw stream.
  const systemRaw = sliceEvents.find((e) => e.kind === "system")?.raw as
    | { input?: unknown; slice_id?: string }
    | undefined;
  const resultRaw = sliceEvents.find((e) => e.kind === "result")?.raw as
    | { output?: unknown }
    | undefined;
  const sliceInput = systemRaw?.input;
  const sliceOutput = resultRaw?.output;

  // Running-time fallback when the index hasn't updated yet.
  let liveDuration = entry.duration_ms;
  if (liveDuration === undefined && entry.status === "running" && entry.started_at) {
    liveDuration = Date.now() - Date.parse(entry.started_at);
  }

  return (
    <aside className="inspector">
      {/* Header */}
      <div className="flex items-center gap-2 mb-2">
        <h3 style={{ margin: 0, flex: 1, minWidth: 0 }} className="truncate">
          {entry.slice_id ?? "custom slice"}
          {"  "}
          <span
            style={{
              color: statusColor(entry.status),
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            · {entry.status.replace(/_/g, " ")}
          </span>
        </h3>
        {onClose && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onClose}
            aria-label="Close inspector"
            style={{ padding: "2px 6px", fontSize: 11 }}
          >
            ✕
          </Button>
        )}
      </div>

      <div className="tab-bar">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            className={`tab ${tab === key ? "active" : ""}`}
            onClick={() => setTab(key)}
          >
            {label}
            {key === "events" && <span className="n">{sliceEvents.length}</span>}
          </button>
        ))}
      </div>

      {tab === "events" && (
        <div className="insp-section">
          {sliceEvents.length === 0 ? (
            <div className="text-[12px] text-subtle italic">
              {entry.status === "running"
                ? "Streaming transcript…"
                : "No events captured."}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {sliceEvents.map((ev, i) => {
                if (ev.kind === "assistant_text") {
                  return (
                    <div
                      key={i}
                      className="whitespace-pre-wrap text-[12.5px] text-fg leading-relaxed"
                    >
                      {ev.text}
                    </div>
                  );
                }
                if (ev.kind === "tool_use") {
                  return (
                    <div
                      key={i}
                      className="mono text-[11px]"
                      style={{
                        color: "var(--text-muted)",
                        padding: "4px 8px",
                        background: "var(--bg-elev)",
                        border: "1px solid var(--border)",
                        borderRadius: 6,
                      }}
                    >
                      <span style={{ color: "var(--accent)" }}>tool</span>{" "}
                      {ev.name}
                    </div>
                  );
                }
                if (ev.kind === "thinking") {
                  return (
                    <details key={i} className="text-[11px]">
                      <summary
                        className="cursor-pointer"
                        style={{
                          color: "var(--text-subtle)",
                          textTransform: "uppercase",
                          letterSpacing: "0.05em",
                          fontSize: 10,
                        }}
                      >
                        thinking
                      </summary>
                      <div className="whitespace-pre-wrap text-muted italic mt-1">
                        {ev.text || "[redacted]"}
                      </div>
                    </details>
                  );
                }
                if (ev.kind === "result") {
                  return (
                    <div
                      key={i}
                      className="text-[11px] mono"
                      style={{
                        color: ev.success ? "var(--success)" : "var(--fail)",
                      }}
                    >
                      {ev.success ? "✓ done" : "✗ failed"}
                      {ev.totalTokens > 0 &&
                        ` · ${ev.totalTokens.toLocaleString()} tokens`}
                    </div>
                  );
                }
                return null;
              })}
              <div ref={bottomRef} />
            </div>
          )}
        </div>
      )}

      {tab === "io" && (
        <>
          <div className="insp-section">
            <div className="insp-key" style={{ marginBottom: 6 }}>
              Input
            </div>
            <pre className="json-block">
              {sliceInput === undefined ? "—" : toJsonString(sliceInput)}
            </pre>
          </div>
          <div className="insp-section">
            <div className="insp-key" style={{ marginBottom: 6 }}>
              Output
            </div>
            <pre
              className="json-block"
              style={{ color: OUTPUT_FAIL_STATUSES.has(entry.status) ? "var(--fail)" : undefined }}
            >
              {sliceOutput === undefined ? "—" : toJsonString(sliceOutput)}
            </pre>
          </div>
          {entry.sandbox_mode === "worktree" && entry.status === "success" && (
            <div className="insp-section">
              <div className="insp-key" style={{ marginBottom: 6 }}>
                Review & apply
              </div>
              <ApplyPanel sessionId={sessionId} runId={entry.slice_run_id} />
            </div>
          )}
        </>
      )}

      {tab === "meta" && (
        <>
          <div className="insp-section">
            <div className="kv">
              {kv("Status", entry.status)}
              {kv("Slice id", entry.slice_id ?? null)}
              {kv("Run id", entry.slice_run_id.slice(0, 16))}
              {kv("Sandbox", entry.sandbox_mode ?? "none")}
              {kvTime("Started", entry.started_at)}
              {kvTime("Finished", entry.finished_at)}
              {kv("Duration", formatDurationShort(liveDuration))}
              {kvNumber("Tokens (total)", entry.tokens?.total)}
              {kvNumber("Tokens (input)", entry.tokens?.input)}
              {kvNumber("Tokens (output)", entry.tokens?.output)}
            </div>
          </div>
          <div className="insp-section">
            <Button
              size="sm"
              variant="default"
              disabled={rerunning}
              onClick={handleRerun}
            >
              {rerunning ? "Re-running…" : "Re-run this slice"}
            </Button>
          </div>
        </>
      )}
    </aside>
  );
}
