"use client";

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { SessionMeta, CLI } from "@/lib/runs";
import type { ModelReasoningEffort } from "@/lib/models";
import type { StreamEvent } from "@/lib/events";
import { toEvents } from "@/lib/events";
import { toClaudeAlias } from "@/lib/claude-models";
import { Button, Chip } from "@/app/components/ui";
import { MessageBubble } from "@/app/components/chat/MessageBubble";
import { Composer, type ComposerHandle } from "@/app/components/chat/Composer";
import type { SliceEntry } from "./SliceLane";
import { SliceLanes } from "./SliceLanes";
import { SliceInspector } from "./SliceInspector";
import { CLI_SHORT_LABELS, DEFAULT_CLI, normalizeCli } from "@/lib/clis";
import { SwarmProgress } from "./SwarmProgress";
import { buildTurnChunks } from "./turn-chunks";

type Props = {
  sessionId: string;
  initialMeta: SessionMeta;
  initialEvents: StreamEvent[];
  hiddenMcpImageServers?: string[];
};

const STREAM_EVENT_FLUSH_MS = 250;

type PendingSwarmEvents = {
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

export function SwarmView({ sessionId, initialMeta, initialEvents, hiddenMcpImageServers }: Props) {
  const pageVisible = useDocumentVisible();
  const [meta, setMeta] = useState<SessionMeta>(initialMeta);
  const metaRef = useRef<SessionMeta>(initialMeta);
  const [events, setEvents] = useState<StreamEvent[]>(initialEvents);
  const seenRef = useRef(new Set(initialEvents.map((e) => JSON.stringify(e.raw))));
  const pendingEventsRef = useRef<PendingSwarmEvents[]>([]);
  const pendingLineKeysRef = useRef(new Set<string>());
  const eventFlushRef = useRef<number | null>(null);
  const [streaming, setStreaming] = useState(initialMeta.status === "running");
  const bottomRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const composerRef = useRef<ComposerHandle>(null);
  const [sliceRuns, setSliceRuns] = useState<SliceEntry[]>([]);
  const sliceRunsKeyRef = useRef(JSON.stringify([]));
  const [activeRunId, setActiveRunId] = useState<string | null>(null);

  // Keep metaRef in sync for use inside SSE callbacks
  useEffect(() => {
    metaRef.current = meta;
  }, [meta]);

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

    for (const item of pending) seenRef.current.add(item.key);
    const nextEvents = pending.flatMap((item) => item.events);

    startTransition(() => {
      setEvents((prev) => [...prev, ...nextEvents]);
    });
  }, []);

  const scheduleEventFlush = useCallback(() => {
    if (eventFlushRef.current !== null) return;
    eventFlushRef.current = window.setTimeout(flushPendingEvents, STREAM_EVENT_FLUSH_MS);
  }, [flushPendingEvents]);

  const applySliceRuns = useCallback((next: SliceEntry[]) => {
    const key = JSON.stringify(next);
    if (sliceRunsKeyRef.current === key) return;
    sliceRunsKeyRef.current = key;
    setSliceRuns(next);
  }, []);

  // Connect SSE whenever status transitions to running
  useEffect(() => {
    if (meta.status !== "running" || !pageVisible) return;
    const params = new URLSearchParams();
    const currentTurnId = meta.turns.at(-1)?.turn_id;
    if (currentTurnId) {
      params.set("from_turn_id", currentTurnId);
    } else {
      params.set("after_turns", String(Math.max(0, meta.turns.length - 1)));
    }
    const query = params.toString();
    const es = new EventSource(
      `/api/sessions/${encodeURIComponent(sessionId)}/stream${query ? `?${query}` : ""}`
    );

    es.onmessage = (e) => {
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(e.data);
      } catch {
        return;
      }

      if ((obj as { type?: string }).type === "_meta") {
        const incoming = (obj as { meta: SessionMeta }).meta;
        // Stale-read guard
        if (incoming.turns.length < metaRef.current.turns.length) return;
        flushPendingEvents();
        setMeta(incoming);
        setStreaming(false);
        es.close();
        return;
      }
      const key = JSON.stringify(obj);
      if (seenRef.current.has(key) || pendingLineKeysRef.current.has(key)) return;
      const parsed = toEvents(obj);
      if (parsed.length === 0) {
        seenRef.current.add(key);
        return;
      }
      pendingLineKeysRef.current.add(key);
      pendingEventsRef.current.push({ key, events: parsed });
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
  }, [clearPendingEvents, flushPendingEvents, pageVisible, scheduleEventFlush, sessionId, meta.status, meta.turns]);

  // Poll slice index. Poll more frequently while streaming; also refresh once
  // after streaming stops so the final durations land in the UI.
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
          `/api/sessions/${encodeURIComponent(sessionId)}/slices`,
          { cache: "no-store", signal: controller.signal }
        );
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) applySliceRuns(Array.isArray(data.slices) ? data.slices : []);
      } catch {
        /* ignore */
      } finally {
        inFlight = false;
      }
    };
    poll();
    if (!streaming) {
      return () => {
        cancelled = true;
        controller.abort();
      };
    }
    const id = setInterval(poll, 1500);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(id);
    };
  }, [applySliceRuns, pageVisible, sessionId, streaming]);

  // Jump to bottom on first mount
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll when new events arrive (within the chat-stream container, not window)
  useEffect(() => {
    if (streaming && autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [events.length, streaming, autoScroll]);

  // `/` to focus composer
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "/") return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const tag = target.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target.isContentEditable
      )
        return;
      e.preventDefault();
      composerRef.current?.focus();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const chunks = useMemo(
    () => buildTurnChunks({ turns: meta.turns, status: meta.status }, events),
    [events, meta.turns, meta.status],
  );

  const sendMessage = useCallback(async (
    message: string,
    cli: CLI,
    model?: string,
    mcpTools?: boolean,
    reasoningEffort?: ModelReasoningEffort,
  ) => {
    setMeta((m) => ({
      ...m,
      status: "running",
      turns: [
        ...m.turns,
        {
          cli,
          model,
          reasoningEffort,
          started_at: new Date().toISOString(),
          user_message: message,
        },
      ],
    }));
    setStreaming(true);

    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message, cli, model, mcpTools, reasoningEffort }),
        }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "failed" }));
        throw new Error(err.error ?? "failed");
      }
    } catch (e) {
      setMeta((m) => ({
        ...m,
        status: "failed",
        turns: m.turns.slice(0, -1),
      }));
      setStreaming(false);
      alert(e instanceof Error ? e.message : "Failed to send");
    }
  }, [sessionId]);

  const stopGeneration = useCallback(async () => {
    setStreaming(false);
    setMeta((m) => ({ ...m, status: "failed" }));
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, {
      method: "POST",
    });
  }, [sessionId]);

  const handleAbort = useCallback(() => {
    setStreaming(false);
    setMeta((m) => ({ ...m, status: "failed" }));
  }, []);

  const handleSliceRerun = useCallback(() => {
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/slices`, {
      cache: "no-store",
    })
      .then((r) => r.json())
      .then((data) => applySliceRuns(Array.isArray(data.slices) ? data.slices : []))
      .catch(() => {});
  }, [applySliceRuns, sessionId]);

  const handleSliceSelect = useCallback((entry: SliceEntry) => {
    setActiveRunId((current) =>
      current === entry.slice_run_id ? null : entry.slice_run_id
    );
  }, []);

  const lastTurn = meta.turns[meta.turns.length - 1];
  const snap = meta.agent_snapshot as
    | (typeof meta.agent_snapshot & {
        defaultCli?: CLI;
        models?: Partial<Record<CLI, string>>;
        reasoningEfforts?: Partial<Record<CLI, ModelReasoningEffort>>;
      })
    | undefined;
  const currentCli: CLI =
    normalizeCli(lastTurn?.cli ?? snap?.defaultCli ?? snap?.cli ?? DEFAULT_CLI);
  const currentModel =
    lastTurn?.model ?? snap?.models?.[currentCli] ?? snap?.model;
  const currentReasoningEffort =
    lastTurn?.reasoningEffort ?? snap?.reasoningEfforts?.[currentCli] ?? snap?.reasoningEffort;
  const agentName = snap?.name ?? "Orchestrator";
  const agentId = snap?.id ?? meta.agent_id;
  const agentCliModels = snap?.models;
  const agentCliReasoningEfforts = snap?.reasoningEfforts;

  const activeSlice =
    sliceRuns.find((s) => s.slice_run_id === activeRunId) ?? null;

  return (
    <div className="chat-shell">
      <div className="chat-main">
        {/* Header */}
        <header className="chat-header">
          <h1 className="truncate">{agentName}</h1>
          <Chip variant="accent">orchestrator</Chip>
          <Chip variant="accent">{CLI_SHORT_LABELS[currentCli]}</Chip>
          {currentModel && (
            <Chip>
              <span className="mono truncate max-w-[180px]">{toClaudeAlias(currentModel) ?? currentModel}</span>
            </Chip>
          )}
          {streaming && (
            <Chip variant="warn" dot>
              live
            </Chip>
          )}
          <div className="ml-auto flex items-center gap-2">
            {agentId && agentId !== "__adhoc__" && (
              <Link href={`/agents/${encodeURIComponent(agentId)}/edit`}>
                <Button size="sm" variant="ghost">
                  Edit agent
                </Button>
              </Link>
            )}
          </div>
          {meta.agent_snapshot?.description && (
            <p
              className="text-[12px] text-muted mt-1 truncate"
              style={{ flexBasis: "100%" }}
            >
              {meta.agent_snapshot.description}
            </p>
          )}
          <div className="session-id">{sessionId}</div>
        </header>

        <div className="chat-stream">
          {/* Primary: progress panel + parallel lanes */}
          <SwarmProgress
            sessionId={sessionId}
            streaming={streaming}
            slices={sliceRuns}
            onAbort={handleAbort}
          />

          <SliceLanes
            slices={sliceRuns}
            streaming={streaming}
            activeRunId={activeRunId}
            onSelect={handleSliceSelect}
          />

          {/* Secondary: orchestrator's own thoughts + tool chips */}
          <div className="flex items-center gap-2 pt-2">
            <span className="eyebrow">Orchestrator Messages</span>
            <div
              className="flex-1"
              style={{ borderTop: "1px solid var(--border)" }}
            />
          </div>

          {chunks.length === 0 && (
            <div className="card p-10 text-center text-muted text-[13px]">
              Orchestrator is starting…
            </div>
          )}
          {chunks.map((chunk, idx) => {
            const prevCli = idx > 0 ? chunks[idx - 1].cli : null;
            const showCliTransition =
              chunk.turnIndex > 0 && chunk.cli !== prevCli;

            return (
              <div key={chunk.turnIndex} className="space-y-2">
                {showCliTransition && (
                  <div className="flex items-center gap-2 py-2">
                    <div className="flex-1 border-t border-border" />
                    <Chip variant="accent" className="text-[10px]">
                      Switched to {CLI_SHORT_LABELS[chunk.cli]}
                    </Chip>
                    <div className="flex-1 border-t border-border" />
                  </div>
                )}
                {chunk.userMessage && (
                  <MessageBubble
                    kind="user"
                    message={chunk.userMessage}
                    cli={chunk.cli}
                    model={chunk.model}
                    reasoningEffort={chunk.reasoningEffort}
                    sessionId={sessionId}
                  />
                )}
                <MessageBubble
                  kind="assistant"
                  events={chunk.events}
                  streaming={chunk.streaming}
                  sessionId={sessionId}
                  hiddenMcpImageServers={hiddenMcpImageServers}
                />
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>

        {/* Composer — stays at the bottom of the main column */}
        <div className="pt-2">
          <Composer
            ref={composerRef}
            currentCli={currentCli}
            currentModel={currentModel}
            currentReasoningEffort={currentReasoningEffort}
            agentCliModels={agentCliModels}
            agentCliReasoningEfforts={agentCliReasoningEfforts}
            disabled={streaming}
            onSend={sendMessage}
            onStop={stopGeneration}
            sessionId={sessionId}
          />
        </div>
      </div>

      {/* Right inspector — reuses the .inspector shell from globals.css */}
      <SliceInspector
        sessionId={sessionId}
        entry={activeSlice}
        onRerun={handleSliceRerun}
        onClose={activeSlice ? () => setActiveRunId(null) : undefined}
      />
    </div>
  );
}
