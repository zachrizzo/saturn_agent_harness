"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { SessionMeta, CLI } from "@/lib/runs";
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
  pendingMessage?: string;
  hiddenMcpImageServers?: string[];
};

export function ChatView({
  sessionId,
  initialMeta,
  initialEvents,
  pendingMessage,
  hiddenMcpImageServers,
}: Props) {
  const router = useRouter();

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
  const seenRef = useRef(new Set(initialEvents.map((e) => JSON.stringify(e.raw))));
  const [streaming, setStreaming] = useState(initialMeta.status === "running");
  const [autoScroll, setAutoScroll] = useState(true);
  const composerRef = useRef<ComposerHandle>(null);
  const [editingTurnIndex, setEditingTurnIndex] = useState<number | null>(null);
  const turnRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [inspectorWidth, setInspectorWidth] = useState(420);

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

  const applySessionSnapshot = useCallback((incoming: SessionMeta, incomingEvents: StreamEvent[]) => {
    if (incoming.turns.length >= metaRef.current.turns.length) {
      setMeta(incoming);
      setStreaming(incoming.status === "running");
    }
    setEvents((prev) => {
      if (incomingEvents.length < prev.length) return prev;
      seenRef.current = new Set(incomingEvents.map((event) => JSON.stringify(event.raw)));
      return incomingEvents;
    });
  }, []);

  const refreshSessionSnapshot = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = await res.json() as { meta: SessionMeta; events: StreamEvent[] };
      applySessionSnapshot(data.meta, data.events ?? []);
    } catch {}
  }, [applySessionSnapshot, sessionId]);

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
    const es = new EventSource(
      `/api/sessions/${encodeURIComponent(sessionId)}/stream`
    );
    let closedByTerminalMeta = false;

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
        setMeta(incoming);
        setStreaming(false);
        router.refresh();
        es.close();
        return;
      }
      const key = JSON.stringify(obj);
      if (seenRef.current.has(key)) return;
      seenRef.current.add(key);
      const parsed = toEvents(obj);
      if (parsed.length === 0) return;
      setEvents((prev) => [...prev, ...parsed]);
    };
    es.onerror = () => {
      void refreshSessionSnapshot();
      if (!closedByTerminalMeta && metaRef.current.status === "running") {
        return;
      }
      es.close();
      setStreaming(false);
    };

    return () => es.close();
  }, [refreshSessionSnapshot, router, sessionId, meta.status]);

  // Scroll all the way to the bottom — past the last message AND showing the composer.
  const scrollToEnd = (behavior: ScrollBehavior = "auto") => {
    window.scrollTo({ top: document.body.scrollHeight, behavior });
  };

  // Jump to bottom on first mount (instant).
  useEffect(() => {
    scrollToEnd();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-scroll when new events arrive (while streaming AND user hasn't scrolled up)
  useEffect(() => {
    if (streaming && autoScroll) {
      scrollToEnd("smooth");
    }
  }, [events.length, streaming, autoScroll]);

  // Track whether the user is near the bottom — shows/hides the scroll-to-bottom button
  const [atBottom, setAtBottom] = useState(true);
  useEffect(() => {
    const onScroll = () => {
      const threshold = 200;
      const distFromBottom =
        document.documentElement.scrollHeight -
        window.innerHeight -
        window.scrollY;
      const nearBottom = distFromBottom < threshold;
      setAtBottom(nearBottom);
      // If user scrolls up mid-stream, pause autoscroll; resume when they return.
      if (streaming) setAutoScroll(nearBottom);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [streaming]);

  const scrollToBottom = () => {
    scrollToEnd("smooth");
    setAutoScroll(true);
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
    for (const ev of events) {
      if (ev.kind === "tool_result") {
        results.set(ev.toolUseId, { content: ev.content, isError: ev.isError });
      }
    }
    const out: InspectorTool[] = [];
    for (const ev of events) {
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
  }, [events]);

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

  const tokens = useMemo(() => getTokenBreakdown(events), [events]);
  const runningTools = useMemo(() => tools.filter((tool) => tool.status === "run"), [tools]);
  const streamActivityLabel = useMemo(() => {
    const latestTool = [...runningTools].reverse()[0];
    if (latestTool) return `Running ${latestTool.name}`;
    if (events.length > 0) {
      const latest = events[events.length - 1];
      if (latest.kind === "assistant_text") return "Receiving answer";
      if (latest.kind === "thinking") return "Reasoning";
      if (latest.kind === "tool_result") return "Processing tool result";
    }
    return "Waiting for first token";
  }, [events, runningTools]);
  const streamActivityDetail = useMemo(() => {
    if (runningTools.length > 0) {
      return `${runningTools.length} tool${runningTools.length === 1 ? "" : "s"} active`;
    }
    return `${events.length.toLocaleString()} event${events.length === 1 ? "" : "s"}`;
  }, [events.length, runningTools.length]);

  const chunks = useMemo<TurnChunk[]>(() => {
    return buildTurnChunks(meta, events);
  }, [events, meta.turns, meta.status]);

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

  const doEdit = async (message: string, atTurn: number) => {
    const res = await fetch(
      `/api/sessions/${encodeURIComponent(sessionId)}/edit`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, at_turn: atTurn }),
      },
    );
    if (!res.ok) { alert(`Edit failed: ${res.status}`); return; }

    // Truncate events to only those belonging to turns 0..atTurn-1.
    // Each completed turn ends with a "result" event; keep everything up to
    // the atTurn-th result (exclusive of subsequent events).
    setEvents((prev) => {
      if (atTurn === 0) {
        seenRef.current = new Set();
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
      seenRef.current = new Set(kept.map((e) => JSON.stringify(e.raw)));
      return kept;
    });

    setMeta((m) => ({
      ...m,
      status: "running",
      turns: [
        ...m.turns.slice(0, atTurn),
        {
          cli: normalizeCli(m.turns[atTurn - 1]?.cli ?? m.turns[0]?.cli ?? DEFAULT_CLI),
          model: m.turns[atTurn - 1]?.model,
          reasoningEffort: m.turns[atTurn - 1]?.reasoningEffort,
          started_at: new Date().toISOString(),
          user_message: message,
        },
      ],
    }));
    setStreaming(true);
  };

  const editFromMessage = (message: string, turnIndex: number) => {
    setEditingTurnIndex(turnIndex);
    composerRef.current?.setDraft(message);
    // Scroll to that turn bubble
    const el = turnRefs.current.get(turnIndex);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    // Then after a moment scroll back down to show the composer too
    setTimeout(() => {
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    }, 600);
  };

  const cancelEdit = () => {
    setEditingTurnIndex(null);
    composerRef.current?.setDraft("");
  };

  const stopGeneration = async () => {
    try {
      await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, { method: "POST" });
      await refreshSessionSnapshot();
    } finally {
      setStreaming(false);
      setMeta((m) => ({ ...m, status: "failed" }));
    }
  };

  const sendMessage = async (
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

  const toolSelection = {
    activeId: activeToolId,
    select: (t: InspectorTool) => {
      setActiveToolId(t.id);
      setActiveTool(t);
    },
  };

  return (
    <ToolSelectionProvider value={toolSelection}>
      <div
        className="chat-shell"
        style={{ "--inspector-width": `${inspectorWidth}px` } as CSSProperties}
      >
        <div className="chat-main">
          <header className="chat-header">
            <h1 className="truncate">{agentName}</h1>
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
            </div>
            {meta.agent_snapshot?.description && (
              <p className="text-[12px] text-muted mt-1 truncate" style={{ flexBasis: "100%" }}>
                {meta.agent_snapshot.description}
              </p>
            )}
            {meta.agent_snapshot?.cwd && (
              <p className="text-[11px] text-subtle mt-0.5 flex items-center gap-1 truncate" style={{ flexBasis: "100%" }} title={meta.agent_snapshot.cwd}>
                <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                </svg>
                <span className="mono truncate">{meta.agent_snapshot.cwd}</span>
              </p>
            )}
            <div className="session-id">{sessionId}</div>
          </header>

          <div className="chat-stream">
            {chunks.length === 0 && (
              <div className="card p-10 text-center text-muted text-[13px]">
                Send a message to start the conversation.
              </div>
            )}
            {chunks.map((chunk, idx) => {
              const prevCli = idx > 0 ? chunks[idx - 1].cli : null;
              const showCliTransition = chunk.turnIndex > 0 && chunk.cli !== prevCli;

              return (
                <div
                  key={chunk.turnIndex}
                  className="space-y-2"
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
                  />
                </div>
              );
            })}
          </div>

          {!atBottom && (
            <button
              type="button"
              onClick={scrollToBottom}
              aria-label="Scroll to bottom"
              className="fixed z-20 right-6 flex items-center justify-center w-9 h-9 rounded-full border border-border shadow-lg transition-all hover:scale-105 active:scale-95"
              style={{
                bottom: "8.5rem",
                background: "var(--bg-elev)",
                color: "var(--fg)",
              }}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
              </svg>
            </button>
          )}

          <div className="pt-2">
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
                ? (message) => {
                    const atTurn = editingTurnIndex;
                    setEditingTurnIndex(null);
                    doEdit(message, atTurn);
                  }
                : sendMessage
              }
              onStop={stopGeneration}
              sessionId={sessionId}
              cwd={snap?.cwd}
            />
          </div>
        </div>

        <Inspector
          session={meta}
          activeTool={activeTool}
          tools={tools}
          tokens={tokens}
          events={events}
          width={inspectorWidth}
          onWidthChange={setInspectorWidth}
        />
      </div>
    </ToolSelectionProvider>
  );
}
