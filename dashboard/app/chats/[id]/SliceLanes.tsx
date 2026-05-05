"use client";

import { useMemo } from "react";
import type { SliceEntry } from "./SliceLane";

type Props = {
  slices: SliceEntry[];
  streaming: boolean;
  activeRunId: string | null;
  onSelect: (entry: SliceEntry) => void;
};

const FAILED_STATUSES = new Set([
  "failed",
  "timeout",
  "budget_exceeded",
  "recursion_limit_exceeded",
]);

/** Normalize status → the .status-dot / .chip modifiers available in globals.css. */
function dotClass(status: string): string {
  if (status === "success") return "status-success";
  if (status === "running") return "status-running";
  if (FAILED_STATUSES.has(status)) return "status-failed";
  return "status-idle";
}

function chipClass(status: string): string {
  if (status === "success") return "chip chip-success";
  if (status === "running") return "chip chip-running";
  if (FAILED_STATUSES.has(status)) return "chip chip-fail";
  return "chip";
}

function barColor(status: string): string {
  if (status === "success") return "var(--success)";
  if (status === "running") return "var(--running)";
  if (FAILED_STATUSES.has(status)) return "var(--fail)";
  return "var(--text-subtle)";
}

function formatDurationShort(ms?: number): string {
  if (!ms && ms !== 0) return "";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

function shortSliceId(id: string | undefined): string {
  if (!id) return "custom";
  // Strip `slc_` / hash fragments so the lane header reads clean.
  return id.replace(/^slc_/, "").replace(/[-_]/g, " ");
}

export function SliceLanes({ slices, streaming, activeRunId, onSelect }: Props) {
  const sorted = useMemo(() => {
    return [...slices].sort((a, b) => {
      if (a.execution_order !== undefined || b.execution_order !== undefined) {
        return (a.execution_order ?? Number.MAX_SAFE_INTEGER) - (b.execution_order ?? Number.MAX_SAFE_INTEGER);
      }
      const aT = a.started_at ? Date.parse(a.started_at) : Number.MAX_SAFE_INTEGER;
      const bT = b.started_at ? Date.parse(b.started_at) : Number.MAX_SAFE_INTEGER;
      return aT - bT;
    });
  }, [slices]);

  // Compute a shared timeline window so bars show overlap.
  const { windowStart, windowEnd } = useMemo(() => {
    let start = Infinity;
    let end = -Infinity;
    const now = Date.now();
    for (const s of sorted) {
      if (s.started_at) {
        const t = Date.parse(s.started_at);
        if (Number.isFinite(t)) start = Math.min(start, t);
      }
      if (s.finished_at) {
        const t = Date.parse(s.finished_at);
        if (Number.isFinite(t)) end = Math.max(end, t);
      } else if (s.status === "running") {
        end = Math.max(end, now);
      }
    }
    if (!Number.isFinite(start)) start = now;
    if (!Number.isFinite(end) || end <= start) end = start + 1000;
    return { windowStart: start, windowEnd: end };
  }, [sorted]);
  const windowMs = Math.max(1, windowEnd - windowStart);

  const running = sorted.filter((s) => s.status === "running");
  const completed = sorted.filter((s) => s.status !== "running" && s.status !== "queued" && s.status !== "skipped");
  const queued = sorted.filter((s) => s.status === "queued");

  return (
    <section
      aria-label="Parallel slice execution"
      className="rounded-xl border border-border overflow-hidden"
      style={{ background: "var(--bg-elev)" }}
    >
      {/* Summary strip */}
      <div
        className="flex items-center gap-3 px-4 py-2.5 flex-wrap"
        style={{
          borderBottom: sorted.length > 0 ? "1px solid var(--border)" : "none",
          background: "var(--bg-subtle)",
        }}
      >
        <span className="eyebrow">Parallel Slices</span>

        <span
          className={`status-dot ${
            running.length > 0 ? "status-running" : streaming ? "status-idle" : "status-success"
          }`}
          style={{
            width: 8,
            height: 8,
            boxShadow:
              running.length > 0
                ? "0 0 0 4px color-mix(in srgb, var(--running) 20%, transparent)"
                : undefined,
          }}
        />

        <span className="text-[12.5px] text-fg font-medium">
          {running.length > 0
            ? `${running.length} slice${running.length === 1 ? "" : "s"} running`
            : queued.length > 0
            ? `${queued.length} slice${queued.length === 1 ? "" : "s"} queued`
            : streaming
            ? "Waiting for next dispatch…"
            : sorted.length > 0
            ? "Done"
            : "No slices dispatched yet"}
        </span>

        {running.length > 0 && (
          <span className="text-[12px] text-muted truncate min-w-0">
            {running
              .slice(0, 4)
              .map((r) => shortSliceId(r.slice_id))
              .join(" · ")}
            {running.length > 4 && ` · +${running.length - 4}`}
          </span>
        )}

        <span className="ml-auto text-[11px] text-subtle mono">
          {completed.length} completed / {sorted.length} total
        </span>
      </div>

      {/* Lanes */}
      {sorted.length === 0 ? (
        <div
          className="px-4 py-6 text-center text-[12.5px] text-subtle"
          style={{ background: "var(--bg)" }}
        >
          Slices will show up here as the orchestrator dispatches them.
        </div>
      ) : (
        <ul className="m-0 p-0 list-none" style={{ background: "var(--bg)" }}>
          {sorted.map((entry, i) => {
            const isActive = entry.slice_run_id === activeRunId;
            const canInspect = !entry.planned;

            // Bar geometry
            const startT = entry.started_at ? Date.parse(entry.started_at) : windowStart;
            const endT = entry.finished_at
              ? Date.parse(entry.finished_at)
              : entry.status === "running"
              ? windowEnd
              : startT + (entry.duration_ms ?? 0);
            const leftPct = Math.max(
              0,
              Math.min(100, ((startT - windowStart) / windowMs) * 100)
            );
            const rightPct = Math.max(
              0,
              Math.min(100, ((endT - windowStart) / windowMs) * 100)
            );
            const widthPct = Math.max(1, rightPct - leftPct);

            return (
              <li
                key={entry.slice_run_id}
                className="list-none"
                style={{
                  borderTop: i === 0 ? "none" : "1px solid var(--border)",
                }}
              >
                <button
                  type="button"
                  onClick={() => onSelect(entry)}
                  disabled={!canInspect}
                  className="w-full text-left px-4 py-2.5 transition-colors"
                  style={{
                    background: isActive ? "var(--accent-soft)" : "transparent",
                    borderLeft: isActive
                      ? "2px solid var(--accent)"
                      : "2px solid transparent",
                  }}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {/* Index */}
                    <span
                      className="mono text-[10px] text-subtle"
                      style={{ width: 22, flexShrink: 0, textAlign: "right" }}
                    >
                      {String(i + 1).padStart(2, "0")}
                    </span>

                    {/* Status dot */}
                    <span
                      className={`status-dot ${dotClass(entry.status)}`}
                      style={{
                        width: 8,
                        height: 8,
                        flexShrink: 0,
                        boxShadow:
                          entry.status === "running"
                            ? "0 0 0 3px color-mix(in srgb, var(--running) 22%, transparent)"
                            : undefined,
                        animation:
                          entry.status === "running"
                            ? "pulse 2s cubic-bezier(0.4,0,0.6,1) infinite"
                            : undefined,
                      }}
                    />

                    {/* Name */}
                    <span
                      className="mono text-[12.5px] text-fg truncate"
                      style={{ flex: "0 0 160px", minWidth: 0 }}
                      title={entry.slice_id ?? "custom slice"}
                    >
                      {entry.label ?? shortSliceId(entry.slice_id)}
                    </span>

                    {/* Timeline bar */}
                    <div
                      className="relative flex-1 min-w-0"
                      style={{
                        height: 6,
                        borderRadius: 9999,
                        background: "var(--bg-subtle)",
                        border: "1px solid var(--border)",
                      }}
                    >
                      <div
                        style={{
                          position: "absolute",
                          left: `${leftPct}%`,
                          width: `${widthPct}%`,
                          top: -1,
                          bottom: -1,
                          borderRadius: 9999,
                          background: barColor(entry.status),
                          opacity: entry.status === "running" ? 0.75 : 0.9,
                          transition: "width 160ms ease, left 160ms ease",
                        }}
                      />
                      {entry.status === "running" && (
                        <div
                          style={{
                            position: "absolute",
                            right: `${100 - rightPct}%`,
                            top: -3,
                            width: 10,
                            height: 10,
                            borderRadius: 9999,
                            background: "var(--running)",
                            boxShadow:
                              "0 0 0 4px color-mix(in srgb, var(--running) 20%, transparent)",
                            animation:
                              "pulse 1.4s cubic-bezier(0.4,0,0.6,1) infinite",
                          }}
                        />
                      )}
                    </div>

                    {/* Duration */}
                    <span
                      className="mono text-[11px] text-muted tabular-nums"
                      style={{ flex: "0 0 52px", textAlign: "right" }}
                    >
                      {entry.duration_ms !== undefined
                        ? formatDurationShort(entry.duration_ms)
                        : entry.status === "running"
                        ? formatDurationShort(Date.now() - startT)
                        : entry.status === "queued"
                        ? "queued"
                        : "—"}
                    </span>

                    {/* Tokens */}
                    <span
                      className="mono text-[11px] text-muted tabular-nums"
                      style={{ flex: "0 0 64px", textAlign: "right" }}
                      title="Tokens for this slice"
                    >
                      {entry.tokens?.total
                        ? entry.tokens.total.toLocaleString()
                        : "—"}
                    </span>

                    {/* Status chip */}
                    <span
                      className={chipClass(entry.status)}
                      style={{ fontSize: 10, padding: "1px 7px", flexShrink: 0 }}
                    >
                      {entry.status.replace(/_/g, " ")}
                    </span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
