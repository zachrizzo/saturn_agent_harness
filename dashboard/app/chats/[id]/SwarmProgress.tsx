"use client";

import { useEffect, useRef, useState } from "react";
import type { Budget, BudgetLimits } from "@/lib/budget";
import { Button } from "@/app/components/ui";
import type { SliceEntry } from "./SliceLane";

type Props = {
  sessionId: string;
  streaming: boolean;
  slices: SliceEntry[];
  runStartedAt?: string;
  onAbort?: () => void;
};

type Clock = { elapsed: string };

function fmtClock(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function deriveClock(startedAt: string | undefined): Clock {
  if (!startedAt) return { elapsed: "00:00" };
  const startedMs = Date.parse(startedAt);
  if (!Number.isFinite(startedMs)) return { elapsed: "00:00" };
  const elapsedSec = Math.max(0, (Date.now() - startedMs) / 1000);
  return {
    elapsed: fmtClock(elapsedSec),
  };
}

function isDocumentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(isDocumentVisible);

  useEffect(() => {
    const update = () => setVisible(isDocumentVisible());
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  return visible;
}

function sameBudget(a: Budget | null, b: Budget | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.tokens_used === b.tokens_used &&
    a.slice_calls === b.slice_calls &&
    a.wallclock_started_at === b.wallclock_started_at &&
    a.recursion_depth === b.recursion_depth &&
    a.stop === b.stop &&
    a.stop_reason === b.stop_reason
  );
}

function sameLimits(a: BudgetLimits, b: BudgetLimits): boolean {
  return (
    a.max_total_tokens === b.max_total_tokens &&
    a.max_slice_calls === b.max_slice_calls &&
    a.max_recursion_depth === b.max_recursion_depth
  );
}

export function SwarmProgress({ sessionId, streaming, slices, runStartedAt, onAbort }: Props) {
  const pageVisible = useDocumentVisible();
  const [budget, setBudget] = useState<Budget | null>(null);
  const [limits, setLimits] = useState<BudgetLimits>({});
  const [clock, setClock] = useState<Clock>({ elapsed: "00:00" });
  const [aborting, setAborting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll budget while streaming; do one last fetch when we stop.
  useEffect(() => {
    if (!pageVisible) return;

    let cancelled = false;
    let inFlight = false;
    const controller = new AbortController();
    const poll = async () => {
      if (inFlight || controller.signal.aborted) return;
      inFlight = true;
      try {
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(sessionId)}/budget`,
          { cache: "no-store", signal: controller.signal }
        );
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const nextBudget = (data.budget ?? null) as Budget | null;
        const nextLimits = (data.limits ?? {}) as BudgetLimits;
        setBudget((current) => sameBudget(current, nextBudget) ? current : nextBudget);
        setLimits((current) => sameLimits(current, nextLimits) ? current : nextLimits);
      } catch {
        /* ignore */
      } finally {
        inFlight = false;
      }
    };
    poll();
    if (streaming) {
      pollRef.current = setInterval(poll, 2000);
      return () => {
        cancelled = true;
        controller.abort();
        if (pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      };
    }
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [pageVisible, sessionId, streaming]);

  // Tick the wallclock locally so it feels live even between polls.
  useEffect(() => {
    const startedAt = runStartedAt ?? budget?.wallclock_started_at;
    if (!startedAt || !pageVisible) return;
    setClock(deriveClock(startedAt));
    if (!streaming) return;
    const t = setInterval(() => setClock(deriveClock(startedAt)), 1000);
    return () => clearInterval(t);
  }, [budget?.wallclock_started_at, pageVisible, runStartedAt, streaming]);

  const handleAbort = async () => {
    setAborting(true);
    try {
      await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, {
        method: "POST",
      });
      onAbort?.();
    } catch {
      /* ignore */
    } finally {
      setAborting(false);
    }
  };

  const sliceTokenTotal = slices.reduce((sum, slice) => sum + (slice.planned ? 0 : slice.tokens?.total ?? 0), 0);
  const tokensUsed = Math.max(budget?.tokens_used ?? 0, sliceTokenTotal);
  const maxTokens = limits.max_total_tokens;
  const maxCalls = limits.max_slice_calls;
  const running = slices.filter((s) => s.status === "running").length;
  const completed = slices.filter((s) => s.status !== "running" && s.status !== "queued" && s.status !== "skipped").length;
  const queued = slices.filter((s) => s.status === "queued").length;
  const activeOrDone = running + completed;
  const sliceTarget = slices.length > 0 ? slices.length : maxCalls;
  const tokenPct = maxTokens
    ? Math.min(100, (tokensUsed / maxTokens) * 100)
    : 0;
  const callsPct = maxCalls
    ? Math.min(100, (activeOrDone / maxCalls) * 100)
    : 0;

  const tokenTone: "" | "kpi-warn" | "kpi-fail" =
    tokenPct >= 90 ? "kpi-fail" : tokenPct >= 70 ? "kpi-warn" : "";
  const callsTone: "" | "kpi-warn" | "kpi-fail" =
    callsPct >= 90 ? "kpi-fail" : callsPct >= 70 ? "kpi-warn" : "";

  return (
    <section
      aria-label="Orchestrator progress"
      className="rounded-xl border border-border overflow-hidden"
      style={{ background: "var(--bg-elev)" }}
    >
      <div
        className="px-4 py-2 flex items-center gap-2 flex-wrap"
        style={{
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-subtle)",
        }}
      >
        <span className="eyebrow">Run Progress</span>
        {streaming ? (
          <span className="chip chip-warn" style={{ fontSize: 10 }}>
            <span className="status-dot status-running" />
            live
          </span>
        ) : (
          <span className="chip" style={{ fontSize: 10 }}>
            idle
          </span>
        )}
        <div style={{ flex: 1 }} />
        {streaming && (
          <Button
            size="sm"
            variant="danger"
            disabled={aborting}
            onClick={handleAbort}
          >
            {aborting ? "Aborting…" : "Abort"}
          </Button>
        )}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
          gap: 10,
          padding: 12,
        }}
      >
        {/* Tokens */}
        <div className={`kpi ${tokenTone}`.trim()}>
          <span className="accent-line" />
          <div className="kpi-label">Tokens</div>
          <div className="kpi-value">
            {tokensUsed.toLocaleString()}
            {maxTokens && (
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 400,
                  color: "var(--text-subtle)",
                  marginLeft: 6,
                }}
              >
                / {maxTokens.toLocaleString()}
              </span>
            )}
          </div>
          {maxTokens && (
            <div
              style={{
                marginTop: 8,
                height: 4,
                borderRadius: 9999,
                background: "var(--border)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  width: `${tokenPct}%`,
                  height: "100%",
                  background:
                    tokenTone === "kpi-fail"
                      ? "var(--fail)"
                      : tokenTone === "kpi-warn"
                      ? "var(--warn)"
                      : "var(--accent)",
                  transition: "width 240ms ease",
                }}
              />
            </div>
          )}
        </div>

        {/* Slices */}
        <div className={`kpi ${callsTone}`.trim()}>
          <span className="accent-line" />
          <div className="kpi-label">Slices</div>
          <div className="kpi-value">
            {activeOrDone}
            {sliceTarget && (
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 400,
                  color: "var(--text-subtle)",
                  marginLeft: 6,
                }}
              >
                / {sliceTarget}
              </span>
            )}
          </div>
          <div className="kpi-delta">
            <span style={{ color: "var(--running)" }}>{running} running</span>
            <span style={{ margin: "0 6px", color: "var(--text-subtle)" }}>·</span>
            <span>{completed} completed</span>
            {queued > 0 && (
              <>
                <span style={{ margin: "0 6px", color: "var(--text-subtle)" }}>·</span>
                <span>{queued} queued</span>
              </>
            )}
          </div>
        </div>

        {/* Wallclock */}
        <div className="kpi">
          <span className="accent-line" />
          <div className="kpi-label">Elapsed</div>
          <div className="kpi-value mono">{clock.elapsed}</div>
        </div>
      </div>
    </section>
  );
}
