"use client";

import Link from "next/link";
import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { GeneratedOutputView } from "@/app/components/generated-ui/GeneratedOutputView";
import type { RunMeta } from "@/lib/runs";
import type { StreamEvent, TokenBreakdown, ToolCallSummary } from "@/lib/events";
import { toEvents, getTokenBreakdown, getToolCallSummary } from "@/lib/events";
import { formatDuration, formatTimestamp, formatTokens } from "@/lib/format";
import { Button, Card, Chip } from "@/app/components/ui";
import { statusVariant } from "@/lib/job-helpers";

type Props = {
  name: string;
  ts: string;
  initialMeta: RunMeta;
  initialEvents: StreamEvent[];
  initialFinalMarkdown: string;
  initialStderr: string;
  initialTokenBreakdown: TokenBreakdown & {
    formattedInput: string;
    formattedOutput: string;
    formattedCacheCreation: string;
    formattedCacheRead: string;
    formattedTotal: string;
  };
  initialToolSummary: ToolCallSummary[];
  formattedStarted: string;
  modelLabel: string | null;
  cliLabel: string;
};

const STREAM_EVENT_FLUSH_MS = 250;

type PendingRunEvents = {
  key: string;
  events: StreamEvent[];
};

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

function lastAssistantText(events: StreamEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.kind === "assistant_text") return event.text;
  }
  return null;
}

