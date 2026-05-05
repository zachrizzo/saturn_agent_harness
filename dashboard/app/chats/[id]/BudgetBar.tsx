"use client";

import { useEffect, useRef, useState } from "react";
import type { Budget, BudgetLimits } from "@/lib/budget";
import { Button } from "@/app/components/ui";

type Props = {
  sessionId: string;
  streaming: boolean;
  onAbort?: () => void;
};

function formatElapsed(startedAt: string): string {
  const startMs = Date.parse(startedAt);
  if (!Number.isFinite(startMs)) return "00:00";
  const elapsed = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
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

export function BudgetBar({ sessionId, streaming, onAbort }: Props) {
  const pageVisible = useDocumentVisible();
  const [budget, setBudget] = useState<Budget | null>(null);
  const [limits, setLimits] = useState<BudgetLimits>({});
  const [aborting, setAborting] = useState(false);
  const [elapsed, setElapsed] = useState("00:00");
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll budget while streaming
  useEffect(() => {
    if (!streaming || !pageVisible) return;

    const controller = new AbortController();
    let inFlight = false;
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
    intervalRef.current = setInterval(poll, 2000);
    return () => {
      controller.abort();
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [pageVisible, sessionId, streaming]);

  // Tick elapsed timer
  useEffect(() => {
    if (!budget?.wallclock_started_at || !pageVisible) return;
    setElapsed(formatElapsed(budget.wallclock_started_at));
    if (!streaming) return;
    const t = setInterval(() => {
      setElapsed(formatElapsed(budget.wallclock_started_at));
    }, 1000);
    return () => clearInterval(t);
  }, [budget?.wallclock_started_at, pageVisible, streaming]);

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

  if (!budget && !streaming) return null;

  const tokensUsed = budget?.tokens_used ?? 0;
  const sliceCalls = budget?.slice_calls ?? 0;
  const maxTokens = limits.max_total_tokens;
  const maxCalls = limits.max_slice_calls;
  const tokenPct = maxTokens ? Math.min(100, (tokensUsed / maxTokens) * 100) : 0;

  return (
    <div
      className="flex items-center gap-4 px-4 py-2 border-t border-border text-[12px]"
      style={{ background: "var(--bg-elev)" }}
    >
      {/* Token progress */}
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-muted whitespace-nowrap">Tokens:</span>
        <span className="mono text-fg">
          {tokensUsed.toLocaleString()}
          {maxTokens ? ` / ${maxTokens.toLocaleString()}` : ""}
        </span>
        {maxTokens && (
          <div className="w-24 h-1.5 rounded-full bg-border overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${tokenPct}%`,
                background:
                  tokenPct > 90
                    ? "var(--fail)"
                    : tokenPct > 70
                    ? "var(--warn)"
                    : "var(--accent)",
              }}
            />
          </div>
        )}
      </div>

      {/* Slice calls */}
      <div className="flex items-center gap-1 text-muted whitespace-nowrap">
        <span>Slices:</span>
        <span className="mono text-fg">
          {sliceCalls}
          {maxCalls ? `/${maxCalls}` : ""}
        </span>
      </div>

      {/* Elapsed */}
      <div className="flex items-center gap-1 text-muted">
        <span className="mono text-fg">{elapsed}</span>
        <span>elapsed</span>
      </div>

      <div className="flex-1" />

      {/* Abort */}
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
  );
}
