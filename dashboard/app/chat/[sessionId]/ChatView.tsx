"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { SessionMeta, CLI } from "@/lib/runs";
import type { ModelReasoningEffort } from "@/lib/models";
import type { StreamEvent } from "@/lib/events";
import { toEvents } from "@/lib/events";
import { Composer } from "@/app/components/chat/Composer";
import { MessageBubble } from "@/app/components/chat/MessageBubble";
import { DEFAULT_CLI, normalizeCli } from "@/lib/clis";

type Props = {
  sessionId: string;
  initialMeta: SessionMeta;
  initialEvents: StreamEvent[];
};

// A chat "turn chunk" = one user message + whatever assistant/tool events happened after it.
type TurnChunk = {
  turnIndex: number;
  cli: CLI;
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  userMessage: string;
  events: StreamEvent[];
  streaming: boolean;
};

export function ChatView({ sessionId, initialMeta, initialEvents }: Props) {
  const [meta, setMeta] = useState<SessionMeta>(initialMeta);
  const [events, setEvents] = useState<StreamEvent[]>(initialEvents);
  const seenRef = useRef(new Set(initialEvents.map((e) => JSON.stringify(e.raw))));
  const [streaming, setStreaming] = useState(initialMeta.status === "running");
  const bottomRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  // Connect SSE whenever status transitions to running
  useEffect(() => {
    if (meta.status !== "running") return;
    const es = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/stream`);

    es.onmessage = (e) => {
      let obj: Record<string, unknown>;
      try { obj = JSON.parse(e.data); } catch { return; }

      if ((obj as any).type === "_meta") {
        setMeta((obj as any).meta as SessionMeta);
        setStreaming(false);
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
    es.onerror = () => { es.close(); setStreaming(false); };

    return () => es.close();
  }, [sessionId, meta.status]);

  // Auto-scroll when new events arrive
  useEffect(() => {
    if (streaming && autoScroll) bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length, streaming, autoScroll]);

  // Reconstruct "chunks" = one per turn. The stream contains a "system:init" event at the
  // start of every CLI invocation (one per human turn). Slicing between consecutive init
  // events gives us exactly the events that belong to each turn, keeping responses correctly
  // aligned even when a previous turn produced no AI reply.
  const chunks: TurnChunk[] = [];
  {
    // system:init fires once per turn (one CLI invocation per human message).
    const initIndices: number[] = [];
    events.forEach((ev, i) => {
      if (ev.kind === "system" && (ev.raw as Record<string, unknown>).subtype === "init") {
        initIndices.push(i);
      }
    });

    const hasTurnMarkers = initIndices.length > 0;

    if (hasTurnMarkers) {
      for (let i = 0; i < meta.turns.length; i++) {
        const t = meta.turns[i];
        // Events for turn i start at the init event (exclusive) and end before the next init.
        const start = initIndices[i] !== undefined ? initIndices[i] + 1 : events.length;
        const end = initIndices[i + 1] !== undefined ? initIndices[i + 1] : events.length;
        const turnEvents = events.slice(start, end);
        const hasResult = turnEvents.some((ev) => ev.kind === "result");
        chunks.push({
          turnIndex: i,
          cli: t.cli as CLI,
          model: t.model,
          reasoningEffort: t.reasoningEffort,
          userMessage: t.user_message,
          events: turnEvents,
          streaming: !hasResult && meta.status === "running" && i === meta.turns.length - 1,
        });
      }
    } else {
      // Fallback: split on result events for CLIs that don't emit system:init.
      const resultBoundaries: number[] = [];
      events.forEach((ev, i) => {
        if (ev.kind === "result") resultBoundaries.push(i);
      });
      let eventStart = 0;
      for (let i = 0; i < meta.turns.length; i++) {
        const t = meta.turns[i];
        const boundary = resultBoundaries[i];
        const turnEvents = boundary !== undefined
          ? events.slice(eventStart, boundary + 1)
          : events.slice(eventStart);
        chunks.push({
          turnIndex: i,
          cli: t.cli as CLI,
          model: t.model,
          reasoningEffort: t.reasoningEffort,
          userMessage: t.user_message,
          events: turnEvents,
          streaming: boundary === undefined && meta.status === "running" && i === meta.turns.length - 1,
        });
        if (boundary !== undefined) eventStart = boundary + 1;
      }
      // Trailing events with no corresponding user turn (shouldn't happen, but safety)
      if (eventStart < events.length) {
        chunks.push({
          turnIndex: meta.turns.length,
          cli: normalizeCli(chunks[chunks.length - 1]?.cli ?? DEFAULT_CLI),
          userMessage: "",
          events: events.slice(eventStart),
          streaming: meta.status === "running",
        });
      }
    }
  }

  const stopGeneration = async () => {
    setStreaming(false);
    setMeta((m) => ({ ...m, status: "failed" }));
    await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, { method: "POST" });
  };

  const sendMessage = async (
    message: string,
    cli: CLI,
    model?: string,
    _mcpTools?: boolean,
    reasoningEffort?: ModelReasoningEffort,
  ) => {
    // Optimistic: push a placeholder so the user sees their message immediately
    setMeta((m) => ({
      ...m,
      status: "running",
      turns: [
        ...m.turns,
        { cli, model, reasoningEffort, started_at: new Date().toISOString(), user_message: message },
      ],
    }));
    setStreaming(true);

    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, cli, model, reasoningEffort }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "failed" }));
        throw new Error(err.error ?? "failed");
      }
    } catch (e) {
      // Roll back the optimistic turn
      setMeta((m) => ({ ...m, status: "failed", turns: m.turns.slice(0, -1) }));
      setStreaming(false);
      alert(e instanceof Error ? e.message : "Failed to send");
    }
  };

  const lastTurn = meta.turns[meta.turns.length - 1];
  const currentCli: CLI = normalizeCli(lastTurn?.cli ?? meta.agent_snapshot?.cli ?? DEFAULT_CLI);
  const currentModel = lastTurn?.model ?? meta.agent_snapshot?.model;
  const currentReasoningEffort = lastTurn?.reasoningEffort ?? meta.agent_snapshot?.reasoningEffort;

  return (
    <div className="space-y-4">
      <nav className="text-sm flex items-center justify-between">
        <Link href="/agents" className="text-[var(--text-dim)] hover:text-white transition">← agents</Link>
        {streaming && (
          <span className="text-xs text-[var(--warn)] flex items-center gap-1.5">
            <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            live
          </span>
        )}
      </nav>

      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          {meta.agent_snapshot?.name ?? "Chat"}
        </h1>
        {meta.agent_snapshot?.description && (
          <p className="text-sm text-[var(--text-dim)] mt-1">{meta.agent_snapshot.description}</p>
        )}
        <div className="mono text-[10px] text-[var(--text-muted)] mt-1">{sessionId}</div>
      </header>

      <div className="space-y-3">
        {chunks.map((chunk) => (
          <TurnBlock key={chunk.turnIndex} chunk={chunk} sessionId={sessionId} />
        ))}
        {chunks.length === 0 && (
          <div className="card p-10 text-center text-[var(--text-muted)] text-sm">
            Send a message to start the conversation.
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="sticky bottom-4">
        <Composer
          currentCli={currentCli}
          currentModel={currentModel}
          currentReasoningEffort={currentReasoningEffort}
          disabled={streaming}
          onSend={sendMessage}
          onStop={stopGeneration}
        />
        {streaming && (
          <label className="flex items-center gap-1.5 text-[10px] text-[var(--text-muted)] mt-1 cursor-pointer justify-end">
            <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} className="w-3 h-3" />
            auto-scroll
          </label>
        )}
      </div>
    </div>
  );
}

function TurnBlock({ chunk, sessionId }: { chunk: TurnChunk; sessionId: string }) {
  return (
    <div className="space-y-2">
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

      {chunk.events.map((ev, i) => (
        <AssistantEvent key={i} event={ev} sessionId={sessionId} />
      ))}

      {chunk.streaming && chunk.events.length === 0 && (
        <div className="flex justify-start">
          <div className="max-w-[85%] rounded-2xl rounded-tl-md px-4 py-2.5 bg-[var(--bg-secondary)] border border-[var(--border)] text-sm text-[var(--text-muted)] italic">
            thinking…
          </div>
        </div>
      )}
    </div>
  );
}

function AssistantEvent({ event, sessionId }: { event: StreamEvent; sessionId: string }) {
  if (event.kind === "assistant_text") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] rounded-2xl rounded-tl-md px-4 py-2.5 bg-[var(--bg-secondary)] border border-[var(--border)] text-sm">
          <MessageBubble kind="assistant" events={[event]} sessionId={sessionId} />
        </div>
      </div>
    );
  }
  if (event.kind === "thinking") {
    return (
      <details className="ml-4 card p-3 max-w-[85%]">
        <summary className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] cursor-pointer">thinking</summary>
        <div className="text-xs whitespace-pre-wrap mt-2 text-[var(--text-dim)] italic">{event.text}</div>
      </details>
    );
  }
  if (event.kind === "tool_use") {
    return (
      <details className="ml-4 card p-3 max-w-[85%]">
        <summary className="cursor-pointer flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-wider text-[var(--warn)]">tool use</span>
          <span className="mono text-xs">{event.name}</span>
        </summary>
        <pre className="text-[11px] mt-2 bg-black/30 p-2 rounded overflow-x-auto text-[var(--text-dim)] mono">
          {JSON.stringify(event.input, null, 2)}
        </pre>
      </details>
    );
  }
  if (event.kind === "tool_result") {
    const txt = typeof event.content === "string" ? event.content : JSON.stringify(event.content, null, 2);
    return (
      <details className="ml-4 card p-3 max-w-[85%]" open={event.isError}>
        <summary className={`cursor-pointer text-[10px] uppercase tracking-wider ${event.isError ? "text-[var(--fail)]" : "text-[var(--text-muted)]"}`}>
          tool result{event.isError ? " · error" : ""}
        </summary>
        <pre className="text-[11px] mt-2 bg-black/30 p-2 rounded overflow-x-auto max-h-64 overflow-y-auto text-[var(--text-dim)] mono">{txt}</pre>
      </details>
    );
  }
  if (event.kind === "result") {
    return (
      <div className="ml-4 text-[10px] text-[var(--text-muted)] flex gap-3">
        <span className={event.success ? "text-[var(--success)]" : "text-[var(--fail)]"}>{event.success ? "✓ done" : "✗ failed"}</span>
        {event.totalTokens > 0 && <span>{event.totalTokens.toLocaleString()} tokens</span>}
      </div>
    );
  }
  return null;
}
