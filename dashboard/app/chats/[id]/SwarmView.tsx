"use client";

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import Link from "next/link";
import type { SessionMeta, CLI } from "@/lib/runs";
import type { ModelReasoningEffort } from "@/lib/models";
import type { StreamEvent } from "@/lib/events";
import { getTokenBreakdown, toEvents } from "@/lib/events";
import { toClaudeAlias } from "@/lib/claude-models";
import { Button, Chip } from "@/app/components/ui";
import { MessageBubble } from "@/app/components/chat/MessageBubble";
import { Composer, type ComposerHandle } from "@/app/components/chat/Composer";
import { Inspector, type InspectorTool } from "@/app/components/chat/Inspector";
import { ToolSelectionProvider } from "@/app/components/chat/tool-selection";
import type { SliceEntry } from "./SliceLane";
import { SliceLanes } from "./SliceLanes";
import { CLI_SHORT_LABELS, DEFAULT_CLI, normalizeCli } from "@/lib/clis";
import { sessionTitle } from "@/lib/session-utils";
import { SwarmProgress } from "./SwarmProgress";
import { buildTurnChunks } from "./turn-chunks";

type Props = {
  sessionId: string;
  initialMeta: SessionMeta;
  initialEvents: StreamEvent[];
  hiddenMcpImageServers?: string[];
};

const STREAM_EVENT_FLUSH_MS = 250;
const INSPECTOR_WIDTH_KEY = "saturn.inspectorWidth";
const INSPECTOR_COLLAPSED_KEY = "saturn.inspectorCollapsed";
const MOBILE_INSPECTOR_OPEN_KEY = "saturn.mobileInspectorOpen";

function setDocumentInspectorCollapsed(collapsed: boolean) {
  if (typeof document === "undefined") return;
  if (collapsed) {
    document.documentElement.setAttribute("data-chat-inspector-collapsed", "1");
  } else {
    document.documentElement.removeAttribute("data-chat-inspector-collapsed");
  }
}

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

function buildInspectorTools(events: StreamEvent[]): InspectorTool[] {
  const results = new Map<string, { content: unknown; isError: boolean }>();
  const toolIndexesById = new Map<string, number[]>();
  const tools: InspectorTool[] = [];

  for (const ev of events) {
    if (ev.kind === "tool_use") {
      const result = results.get(ev.id);
      const index = tools.length;
      tools.push({
        id: ev.id,
        name: ev.name,
        input: ev.input,
        result: result?.content,
        status: !result ? "run" : result.isError ? "err" : "ok",
      });
      const indexes = toolIndexesById.get(ev.id);
      if (indexes) indexes.push(index);
      else toolIndexesById.set(ev.id, [index]);
    } else if (ev.kind === "tool_result") {
      const result = { content: ev.content, isError: ev.isError };
      results.set(ev.toolUseId, result);
      const indexes = toolIndexesById.get(ev.toolUseId);
      if (!indexes) continue;
      for (const index of indexes) {
        const tool = tools[index];
        tools[index] = {
          ...tool,
          result: result.content,
          status: result.isError ? "err" : "ok",
        };
      }
    }
  }

  return tools;
}

function latestResultEvent(events: StreamEvent[]): StreamEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.kind === "result") return event;
  }
  return null;
}

