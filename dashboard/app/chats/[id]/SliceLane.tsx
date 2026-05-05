"use client";

import { useEffect, useRef, useState } from "react";
import { toEvents, type StreamEvent } from "@/lib/events";
import { Chip, Button } from "@/app/components/ui";
import { ApplyPanel } from "@/app/components/ApplyPanel";

export type SliceEntry = {
  slice_run_id: string;
  graph_run_id?: string;
  graph_node_id?: string;
  slice_id?: string;
  label?: string;
  status: string;
  started_at?: string;
  finished_at?: string;
  tokens?: { input: number; output: number; total: number };
  duration_ms?: number;
  sandbox_mode?: string;
  planned?: boolean;
  execution_order?: number;
  upstream_node_ids?: string[];
  downstream_node_ids?: string[];
};

type Props = {
  sessionId: string;
  entry: SliceEntry;
  onRerun?: (newRunId: string) => void;
};

function statusVariant(
  status: string
): "success" | "fail" | "warn" | "default" {
  if (status === "success") return "success";
  if (status === "failed" || status === "timeout" || status === "budget_exceeded")
    return "fail";
  if (status === "running" || status === "output_validation_error") return "warn";
  return "default";
}

function formatDuration(ms?: number): string {
  if (!ms) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function SliceLane({ sessionId, entry, onRerun }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [sliceEvents, setSliceEvents] = useState<StreamEvent[]>([]);
  const [rerunning, setRerunning] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const seenRef = useRef(new Set<string>());
  const laneBottomRef = useRef<HTMLDivElement>(null);

  // Open SSE for this slice when expanded; close on collapse
  useEffect(() => {
    if (!expanded) {
      esRef.current?.close();
      esRef.current = null;
      return;
    }

    // Reset events on each expand
    setSliceEvents([]);
    seenRef.current.clear();

    const url = `/api/sessions/${encodeURIComponent(sessionId)}/slices/${encodeURIComponent(entry.slice_run_id)}/stream`;
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
      // Ignore meta events and sentinel
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

    es.onerror = () => {
      es.close();
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [expanded, sessionId, entry.slice_run_id]);

  // Auto-scroll lane content
  useEffect(() => {
    if (expanded) {
      laneBottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [sliceEvents.length, expanded]);

  const handleRerun = async () => {
    setRerunning(true);
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/slices/${encodeURIComponent(entry.slice_run_id)}/rerun`,
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

  const variant = statusVariant(entry.status);
  const sliceLabel = entry.slice_id ?? "custom slice";

  return (
    <div className="rounded-xl border border-border overflow-hidden">
      {/* Header row */}
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-bg-hover transition-colors"
        style={{ background: "var(--bg-subtle)" }}
        onClick={() => setExpanded((v) => !v)}
      >
        {/* Chevron */}
        <span
          className="text-[10px] text-muted select-none w-3 flex-shrink-0"
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? "▼" : "▶"}
        </span>

        {/* Slice id */}
        <span className="mono text-[12px] text-fg font-medium truncate flex-1">
          {sliceLabel}
        </span>

        {/* Status chip */}
        <Chip variant={variant} className="text-[10px]">
          {entry.status}
        </Chip>

        {/* Token chip */}
        {entry.tokens?.total !== undefined && (
          <Chip className="text-[10px]">
            {entry.tokens.total.toLocaleString()} tok
          </Chip>
        )}

        {/* Duration */}
        {entry.duration_ms !== undefined && (
          <span className="text-[11px] text-muted whitespace-nowrap">
            {formatDuration(entry.duration_ms)}
          </span>
        )}

        {/* Re-run button */}
        <Button
          size="sm"
          variant="ghost"
          disabled={rerunning}
          onClick={(e) => {
            e.stopPropagation();
            handleRerun();
          }}
        >
          {rerunning ? "…" : "Re-run"}
        </Button>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div
          className="border-t border-border max-h-80 overflow-y-auto px-3 py-2 space-y-1"
          style={{ background: "var(--bg)" }}
        >
          {sliceEvents.length === 0 && (
            <p className="text-[12px] text-muted italic">Loading transcript…</p>
          )}
          {sliceEvents.map((ev, i) => {
            if (ev.kind === "assistant_text") {
              return (
                <div
                  key={i}
                  className="whitespace-pre-wrap text-[13px] text-fg leading-relaxed"
                >
                  {ev.text}
                </div>
              );
            }
            if (ev.kind === "tool_use") {
              return (
                <div key={i} className="text-[12px] text-muted font-mono">
                  [tool: {ev.name}]
                </div>
              );
            }
            if (ev.kind === "thinking") {
              return (
                <details key={i} className="text-[11px]">
                  <summary className="cursor-pointer text-subtle uppercase tracking-wider">
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
                  className={`text-[11px] ${ev.success ? "text-success" : "text-fail"}`}
                >
                  {ev.success ? "✓ done" : "✗ failed"}{" "}
                  {ev.totalTokens > 0 &&
                    `· ${ev.totalTokens.toLocaleString()} tokens`}
                </div>
              );
            }
            return null;
          })}
          {entry.sandbox_mode === "worktree" && entry.status === "success" && (
            <div className="mt-3 pt-2 border-t border-border">
              <p className="text-[11px] uppercase tracking-wider text-subtle mb-2">
                Review & apply
              </p>
              <ApplyPanel sessionId={sessionId} runId={entry.slice_run_id} />
            </div>
          )}
          <div ref={laneBottomRef} />
        </div>
      )}
    </div>
  );
}
