"use client";

import { startTransition, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { SessionMeta, CLI, PlanAction } from "@/lib/runs";
import type { ModelReasoningEffort } from "@/lib/models";
import type { StreamEvent } from "@/lib/events";
import { toClaudeAlias } from "@/lib/claude-models";
import { toEvents, getTokenBreakdown } from "@/lib/events";
import { Button, Chip } from "@/app/components/ui";
import { MessageBubble } from "@/app/components/chat/MessageBubble";
import { Composer, type ComposerHandle } from "@/app/components/chat/Composer";
import { Inspector, type InspectorTool } from "@/app/components/chat/Inspector";
import { ToolSelectionProvider } from "@/app/components/chat/tool-selection";
import { buildTurnChunks } from "./turn-chunks";
import type { TurnChunk } from "./turn-chunks";
import { CLI_SHORT_LABELS, DEFAULT_CLI, normalizeCli } from "@/lib/clis";

type Props = {
  sessionId: string;
  initialMeta: SessionMeta;
  initialEvents: StreamEvent[];
  initialEventsPartial?: boolean;
  pendingMessage?: string;
  hiddenMcpImageServers?: string[];
};
type SseStartOverride =
  | { mode: "afterTurnId"; turnId: string }
  | { mode: "afterTurns"; count: number };

const STREAM_EVENT_FLUSH_MS = 250;
const INITIAL_VISIBLE_TURNS = 4;
const VISIBLE_TURN_INCREMENT = 8;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stableValueKey(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }

  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function rawItem(event: StreamEvent): Record<string, unknown> {
  return asRecord(asRecord(event.raw).item);
}

function rawMessage(event: StreamEvent): Record<string, unknown> {
  return asRecord(asRecord(event.raw).message);
}

function rawType(event: StreamEvent): string {
  const raw = asRecord(event.raw);
  return stringField(raw, "type") ?? event.kind;
}

function rawSubtype(event: StreamEvent): string {
  return stringField(asRecord(event.raw), "subtype") ?? "";
}

function rawItemIdentity(event: StreamEvent): string | undefined {
  const item = rawItem(event);
  const id = stringField(item, "id");
  if (!id) return undefined;
  return `item:${id}:${rawType(event)}:${stringField(item, "status") ?? ""}`;
}

function turnIdFromMetaTurn(turn: SessionMeta["turns"][number] | undefined): string | undefined {
  const value = (turn as Record<string, unknown> | undefined)?.turn_id;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function streamEventKey(event: StreamEvent): string {
  const itemIdentity = rawItemIdentity(event);
  const raw = asRecord(event.raw);
  const parent = "parentToolUseId" in event ? event.parentToolUseId ?? "" : "";

  switch (event.kind) {
    case "tool_use":
      return event.id
        ? `tool_use:${parent}:${event.id}:${event.name}`
        : `tool_use:${parent}:${itemIdentity ?? stableValueKey(event.input)}:${event.name}`;
    case "tool_result":
      return itemIdentity
        ? `tool_result:${parent}:${event.toolUseId}:${itemIdentity}:${event.isError ? "err" : "ok"}`
        : `tool_result:${parent}:${event.toolUseId}:${rawType(event)}:${event.isError ? "err" : "ok"}:${stableValueKey(event.content)}`;
    case "assistant_text":
    case "plan_text":
    case "thinking":
      return itemIdentity
        ? `${event.kind}:${itemIdentity}`
        : `${event.kind}:${stringField(rawMessage(event), "id") ?? ""}:${rawType(event)}:${stableValueKey(event.text)}`;
    case "todo_list":
      return `${event.kind}:${itemIdentity ?? ""}:${stableValueKey(event.items)}`;
    case "result": {
      const resultId = stringField(raw, "uuid") ?? stringField(raw, "turn_id") ?? stableValueKey(event.raw);
      return `result:${resultId}:${rawType(event)}:${rawSubtype(event)}:${event.success ? "ok" : "err"}:${event.totalTokens}:${event.numTurns}`;
    }
    case "system":
      return `system:${rawType(event)}:${rawSubtype(event)}:${stringField(raw, "session_id") ?? stringField(raw, "thread_id") ?? ""}`;
    case "user":
      return `user:${stringField(rawMessage(event), "id") ?? itemIdentity ?? stableValueKey(event.raw)}`;
    case "other":
      return `other:${event.type}:${itemIdentity ?? stableValueKey(event.raw)}`;
  }
}

export function ChatView({
  sessionId,
  initialMeta,
  initialEvents,
  initialEventsPartial,
  pendingMessage,
  hiddenMcpImageServers,
}: Props) {
  const router = useRouter();

  useEffect(() => {
    router.prefetch("/chats");
    router.prefetch("/chats/new");
  }, [router]);

  // Refresh the layout (sidebar recents) once on mount when arriving from a
  // fresh session create — the new session is in meta.json by the time we land.
  useEffect(() => {
    if (pendingMessage) router.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If run-turn.sh hasn't written the turn stub yet, synthesise one from the
  // URL param so the user bubble shows immediately while streaming.
  const syntheticTurn: SessionMeta["turns"][number] | null =
    pendingMessage && initialMeta.turns.length === 0
      ? {
          cli: normalizeCli(initialMeta.agent_snapshot?.cli ?? DEFAULT_CLI),
          model: initialMeta.agent_snapshot?.model,
          reasoningEffort: initialMeta.agent_snapshot?.reasoningEffort,
          started_at: initialMeta.started_at,
          user_message: pendingMessage,
        }
      : null;

  const initialMetaWithSynthetic = syntheticTurn
    ? { ...initialMeta, turns: [syntheticTurn] }
    : initialMeta;
  const [meta, setMeta] = useState<SessionMeta>(initialMetaWithSynthetic);
  const metaRef = useRef<SessionMeta>(initialMetaWithSynthetic);
  const [events, setEvents] = useState<StreamEvent[]>(initialEvents);
  const [eventsPartial, setEventsPartial] = useState(Boolean(initialEventsPartial));
  const renderedEvents = useDeferredValue(events);
  const seenRef = useRef(new Set(initialEvents.map(streamEventKey)));
  const pendingEventsRef = useRef<StreamEvent[]>([]);
  const eventFlushRef = useRef<number | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const sseStartOverrideRef = useRef<SseStartOverride | null>(null);
  const sseActiveRef = useRef(false);
  const [streaming, setStreaming] = useState(initialMeta.status === "running");
  const [autoScroll, setAutoScroll] = useState(true);
  const [atBottom, setAtBottom] = useState(true);
  const [historyLoading, setHistoryLoading] = useState(false);
  const composerRef = useRef<ComposerHandle>(null);
  const chatBottomRef = useRef<HTMLDivElement | null>(null);
  const didInitialBottomPinRef = useRef(false);
  const preserveScrollRef = useRef<{ top: number; height: number } | null>(null);
  const initialFreshenSessionRef = useRef<string | null>(null);
  const [editingTurnIndex, setEditingTurnIndex] = useState<number | null>(null);
  const turnRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [inspectorWidth, setInspectorWidth] = useState(420);
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const [referencedFiles, setReferencedFiles] = useState<string[]>([]);
  const [fileOpenRequest, setFileOpenRequest] = useState<{ path: string; requestId: number } | null>(null);
  const fileOpenRequestId = useRef(0);
  const [visibleTurnCount, setVisibleTurnCount] = useState(INITIAL_VISIBLE_TURNS);

  // Tool selection — drives Inspector content.
  const [activeToolId, setActiveToolId] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<InspectorTool | null>(null);

  // Mark this chat as read on mount (fire-and-forget).
  useEffect(() => {
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ read_at: new Date().toISOString() }),
    }).catch(() => {});
  }, [sessionId]);

  useEffect(() => {
    const stored = Number(window.localStorage.getItem("saturn.inspectorWidth"));
    if (Number.isFinite(stored) && stored >= 320 && stored <= 1100) {
      setInspectorWidth(stored);
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem("saturn.inspectorWidth", String(inspectorWidth));
  }, [inspectorWidth]);

  // Keep metaRef in sync for use inside SSE callbacks
  useEffect(() => { metaRef.current = meta; }, [meta]);

  const flushPendingEvents = useCallback(() => {
    eventFlushRef.current = null;
    const pending = pendingEventsRef.current;
    if (pending.length === 0) return;
    pendingEventsRef.current = [];
    startTransition(() => {
      setEvents((prev) => [...prev, ...pending]);
    });
  }, []);

  const scheduleEventFlush = useCallback(() => {
    if (eventFlushRef.current !== null) return;
    eventFlushRef.current = window.setTimeout(flushPendingEvents, STREAM_EVENT_FLUSH_MS);
  }, [flushPendingEvents]);

  const cancelPendingEventFlush = useCallback(() => {
    if (eventFlushRef.current !== null) {
      window.clearTimeout(eventFlushRef.current);
      eventFlushRef.current = null;
    }
    pendingEventsRef.current = [];
  }, []);

  const pauseLiveUpdatesForNavigation = useCallback(() => {
    sseActiveRef.current = false;
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    cancelPendingEventFlush();
  }, [cancelPendingEventFlush]);

  useEffect(() => {
    const onInternalNavigation = (event: PointerEvent) => {
      const target = event.target as Element | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor) return;
      const href = anchor.getAttribute("href") ?? "";
      if (!href.startsWith("/") || href.startsWith("//") || href.startsWith("/api/")) return;

      const nextUrl = new URL(href, window.location.origin);
      if (nextUrl.pathname === window.location.pathname && nextUrl.search === window.location.search) return;
      pauseLiveUpdatesForNavigation();
    };

    document.addEventListener("pointerdown", onInternalNavigation, true);
    return () => document.removeEventListener("pointerdown", onInternalNavigation, true);
  }, [pauseLiveUpdatesForNavigation]);

  const applySessionSnapshot = useCallback((incoming: SessionMeta, incomingEvents: StreamEvent[]) => {
    if (incoming.turns.length >= metaRef.current.turns.length) {
      setMeta(incoming);
      setStreaming(incoming.status === "running");
    }
    cancelPendingEventFlush();
    startTransition(() => {
      setEvents((prev) => {
        const incomingKeys = incomingEvents.map(streamEventKey);
        const hasUnseenIncomingEvent = incomingKeys.some((key) => !seenRef.current.has(key));
        if (incomingEvents.length < prev.length && !hasUnseenIncomingEvent) return prev;
        seenRef.current = new Set(incomingKeys);
        return incomingEvents;
      });
    });
  }, [cancelPendingEventFlush]);

  const refreshSessionSnapshot = useCallback(async () => {
    if (sseActiveRef.current && metaRef.current.status === "running") return;
    try {
      const params = new URLSearchParams();
      if (eventsPartial) {
        params.set("events", "recent");
        params.set("compact", "1");
      }
      const query = params.size > 0 ? `?${params.toString()}` : "";
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}${query}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = await res.json() as { meta: SessionMeta; events: StreamEvent[]; eventsPartial?: boolean };
      applySessionSnapshot(data.meta, data.events ?? []);
      setEventsPartial(Boolean(data.eventsPartial));
    } catch {}
  }, [applySessionSnapshot, eventsPartial, sessionId]);

  // Client-side navigation can reuse an older App Router payload. Do one cheap
  // no-store snapshot after mount so the opened chat converges without a manual
  // browser refresh.
  useEffect(() => {
    if (initialFreshenSessionRef.current === sessionId) return;
    initialFreshenSessionRef.current = sessionId;
    const timer = window.setTimeout(() => { void refreshSessionSnapshot(); }, 80);
    return () => window.clearTimeout(timer);
  }, [refreshSessionSnapshot, sessionId]);

  useEffect(() => {
    if (meta.status !== "running" && !streaming) return;
    const initial = window.setTimeout(() => { void refreshSessionSnapshot(); }, 1200);
    const interval = window.setInterval(() => { void refreshSessionSnapshot(); }, 2500);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [meta.status, refreshSessionSnapshot, streaming]);

  // Connect SSE whenever status transitions to running
  useEffect(() => {
    if (meta.status !== "running") return;
    const params = new URLSearchParams();
    const override = sseStartOverrideRef.current;
    sseStartOverrideRef.current = null;
    if (override?.mode === "afterTurnId") {
      params.set("after_turn_id", override.turnId);
    } else if (override?.mode === "afterTurns") {
      params.set("after_turns", String(override.count));
    } else {
      const currentTurnId = turnIdFromMetaTurn(meta.turns.at(-1));
      if (currentTurnId) {
        params.set("from_turn_id", currentTurnId);
      } else {
        params.set("after_turns", String(Math.max(0, meta.turns.length - 1)));
      }
    }
    const es = new EventSource(
      `/api/sessions/${encodeURIComponent(sessionId)}/stream?${params.toString()}`
    );
    eventSourceRef.current = es;
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
        // Stale-read guard: if the server snapshot has fewer turns than our
        // optimistic state, run-turn.sh hasn't written the new turn yet.
        if (incoming.turns.length < metaRef.current.turns.length) return;
        closedByTerminalMeta = true;
        sseActiveRef.current = false;
        flushPendingEvents();
        setMeta(incoming);
        setStreaming(false);
        window.setTimeout(() => { void refreshSessionSnapshot(); }, 120);
        startTransition(() => router.refresh());
        es.close();
        if (eventSourceRef.current === es) eventSourceRef.current = null;
        return;
      }
      const parsed = toEvents(obj);
      if (parsed.length === 0) return;
      const fresh = parsed.filter((event) => {
        const key = streamEventKey(event);
        if (seenRef.current.has(key)) return false;
        seenRef.current.add(key);
        return true;
      });
      if (fresh.length === 0) return;
      pendingEventsRef.current.push(...fresh);
      scheduleEventFlush();
    };
    es.onerror = () => {
      sseActiveRef.current = false;
      void refreshSessionSnapshot();
      if (!closedByTerminalMeta && metaRef.current.status === "running") {
        return;
      }
      es.close();
      if (eventSourceRef.current === es) eventSourceRef.current = null;
      setStreaming(false);
    };

    return () => {
      sseActiveRef.current = false;
      es.close();
      if (eventSourceRef.current === es) eventSourceRef.current = null;
      cancelPendingEventFlush();
    };
  }, [cancelPendingEventFlush, flushPendingEvents, refreshSessionSnapshot, router, scheduleEventFlush, sessionId, meta.status, meta.turns.length]);

  const getChatScrollElement = useCallback(() => (
    chatBottomRef.current?.closest<HTMLElement>('[data-shell="chat-scroll"]')
      ?? chatBottomRef.current?.closest<HTMLElement>('[data-shell="main-scroll"]')
      ?? document.scrollingElement
      ?? document.documentElement
  ), []);

  const scrollToEnd = useCallback((behavior: ScrollBehavior = "auto") => {
    const scrollEl = getChatScrollElement();
    const bottomMarker = chatBottomRef.current;
    if (bottomMarker) {
      const markerRect = bottomMarker.getBoundingClientRect();
      const scrollerRect = scrollEl instanceof HTMLElement
        ? scrollEl.getBoundingClientRect()
        : { bottom: window.innerHeight };
      const targetTop = scrollEl.scrollTop + markerRect.bottom - scrollerRect.bottom + 12;
      scrollEl.scrollTo({ top: Math.max(0, targetTop), behavior });
      return;
    }

    const targetHeight = Math.max(
      scrollEl.scrollHeight,
      document.documentElement.scrollHeight,
      document.body.scrollHeight,
    );
    scrollEl.scrollTo({ top: Math.max(0, targetHeight - scrollEl.clientHeight), behavior });
  }, [getChatScrollElement]);

  const chunks = useMemo<TurnChunk[]>(() => {
    return buildTurnChunks(meta, renderedEvents);
  }, [renderedEvents, meta.turns, meta.status]);

  const hiddenTurnCount = Math.max(0, chunks.length - visibleTurnCount);
  const visibleChunks = useMemo(
    () => chunks.slice(hiddenTurnCount),
    [chunks, hiddenTurnCount],
  );
  const historyGateLabel = historyLoading
    ? "Loading..."
    : eventsPartial
      ? "Load full details"
      : hiddenTurnCount > 0
      ? `Load ${Math.min(VISIBLE_TURN_INCREMENT, hiddenTurnCount)} earlier`
      : "Load full details";
  const historyGateDetail = eventsPartial && hiddenTurnCount > 0
    ? `${hiddenTurnCount.toLocaleString()} older turn${hiddenTurnCount === 1 ? "" : "s"} and full tool details hidden`
    : hiddenTurnCount > 0
    ? `${hiddenTurnCount.toLocaleString()} older turn${hiddenTurnCount === 1 ? "" : "s"} hidden`
    : "Full tool details are deferred for faster opening";

  const loadEarlierTurns = useCallback(async () => {
    if (historyLoading) return;
    const scrollEl = getChatScrollElement();
    preserveScrollRef.current = {
      top: scrollEl.scrollTop,
      height: scrollEl.scrollHeight,
    };
    let shouldRevealEarlierTurns = true;
    if (eventsPartial) {
      shouldRevealEarlierTurns = false;
      setHistoryLoading(true);
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}?events=all`, {
          cache: "no-store",
        });
        if (res.ok) {
          const data = await res.json() as { meta: SessionMeta; events: StreamEvent[]; eventsPartial?: boolean };
          applySessionSnapshot(data.meta, data.events ?? []);
          setEventsPartial(Boolean(data.eventsPartial));
          shouldRevealEarlierTurns = true;
        }
      } catch {
        shouldRevealEarlierTurns = false;
      } finally {
        setHistoryLoading(false);
      }
    }
    if (shouldRevealEarlierTurns) {
      setVisibleTurnCount((current) => current + VISIBLE_TURN_INCREMENT);
    } else {
      preserveScrollRef.current = null;
    }
  }, [applySessionSnapshot, eventsPartial, getChatScrollElement, historyLoading, sessionId]);

  useLayoutEffect(() => {
    const snapshot = preserveScrollRef.current;
    if (!snapshot) return;
    preserveScrollRef.current = null;
    const scrollEl = getChatScrollElement();
    scrollEl.scrollTop = Math.max(0, scrollEl.scrollHeight - snapshot.height + snapshot.top);
  }, [getChatScrollElement, visibleChunks.length]);

  // Long transcripts continue laying out for a few frames. Keep the first open
  // pinned to the latest turn until the bottom sentinel has settled.
  useLayoutEffect(() => {
    if (didInitialBottomPinRef.current) return;
    if (chunks.length === 0 && !pendingMessage) return;
    didInitialBottomPinRef.current = true;
    setAutoScroll(true);
    setAtBottom(true);
    scrollToEnd("auto");

    const rafOne = window.requestAnimationFrame(() => scrollToEnd("auto"));
    const rafTwo = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => scrollToEnd("auto"));
    });
    const timers = [80, 240, 700].map((delay) => window.setTimeout(() => scrollToEnd("auto"), delay));
    return () => {
      window.cancelAnimationFrame(rafOne);
      window.cancelAnimationFrame(rafTwo);
      timers.forEach(window.clearTimeout);
    };
  }, [chunks.length, pendingMessage, scrollToEnd]);

  // Auto-scroll when new events arrive (while streaming AND user hasn't scrolled up)
  useEffect(() => {
    if (streaming && autoScroll) {
      scrollToEnd("auto");
    }
  }, [renderedEvents.length, streaming, autoScroll, scrollToEnd]);

  // Track whether the user is near the bottom — shows/hides the scroll-to-bottom button
  useEffect(() => {
    const scrollEl = getChatScrollElement();
    const onScroll = () => {
      const threshold = 200;
      const markerBottom = chatBottomRef.current?.getBoundingClientRect().bottom;
      const scrollerBottom = scrollEl instanceof HTMLElement
        ? scrollEl.getBoundingClientRect().bottom
        : window.innerHeight;
      const distFromBottom =
        markerBottom === undefined
          ? scrollEl.scrollHeight - (scrollEl.scrollTop + scrollEl.clientHeight)
          : markerBottom - scrollerBottom;
      const nearBottom = distFromBottom < threshold;
      setAtBottom(nearBottom);
      // If user scrolls up mid-stream, pause autoscroll; resume when they return.
      if (streaming) setAutoScroll(nearBottom);
    };
    onScroll();
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    return () => scrollEl.removeEventListener("scroll", onScroll);
  }, [getChatScrollElement, streaming]);

  const scrollToBottom = () => {
    setAutoScroll(true);
    setAtBottom(true);
    scrollToEnd("smooth");
    window.requestAnimationFrame(() => scrollToEnd("smooth"));
    window.setTimeout(() => scrollToEnd("auto"), 220);
  };

  // `/` to focus composer (unless already in an input/textarea)
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
      ) {
        return;
      }
      e.preventDefault();
      composerRef.current?.focus();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Collect tool events (order preserved) for the inspector's summary.
  const tools = useMemo<InspectorTool[]>(() => {
    const results = new Map<string, { content: unknown; isError: boolean }>();
    for (const ev of renderedEvents) {
      if (ev.kind === "tool_result") {
        results.set(ev.toolUseId, { content: ev.content, isError: ev.isError });
      }
    }
    const out: InspectorTool[] = [];
    for (const ev of renderedEvents) {
      if (ev.kind !== "tool_use") continue;
      const res = results.get(ev.id);
      out.push({
        id: ev.id,
        name: ev.name,
        input: ev.input,
        result: res?.content,
        status: !res ? "run" : res.isError ? "err" : "ok",
      });
    }
    return out;
  }, [renderedEvents]);

  // Auto-select the latest failed tool while streaming so errors surface immediately.
  useEffect(() => {
    if (!streaming) return;
    const latestFailed = [...tools].reverse().find((t) => t.status === "err");
    if (latestFailed && latestFailed.id !== activeToolId) {
      setActiveToolId(latestFailed.id);
      setActiveTool(latestFailed);
    }
  }, [streaming, tools, activeToolId]);

  // Keep activeTool payload in sync with latest tool state (result may arrive later).
  useEffect(() => {
    if (!activeToolId) return;
    const refreshed = tools.find((t) => t.id === activeToolId) ?? null;
    setActiveTool(refreshed);
  }, [tools, activeToolId]);

  const tokens = useMemo(() => getTokenBreakdown(renderedEvents), [renderedEvents]);
  const runningTools = useMemo(() => tools.filter((tool) => tool.status === "run"), [tools]);
  const streamActivityLabel = useMemo(() => {
    const latestTool = [...runningTools].reverse()[0];
    if (latestTool) return `Running ${latestTool.name}`;
    if (renderedEvents.length > 0) {
      const latest = renderedEvents[renderedEvents.length - 1];
      if (latest.kind === "assistant_text") return "Receiving answer";
      if (latest.kind === "thinking") return "Reasoning";
      if (latest.kind === "tool_result") return "Processing tool result";
    }
    return "Waiting for first token";
  }, [renderedEvents, runningTools]);
  const streamActivityDetail = useMemo(() => {
    if (runningTools.length > 0) {
      return `${runningTools.length} tool${runningTools.length === 1 ? "" : "s"} active`;
    }
    return `${events.length.toLocaleString()} event${events.length === 1 ? "" : "s"}`;
  }, [events.length, runningTools.length]);

  const awaitingPlanApproval = meta.plan_mode?.status === "awaiting_approval";

  const doFork = async (message: string, atTurn?: number) => {
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/fork`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, at_turn: atTurn }),
      },
    );
    if (!res.ok) { alert(`Fork failed: ${res.status}`); return; }
    const { session_id } = (await res.json()) as { session_id: string };
    window.location.href = `/chats/${encodeURIComponent(session_id)}`;
  };

  const doEdit = async (
    message: string,
    atTurn: number,
    cli: CLI,
    model?: string,
    mcpTools?: boolean,
    reasoningEffort?: ModelReasoningEffort,
  ) => {
    const normalizedCli = normalizeCli(cli);
    const previousTurnId = turnIdFromMetaTurn(metaRef.current.turns[atTurn - 1]);
    sseStartOverrideRef.current = previousTurnId
      ? { mode: "afterTurnId", turnId: previousTurnId }
      : { mode: "afterTurns", count: Math.max(0, atTurn) };
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/edit`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, at_turn: atTurn, cli: normalizedCli, model, mcpTools, reasoningEffort }),
      },
    );
    if (!res.ok) {
      sseStartOverrideRef.current = null;
      alert(`Edit failed: ${res.status}`);
      return;
    }

    // Truncate events to only those belonging to turns 0..atTurn-1.
    // Each completed turn ends with a "result" event; keep everything up to
    // the atTurn-th result (exclusive of subsequent events).
    setEvents((prev) => {
      if (atTurn === 0) {
        seenRef.current = new Set<string>();
        return [];
      }
      let resultsSeen = 0;
      let cutIdx = prev.length;
      for (let i = 0; i < prev.length; i++) {
        if (prev[i].kind === "result") {
          resultsSeen++;
          if (resultsSeen >= atTurn) { cutIdx = i + 1; break; }
        }
      }
      const kept = prev.slice(0, cutIdx);
      seenRef.current = new Set(kept.map(streamEventKey));
      return kept;
    });

    setMeta((m) => ({
      ...m,
      status: "running",
      turns: [
        ...m.turns.slice(0, atTurn),
        {
          cli: normalizedCli,
          model,
          reasoningEffort,
          started_at: new Date().toISOString(),
          user_message: message,
        },
      ],
    }));
    setStreaming(true);
  };

  const editFromMessage = (message: string, turnIndex: number) => {
    if (!turnRefs.current.has(turnIndex)) {
      setVisibleTurnCount((current) => Math.max(current, chunks.length - turnIndex));
    }
    setEditingTurnIndex(turnIndex);
    composerRef.current?.setDraft(message);
    // Scroll to that turn bubble
    const el = turnRefs.current.get(turnIndex);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    // Then after a moment scroll back down to show the composer too
    setTimeout(() => {
      scrollToEnd("smooth");
    }, 600);
  };

  const cancelEdit = () => {
    setEditingTurnIndex(null);
    composerRef.current?.setDraft("");
  };

  const openFileInInspector = useCallback((path: string) => {
    const cleaned = path.trim();
    if (!cleaned) return;
    setReferencedFiles((current) => current.includes(cleaned) ? current : [cleaned, ...current]);
    fileOpenRequestId.current += 1;
    setFileOpenRequest({ path: cleaned, requestId: fileOpenRequestId.current });
    setMobileInspectorOpen(true);
  }, []);

  const insertIntoComposer = useCallback((text: string) => {
    composerRef.current?.insertText(text);
  }, []);

  const stopGeneration = useCallback(async () => {
    try {
      await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, { method: "POST" });
      await refreshSessionSnapshot();
    } finally {
      setStreaming(false);
      setMeta((m) => ({ ...m, status: "failed" }));
    }
  }, [refreshSessionSnapshot, sessionId]);

  const sendMessage = useCallback(async (
    message: string,
    cli: CLI,
    model?: string,
    mcpTools?: boolean,
    reasoningEffort?: ModelReasoningEffort,
    planAction?: PlanAction,
  ) => {
    const previousTurnId = turnIdFromMetaTurn(metaRef.current.turns.at(-1));
    sseStartOverrideRef.current = previousTurnId
      ? { mode: "afterTurnId", turnId: previousTurnId }
      : { mode: "afterTurns", count: metaRef.current.turns.length };
    const effectivePlanAction =
      planAction ?? (metaRef.current.plan_mode?.status === "awaiting_approval" ? "revise" : undefined);
    setMeta((m) => ({
      ...m,
      status: "running",
      turns: [
        ...m.turns,
        {
          cli,
          model,
          reasoningEffort,
          plan_action: effectivePlanAction,
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
          body: JSON.stringify({ message, cli, model, mcpTools, reasoningEffort, planAction: effectivePlanAction }),
        }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "failed" }));
        throw new Error(err.error ?? "failed");
      }
    } catch (e) {
      sseStartOverrideRef.current = null;
      setMeta((m) => ({
        ...m,
        status: "failed",
        turns: m.turns.slice(0, -1),
      }));
      setStreaming(false);
      alert(e instanceof Error ? e.message : "Failed to send");
    }
  }, [sessionId]);

  const approvePlan = () => {
    void sendMessage(
      "The proposed plan is approved. Implement it now.",
      currentCli,
      currentModel,
      undefined,
      currentReasoningEffort,
      "approve",
    );
  };

  const revisePlan = () => {
    composerRef.current?.setDraft("Revise the plan: ");
  };

  const lastTurn = meta.turns[meta.turns.length - 1];
  const snap = meta.agent_snapshot as (typeof meta.agent_snapshot & {
    defaultCli?: CLI;
    models?: Partial<Record<CLI, string>>;
    reasoningEfforts?: Partial<Record<CLI, ModelReasoningEffort>>;
  }) | undefined;
  const currentCli: CLI = normalizeCli(lastTurn?.cli ?? snap?.defaultCli ?? snap?.cli ?? DEFAULT_CLI);
  const currentModel = lastTurn?.model ?? snap?.models?.[currentCli] ?? snap?.model;
  const currentReasoningEffort =
    lastTurn?.reasoningEffort ?? snap?.reasoningEfforts?.[currentCli] ?? snap?.reasoningEffort;
  const agentName = snap?.name ?? "Ad-hoc";
  const agentId = snap?.id ?? meta.agent_id;
  const agentCliModels = snap?.models;
  const agentCliReasoningEfforts = snap?.reasoningEfforts;
  const headerDetails = [
    meta.agent_snapshot?.description,
    meta.agent_snapshot?.cwd,
    sessionId,
  ].filter(Boolean).join(" | ");

  const selectInspectorTool = useCallback((t: InspectorTool) => {
    setActiveToolId(t.id);
    setActiveTool(t);
  }, []);

  const toolSelection = useMemo(() => ({
    activeId: activeToolId,
    select: selectInspectorTool,
  }), [activeToolId, selectInspectorTool]);

  return (
    <ToolSelectionProvider value={toolSelection}>
      <div
        className={`chat-shell ${mobileInspectorOpen ? "inspector-open" : ""}`}
        style={{ "--inspector-width": `${inspectorWidth}px` } as CSSProperties}
      >
        <div className="chat-main">
          <header className="chat-header" title={headerDetails || sessionId}>
            <div className="chat-title-row">
              <h1 className="truncate">{agentName}</h1>
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
              {awaitingPlanApproval && !streaming && (
                <Chip variant="accent" dot>
                  plan ready
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
                disabled={streaming}
                title="Fork this conversation into a new session"
                onClick={() => {
                  const message = window.prompt(
                    "Fork: what should the first message in the new branch be?",
                  );
                  if (!message?.trim()) return;
                  doFork(message);
                }}
              >
                Fork
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="chat-inspector-toggle"
                onClick={() => setMobileInspectorOpen(true)}
              >
                Panel
              </Button>
            </div>
          </header>

          <div className="chat-stream" data-shell="chat-scroll">
            {chunks.length === 0 && (
              <div className="card p-10 text-center text-muted text-[13px]">
                Send a message to start the conversation.
              </div>
            )}
            {(hiddenTurnCount > 0 || eventsPartial) && (
              <div className="chat-history-gate">
                <Button size="sm" variant="ghost" disabled={historyLoading} onClick={loadEarlierTurns}>
                  {historyGateLabel}
                </Button>
                <span>{historyGateDetail}</span>
              </div>
            )}
            {visibleChunks.map((chunk) => {
              const prevChunk = chunks.find((candidate) => candidate.turnIndex === chunk.turnIndex - 1);
              const prevCli = prevChunk?.cli ?? null;
              const showCliTransition = chunk.turnIndex > 0 && chunk.cli !== prevCli;

              return (
                <div
                  key={chunk.turnIndex}
                  className={`chat-turn space-y-2 ${chunk.streaming ? "chat-turn-live" : ""}`.trim()}
                  ref={(el) => {
                    if (el && chunk.turnIndex >= 0) turnRefs.current.set(chunk.turnIndex, el);
                  }}
                >
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
                      turnIndex={chunk.turnIndex}
                      editing={editingTurnIndex === chunk.turnIndex}
                      onFork={doFork}
                      onEdit={!streaming ? editFromMessage : undefined}
                    />
                  )}
                  <MessageBubble
                    kind="assistant"
                    events={chunk.events}
                    streaming={chunk.streaming}
                    liveActivity={chunk.streaming ? streamActivityLabel : undefined}
                    liveDetail={chunk.streaming ? streamActivityDetail : undefined}
                    sessionId={sessionId}
                    hiddenMcpImageServers={hiddenMcpImageServers}
                    onOpenFile={openFileInInspector}
                  />
                </div>
              );
            })}
            <div ref={chatBottomRef} aria-hidden="true" className="chat-bottom-sentinel" />
          </div>

          {!atBottom && (
            <button
              type="button"
              onClick={scrollToBottom}
              aria-label="Scroll to bottom"
              className="chat-scroll-bottom-button fixed z-20 flex items-center justify-center w-9 h-9 rounded-full border border-border shadow-lg transition-all hover:scale-105 active:scale-95"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
              </svg>
            </button>
          )}

          <div className="chat-composer-area">
            {awaitingPlanApproval && !streaming && editingTurnIndex === null && (
              <div className="plan-approval-banner">
                <div className="plan-approval-copy">
                  <div className="plan-approval-title">Plan ready</div>
                  <div className="plan-approval-subtitle">Approve to leave plan mode, or send a note to revise it.</div>
                </div>
                <div className="plan-approval-actions">
                  <Button size="sm" variant="primary" onClick={approvePlan}>
                    Approve & implement
                  </Button>
                  <Button size="sm" variant="ghost" onClick={revisePlan}>
                    Revise plan
                  </Button>
                </div>
              </div>
            )}
            {editingTurnIndex !== null && (
              <div
                className="mx-4 mb-2 px-3 py-2 rounded-xl border flex items-center gap-2 text-[12px]"
                style={{
                  borderColor: "var(--accent)",
                  background: "color-mix(in srgb, var(--accent) 8%, var(--bg-elev))",
                }}
              >
                <svg className="w-3.5 h-3.5 shrink-0 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                <span className="text-accent font-medium">Editing</span>
                <span className="text-muted">— sending will fork the conversation from this message</span>
                <button
                  type="button"
                  onClick={cancelEdit}
                  className="ml-auto text-subtle hover:text-fg transition-colors"
                  aria-label="Cancel edit"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            )}
            <Composer
              ref={composerRef}
              currentCli={currentCli}
              currentModel={currentModel}
              currentReasoningEffort={currentReasoningEffort}
              agentCliModels={agentCliModels}
              agentCliReasoningEfforts={agentCliReasoningEfforts}
              disabled={streaming}
              onSend={editingTurnIndex !== null
                ? (message, cli, model, mcpTools, reasoningEffort) => {
                    const atTurn = editingTurnIndex;
                    setEditingTurnIndex(null);
                    doEdit(message, atTurn, cli, model, mcpTools, reasoningEffort);
                  }
                : sendMessage
              }
              onStop={stopGeneration}
              sessionId={sessionId}
              cwd={snap?.cwd}
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
          events={renderedEvents}
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