export function RunDetailClient({
  name, ts,
  initialMeta, initialEvents, initialFinalMarkdown, initialStderr,
  initialTokenBreakdown, initialToolSummary,
  formattedStarted, modelLabel, cliLabel
}: Props) {
  const pageVisible = useDocumentVisible();
  const [meta, setMeta] = useState(initialMeta);
  const [events, setEvents] = useState(initialEvents);
  const [finalMarkdown, setFinalMarkdown] = useState(initialFinalMarkdown);
  const [stderr, setStderr] = useState(initialStderr);
  const [streaming, setStreaming] = useState(initialMeta.status === "running");
  const [elapsed, setElapsed] = useState(0);
  const seenLinesRef = useRef(new Set(initialEvents.map((e) => JSON.stringify(e.raw))));
  const pendingEventsRef = useRef<PendingRunEvents[]>([]);
  const pendingLineKeysRef = useRef(new Set<string>());
  const eventFlushRef = useRef<number | null>(null);
  const startEpochRef = useRef(new Date(initialMeta.started_at).getTime());

  const clearPendingEvents = useCallback(() => {
    if (eventFlushRef.current !== null) {
      window.clearTimeout(eventFlushRef.current);
      eventFlushRef.current = null;
    }
    pendingEventsRef.current = [];
    pendingLineKeysRef.current.clear();
  }, []);

  const flushPendingEvents = useCallback(() => {
    if (eventFlushRef.current !== null) {
      window.clearTimeout(eventFlushRef.current);
      eventFlushRef.current = null;
    }

    const pending = pendingEventsRef.current;
    if (pending.length === 0) return;
    pendingEventsRef.current = [];
    pendingLineKeysRef.current.clear();

    for (const item of pending) seenLinesRef.current.add(item.key);
    const nextEvents = pending.flatMap((item) => item.events);
    const nextFinalMarkdown = lastAssistantText(nextEvents);

    startTransition(() => {
      setEvents((prev) => [...prev, ...nextEvents]);
      if (nextFinalMarkdown !== null) {
        setFinalMarkdown((current) => current === nextFinalMarkdown ? current : nextFinalMarkdown);
      }
    });
  }, []);

  const scheduleEventFlush = useCallback(() => {
    if (eventFlushRef.current !== null) return;
    eventFlushRef.current = window.setTimeout(flushPendingEvents, STREAM_EVENT_FLUSH_MS);
  }, [flushPendingEvents]);

  useEffect(() => {
    if (meta.status !== "running" || !pageVisible) return;
    const t = setInterval(() => setElapsed(Date.now() - startEpochRef.current), 500);
    return () => clearInterval(t);
  }, [meta.status, pageVisible]);

  useEffect(() => {
    if (meta.status !== "running" || !pageVisible) return;

    const es = new EventSource(`/api/runs/${encodeURIComponent(name)}/${encodeURIComponent(ts)}/stream`);

    es.onmessage = (e) => {
      let obj: Record<string, unknown>;
      try { obj = JSON.parse(e.data); } catch { return; }

      if ((obj as { type?: string }).type === "_meta") {
        const m = (obj as { meta: RunMeta }).meta;
        flushPendingEvents();
        setMeta(m);
        setStreaming(false);
        es.close();
        return;
      }

      const lineKey = JSON.stringify(obj);
      if (seenLinesRef.current.has(lineKey) || pendingLineKeysRef.current.has(lineKey)) return;

      const newEvents = toEvents(obj);
      if (newEvents.length === 0) {
        seenLinesRef.current.add(lineKey);
        return;
      }

      pendingLineKeysRef.current.add(lineKey);
      pendingEventsRef.current.push({ key: lineKey, events: newEvents });
      scheduleEventFlush();
    };

    es.onerror = () => {
      flushPendingEvents();
      es.close();
      setStreaming(false);
    };

    return () => {
      es.close();
      clearPendingEvents();
    };
  }, [clearPendingEvents, flushPendingEvents, name, pageVisible, scheduleEventFlush, ts, meta.status]);

  const tokenBreakdown = useMemo(() => {
    const bd = getTokenBreakdown(events);
    return {
      ...bd,
      formattedInput: formatTokens(bd.input),
      formattedOutput: formatTokens(bd.output),
      formattedCacheCreation: formatTokens(bd.cacheCreation),
      formattedCacheRead: formatTokens(bd.cacheRead),
      formattedTotal: formatTokens(bd.total || meta.total_tokens),
    };
  }, [events, meta.total_tokens]);
  const toolSummary = useMemo(() => getToolCallSummary(events), [events]);

  const formattedDuration = meta.status === "running"
    ? formatDuration(elapsed)
    : formatDuration(meta.duration_ms);
  const formattedFinished = meta.finished_at ? formatTimestamp(meta.finished_at) : "—";
  const formattedTokens = formatTokens(meta.total_tokens || tokenBreakdown.total);

  const [expandedEvents, setExpandedEvents] = useState<Set<number>>(new Set());
  const [eventTypeFilter, setEventTypeFilter] = useState<Set<string>>(
    new Set(["assistant_text", "thinking", "tool_use", "tool_result", "result"])
  );
  const bottomRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (streaming && autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [events.length, streaming, autoScroll]);

  const toggleEvent = useCallback((i: number) => {
    setExpandedEvents((prev) => {
      const s = new Set(prev);
      if (s.has(i)) s.delete(i);
      else s.add(i);
      return s;
    });
  }, []);

  const filteredEvents = useMemo(
    () => events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => eventTypeFilter.has(event.kind)),
    [events, eventTypeFilter],
  );
  const numTurns = useMemo(
    () => meta.num_turns ?? (events.filter((e) => e.kind === "result").length || "—"),
    [events, meta.num_turns],
  );

  function cacheEfficiencyLabel(pct: number): string {
    if (pct > 30) return "Excellent";
    if (pct > 15) return "Good";
    if (pct > 5) return "Fair";
    return "Low";
  }

  const variant = statusVariant(meta.status);

  return (
    <div className="space-y-6">
      <nav className="text-sm">
        <Link href={`/jobs/${name}`} className="text-muted hover:text-fg transition">
          ← {name}
        </Link>
      </nav>

      <section>
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-3xl font-semibold tracking-tight">Run</h1>
          <Chip variant={variant} dot className={meta.status === "running" ? "animate-pulse" : ""}>
            {meta.status}
          </Chip>
          {streaming && (
            <span className="text-xs text-[var(--warn)] flex items-center gap-1.5">
              <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              live
            </span>
          )}
        </div>
        <div className="mono text-xs text-subtle mt-2">{ts}</div>
      </section>

      {/* Stderr at top if failed */}
      {meta.status === "failed" && stderr && (
        <Card className="p-5 border-[color-mix(in_srgb,var(--fail)_30%,var(--border))]">
          <div className="label text-[var(--fail)] mb-3">Error output</div>
          <pre className="text-xs whitespace-pre-wrap text-[var(--fail)] opacity-90 overflow-x-auto max-h-[300px] overflow-y-auto mono">{stderr}</pre>
        </Card>
      )}

      {/* Token Breakdown */}
      {tokenBreakdown.total > 0 && (
        <Card className="p-5">
          <div className="label mb-4">Token usage</div>
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <div className="flex-1 h-5 bg-bg-subtle border border-border rounded-full overflow-hidden flex">
                {tokenBreakdown.input > 0 && (
                  <div
                    className="bg-accent"
                    style={{ width: `${(tokenBreakdown.input / tokenBreakdown.total) * 100}%` }}
                    title={`Input: ${tokenBreakdown.formattedInput}`}
                  />
                )}
                {tokenBreakdown.output > 0 && (
                  <div
                    className="bg-[var(--success)]"
                    style={{ width: `${(tokenBreakdown.output / tokenBreakdown.total) * 100}%` }}
                    title={`Output: ${tokenBreakdown.formattedOutput}`}
                  />
                )}
                {tokenBreakdown.cacheCreation > 0 && (
                  <div
                    className="bg-[var(--warn)]"
                    style={{ width: `${(tokenBreakdown.cacheCreation / tokenBreakdown.total) * 100}%` }}
                    title={`Cache Creation: ${tokenBreakdown.formattedCacheCreation}`}
                  />
                )}
                {tokenBreakdown.cacheRead > 0 && (
                  <div
                    className="bg-[color-mix(in_srgb,var(--accent)_60%,transparent)]"
                    style={{ width: `${(tokenBreakdown.cacheRead / tokenBreakdown.total) * 100}%` }}
                    title={`Cache Read: ${tokenBreakdown.formattedCacheRead}`}
                  />
                )}
              </div>
              <span className="text-sm font-semibold tabular-nums">{tokenBreakdown.formattedTotal}</span>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
              <TokenStat label="Input" value={tokenBreakdown.formattedInput} swatch="bg-accent" />
              <TokenStat label="Output" value={tokenBreakdown.formattedOutput} swatch="bg-[var(--success)]" />
              <TokenStat label="Cache creation" value={tokenBreakdown.formattedCacheCreation} swatch="bg-[var(--warn)]" />
              <TokenStat label="Cache read" value={tokenBreakdown.formattedCacheRead} swatch="bg-[color-mix(in_srgb,var(--accent)_60%,transparent)]" />
              <TokenStat
                label="Cache efficiency"
                value={`${tokenBreakdown.cacheEfficiency.toFixed(1)}% · ${cacheEfficiencyLabel(tokenBreakdown.cacheEfficiency)}`}
              />
            </div>
          </div>
        </Card>
      )}

      {/* Tool Call Summary */}
      {toolSummary.length > 0 && (
        <Card className="overflow-hidden">
          <div className="px-5 py-3 border-b border-border label">
            Tool calls <span className="text-subtle">({toolSummary.reduce((a, t) => a + t.count, 0)} total)</span>
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-subtle text-[10px] uppercase tracking-wider">
                <th className="px-5 py-2 font-medium">Tool</th>
                <th className="px-5 py-2 font-medium text-right">Count</th>
                <th className="px-5 py-2 font-medium text-right">Failures</th>
              </tr>
            </thead>
            <tbody>
              {toolSummary.map((tool) => (
                <tr key={tool.toolName} className="border-t border-border hover:bg-bg-hover transition">
                  <td className="px-5 py-2 mono text-xs">{tool.toolName.replace(/^mcp__/, "")}</td>
                  <td className="px-5 py-2 text-right tabular-nums">{tool.count}</td>
                  <td className="px-5 py-2 text-right tabular-nums">
                    <span className={tool.failures > 0 ? "text-[var(--fail)]" : "text-subtle"}>{tool.failures}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* Metadata */}
      <Card className="p-5">
        <div className="grid grid-cols-2 md:grid-cols-7 gap-4 text-sm">
          <Stat label="started" value={formattedStarted} />
          <Stat label="finished" value={formattedFinished} />
          <Stat label="duration" value={formattedDuration} />
          <Stat label="turns" value={String(numTurns)} />
          <Stat label="tokens" value={formattedTokens} />
          <Stat label="cli" value={cliLabel} />
          <Stat label="model" value={modelLabel ?? "default"} />
        </div>
      </Card>

      {/* Final Output */}
	      {finalMarkdown && (
	        <section>
	          <h2 className="text-base font-semibold mb-3">Final output</h2>
	          <Card className="p-6 max-h-[800px] overflow-y-auto">
	            <GeneratedOutputView markdown={finalMarkdown} />
	          </Card>
	        </section>
	      )}

      {/* Timeline */}
      <section>
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className="flex items-baseline gap-3">
            <h2 className="text-base font-semibold">Timeline</h2>
            <span className="text-xs text-subtle">{filteredEvents.length} of {events.length} events</span>
          </div>
          <div className="flex items-center gap-2">
            {streaming && (
              <label className="flex items-center gap-1.5 text-xs text-muted cursor-pointer">
                <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} className="w-3 h-3" />
                auto-scroll
              </label>
            )}
            <Button size="sm" onClick={() => setExpandedEvents(new Set(events.map((_, i) => i)))}>
              Expand all
            </Button>
            <Button size="sm" onClick={() => setExpandedEvents(new Set())}>
              Collapse all
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5 mb-3">
          {["assistant_text", "thinking", "tool_use", "tool_result", "result"].map((type) => {
            const active = eventTypeFilter.has(type);
            return (
              <button
                key={type}
                onClick={() =>
                  setEventTypeFilter((prev) => {
                    const s = new Set(prev);
                    if (s.has(type)) s.delete(type);
                    else s.add(type);
                    return s;
                  })
                }
                className={`px-2.5 py-1 rounded text-xs border transition-colors ${
                  active
                    ? "bg-accent-soft border-[color-mix(in_srgb,var(--accent)_30%,transparent)] text-accent"
                    : "bg-bg-elev border-border text-muted hover:text-fg hover:bg-bg-hover"
                }`}
              >
                {type.replace("_", " ")}
              </button>
            );
          })}
        </div>

        <div className="space-y-2">
          {filteredEvents.map(({ event, index }) => (
            <EventCard
              key={index}
              event={event}
              index={index}
              isExpanded={expandedEvents.has(index)}
              onToggle={toggleEvent}
            />
          ))}
          {filteredEvents.length === 0 && (
            <Card className="p-6 text-center text-muted text-sm">
              {streaming ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin w-4 h-4 text-[var(--warn)]" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Waiting for events…
                </span>
              ) : "No events match the selected filters."}
            </Card>
          )}
          <div ref={bottomRef} />
        </div>
      </section>

      {/* Stderr at bottom if not failed */}
      {meta.status !== "failed" && stderr && (
        <section>
          <h2 className="text-base font-semibold mb-3">stderr</h2>
          <Card className="p-5">
            <pre className="text-xs whitespace-pre-wrap text-muted overflow-x-auto max-h-[300px] overflow-y-auto mono">{stderr}</pre>
          </Card>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="label">{label}</span>
      <span className="text-sm">{value}</span>
    </div>
  );
}

function TokenStat({ label, value, swatch }: { label: string; value: string; swatch?: string }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        {swatch && <span className={`inline-block w-2 h-2 rounded-sm ${swatch}`} />}
        <span className="label">{label}</span>
      </div>
      <div className="text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

const EventCard = memo(function EventCard({
  event,
  index,
  isExpanded,
  onToggle,
}: {
  event: StreamEvent;
  index: number;
  isExpanded: boolean;
  onToggle: (i: number) => void;
}) {
  const toggle = () => onToggle(index);

  if (event.kind === "assistant_text") {
    return (
      <Card className="p-4">
        <div className="label text-accent mb-2">Assistant</div>
        <article className="prose-dashboard text-sm leading-relaxed">
          <ReactMarkdown>{event.text}</ReactMarkdown>
        </article>
      </Card>
    );
  }
  if (event.kind === "thinking") {
    return (
      <Card className="p-4 cursor-pointer" onClick={toggle}>
        <div className="flex items-center justify-between">
          <div className="label">Thinking</div>
          <span className="text-xs text-subtle">{isExpanded ? "–" : "+"}</span>
        </div>
        {isExpanded && <div className="text-sm whitespace-pre-wrap mt-3 text-muted italic">{event.text}</div>}
      </Card>
    );
  }
  if (event.kind === "tool_use") {
    return (
      <Card className="p-4 cursor-pointer" onClick={toggle}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="label text-[var(--warn)]">Tool use</span>
            <span className="mono text-xs">{event.name}</span>
          </div>
          <span className="text-xs text-subtle">{isExpanded ? "–" : "+"}</span>
        </div>
        {isExpanded && (
          <pre className="text-xs whitespace-pre-wrap mt-3 text-muted overflow-x-auto mono bg-bg-subtle border border-border p-3 rounded">
            {JSON.stringify(event.input, null, 2)}
          </pre>
        )}
      </Card>
    );
  }
  if (event.kind === "tool_result") {
    return (
      <Card className="p-4 cursor-pointer" onClick={toggle}>
        <div className="flex items-center justify-between">
          <div className={`label ${event.isError ? "text-[var(--fail)]" : ""}`}>
            Tool result{event.isError ? " · error" : ""}
          </div>
          <span className="text-xs text-subtle">{isExpanded ? "–" : "+"}</span>
        </div>
        {isExpanded && (
          <pre className="text-xs whitespace-pre-wrap mt-3 text-muted overflow-x-auto mono bg-bg-subtle border border-border p-3 rounded max-h-[400px] overflow-y-auto">
            {renderToolResult(event.content)}
          </pre>
        )}
      </Card>
    );
  }
  if (event.kind === "result") {
    return (
      <Card className="p-3 flex items-center gap-4 text-xs text-muted">
        <span className="label">Result</span>
        <span className={event.success ? "text-[var(--success)]" : "text-[var(--fail)]"}>
          {event.success ? "success" : "failed"}
        </span>
        <span>{event.numTurns} turns</span>
        <span className="tabular-nums">{event.totalTokens.toLocaleString()} tokens</span>
      </Card>
    );
  }
  return (
    <Card className="p-4 cursor-pointer" onClick={toggle}>
      <div className="flex items-center justify-between">
        <div className="label">{event.kind}</div>
        <span className="text-xs text-subtle">{isExpanded ? "–" : "+"}</span>
      </div>
      {isExpanded && (
        <pre className="text-xs whitespace-pre-wrap mt-3 text-muted overflow-x-auto mono">{JSON.stringify(event.raw, null, 2)}</pre>
      )}
    </Card>
  );
});

function renderToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === "string") return item;
      const it = item as Record<string, unknown>;
      if (typeof it.text === "string") return it.text;
      return JSON.stringify(it, null, 2);
    }).join("\n");
  }
  return JSON.stringify(content, null, 2);
}