export function SwarmView({ sessionId, initialMeta, initialEvents, hiddenMcpImageServers }: Props) {
  const pageVisible = useDocumentVisible();
  const [meta, setMeta] = useState<SessionMeta>(initialMeta);
  const metaRef = useRef<SessionMeta>(initialMeta);
  const [events, setEvents] = useState<StreamEvent[]>(initialEvents);
  const seenRef = useRef(new Set(initialEvents.map((e) => JSON.stringify(e.raw))));
  const mountedRef = useRef(false);
  const sseActiveRef = useRef(false);
  const latestSnapshotRequestRef = useRef(0);
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
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [inspectorWidth, setInspectorWidth] = useState(420);
  const [compactInspectorLayout, setCompactInspectorLayout] = useState(false);
  const [activeToolId, setActiveToolId] = useState<string | null>(null);
  const [referencedFiles, setReferencedFiles] = useState<string[]>([]);
  const [fileOpenRequest, setFileOpenRequest] = useState<{ path: string; requestId: number } | null>(null);
  const fileOpenRequestId = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    const stored = Number(window.localStorage.getItem(INSPECTOR_WIDTH_KEY));
    if (Number.isFinite(stored) && stored >= 320 && stored <= 1100) {
      setInspectorWidth(stored);
    }
    const collapsed = window.localStorage.getItem(INSPECTOR_COLLAPSED_KEY) === "1";
    setInspectorCollapsed(collapsed);
    setDocumentInspectorCollapsed(collapsed);
    setMobileInspectorOpen(window.localStorage.getItem(MOBILE_INSPECTOR_OPEN_KEY) === "1");
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem(INSPECTOR_WIDTH_KEY, String(inspectorWidth));
    document.documentElement.style.setProperty("--persisted-inspector-width", `${inspectorWidth}px`);
  }, [inspectorWidth]);

  useEffect(() => {
    window.localStorage.setItem(INSPECTOR_COLLAPSED_KEY, inspectorCollapsed ? "1" : "0");
    setDocumentInspectorCollapsed(inspectorCollapsed);
  }, [inspectorCollapsed]);

  useEffect(() => {
    window.localStorage.setItem(MOBILE_INSPECTOR_OPEN_KEY, mobileInspectorOpen ? "1" : "0");
  }, [mobileInspectorOpen]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 1100px)");
    const sync = () => setCompactInspectorLayout(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

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

  const applySessionSnapshot = useCallback((incoming: SessionMeta, incomingEvents: StreamEvent[]) => {
    if (!mountedRef.current) return;
    if (incoming.turns.length < metaRef.current.turns.length) return;

    flushPendingEvents();
    setMeta((current) => {
      if (incoming.turns.length < current.turns.length) return current;
      return incoming;
    });
    setStreaming(incoming.status === "running");

    startTransition(() => {
      setEvents((current) => {
        const keys = new Set<string>();
        const merged: StreamEvent[] = [];

        for (const event of incomingEvents) {
          const key = JSON.stringify(event.raw);
          if (keys.has(key)) continue;
          keys.add(key);
          merged.push(event);
        }
        for (const event of current) {
          const key = JSON.stringify(event.raw);
          if (keys.has(key)) continue;
          keys.add(key);
          merged.push(event);
        }

        if (merged.length === current.length) {
          let same = true;
          for (let i = 0; i < current.length; i += 1) {
            if (JSON.stringify(current[i].raw) !== JSON.stringify(merged[i].raw)) {
              same = false;
              break;
            }
          }
          if (same) {
            seenRef.current = keys;
            return current;
          }
        }

        seenRef.current = keys;
        return merged;
      });
    });
  }, [flushPendingEvents]);

  const refreshSessionSnapshot = useCallback(async () => {
    if (!mountedRef.current || !pageVisible) return;
    if (sseActiveRef.current && metaRef.current.status === "running") return;
    const requestId = latestSnapshotRequestRef.current + 1;
    latestSnapshotRequestRef.current = requestId;
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = await res.json() as { meta: SessionMeta; events: StreamEvent[] };
      if (!mountedRef.current || requestId !== latestSnapshotRequestRef.current) return;
      applySessionSnapshot(data.meta, data.events ?? []);
    } catch {
      /* ignore */
    }
  }, [applySessionSnapshot, pageVisible, sessionId]);

  // App Router navigation can reuse an older server payload. Freshen once on
  // mount so swarm pages converge without a browser refresh.
  useEffect(() => {
    if (!pageVisible) return;
    const timer = window.setTimeout(() => { void refreshSessionSnapshot(); }, 120);
    return () => window.clearTimeout(timer);
  }, [pageVisible, refreshSessionSnapshot]);

  // SSE is the fast path, but periodic no-store snapshots keep the swarm view
  // moving if the EventSource connection gets interrupted or a browser tab
  // resumes from sleep.
  useEffect(() => {
    if (!pageVisible || (meta.status !== "running" && !streaming)) return;
    const initial = window.setTimeout(() => { void refreshSessionSnapshot(); }, 1200);
    const interval = window.setInterval(() => { void refreshSessionSnapshot(); }, 2500);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [meta.status, pageVisible, refreshSessionSnapshot, streaming]);

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
    let closedByTerminalMeta = false;

    es.onopen = () => {
      sseActiveRef.current = true;
    };

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
        closedByTerminalMeta = true;
        sseActiveRef.current = false;
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
      sseActiveRef.current = false;
      flushPendingEvents();
      void refreshSessionSnapshot();
      if (!closedByTerminalMeta && metaRef.current.status === "running") {
        return;
      }
      es.close();
      setStreaming(false);
    };

    return () => {
      sseActiveRef.current = false;
      es.close();
      clearPendingEvents();
    };
  }, [clearPendingEvents, flushPendingEvents, pageVisible, refreshSessionSnapshot, scheduleEventFlush, sessionId, meta.status, meta.turns.length]);

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
  const tools = useMemo<InspectorTool[]>(() => buildInspectorTools(events), [events]);
  const activeTool = useMemo(
    () => activeToolId ? tools.find((tool) => tool.id === activeToolId) ?? null : null,
    [activeToolId, tools],
  );
  const latestResult = useMemo(() => latestResultEvent(events), [events]);
  const tokens = useMemo(
    () => getTokenBreakdown(latestResult ? [latestResult] : []),
    [latestResult],
  );

  const selectInspectorTool = useCallback((tool: InspectorTool) => {
    setActiveToolId(tool.id);
    setInspectorCollapsed(false);
    setMobileInspectorOpen(true);
  }, []);

  const toolSelection = useMemo(() => ({
    activeId: activeToolId,
    select: selectInspectorTool,
  }), [activeToolId, selectInspectorTool]);

  const openFileInInspector = useCallback((path: string) => {
    const cleaned = path.trim();
    if (!cleaned) return;
    setReferencedFiles((current) => current.includes(cleaned) ? current : [cleaned, ...current]);
    fileOpenRequestId.current += 1;
    setFileOpenRequest({ path: cleaned, requestId: fileOpenRequestId.current });
    setInspectorCollapsed(false);
    setMobileInspectorOpen(true);
  }, []);

  const insertIntoComposer = useCallback((text: string) => {
    composerRef.current?.insertText(text);
  }, []);

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
  const title = sessionTitle(meta);
  const agentId = snap?.id ?? meta.agent_id;
  const agentCliModels = snap?.models;
  const agentCliReasoningEfforts = snap?.reasoningEfforts;
  const headerDetails = [
    title !== agentName ? agentName : undefined,
    meta.agent_snapshot?.description,
    `Session ${sessionId}`,
  ].filter(Boolean).join(" · ");

  const runStartedAt =
    lastTurn?.started_at ??
    (meta as SessionMeta & { last_turn_started_at?: string }).last_turn_started_at ??
    meta.started_at;

  const toggleInspectorPanel = useCallback(() => {
    if (compactInspectorLayout) {
      setMobileInspectorOpen(true);
      return;
    }
    setInspectorCollapsed((current) => !current);
  }, [compactInspectorLayout]);
  const inspectorToggleLabel = compactInspectorLayout || inspectorCollapsed ? "Info panel" : "Hide info panel";
  const inspectorToggleTitle = compactInspectorLayout || inspectorCollapsed ? "Show right panel" : "Hide right panel";

  return (
    <ToolSelectionProvider value={toolSelection}>
      <div
        className={`chat-shell ${mobileInspectorOpen ? "inspector-open" : ""} ${inspectorCollapsed ? "inspector-collapsed" : ""}`.trim()}
        style={{ "--inspector-width": `var(--persisted-inspector-width, ${inspectorWidth}px)` } as CSSProperties}
      >
        <div className="chat-main">
        {/* Header */}
        <header className="chat-header" title={headerDetails || sessionId}>
          <div className="chat-title-row">
            <h1 className="truncate">{title}</h1>
            <Chip variant="accent">orchestrator</Chip>
            <Chip variant="accent">{CLI_SHORT_LABELS[currentCli]}</Chip>
            {currentModel && (
              <Chip className="chat-model-chip">
                <span className="mono truncate">{toClaudeAlias(currentModel) ?? currentModel}</span>
              </Chip>
            )}
            {streaming && (
              <Chip variant="warn" dot>
                live
              </Chip>
            )}
          </div>
          <div className="chat-header-actions">
            {agentId && agentId !== "__adhoc__" && (
              <Link href={`/agents/${encodeURIComponent(agentId)}/edit`}>
                <Button size="sm" variant="ghost">
                  Edit agent
                </Button>
              </Link>
            )}
            <Button
              size="sm"
              variant="ghost"
              className="chat-inspector-toggle"
              onClick={toggleInspectorPanel}
              title={inspectorToggleTitle}
            >
              {inspectorToggleLabel}
            </Button>
          </div>
        </header>

        <div className="chat-stream">
          {/* Primary: progress panel + parallel lanes */}
          <SwarmProgress
            sessionId={sessionId}
            streaming={streaming}
            slices={sliceRuns}
            runStartedAt={runStartedAt}
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
                    onOpenFile={openFileInInspector}
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

      <button
        type="button"
        className="chat-inspector-backdrop"
        onClick={() => setMobileInspectorOpen(false)}
        aria-label="Close inspector panel"
      />

      <Inspector
        session={meta}
        activeTool={activeTool}
        tools={tools}
        tokens={tokens}
        events={events}
        width={inspectorWidth}
        onWidthChange={setInspectorWidth}
        referencedFiles={referencedFiles}
        fileOpenRequest={fileOpenRequest}
        onInsertIntoComposer={insertIntoComposer}
        onClose={() => setMobileInspectorOpen(false)}
      />
    </div>
    </ToolSelectionProvider>
  );
}
