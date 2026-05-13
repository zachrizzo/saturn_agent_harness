"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  backgroundActivityDismissKey,
  backgroundStatusLabel,
  sortBackgroundActivityRows,
  type BackgroundActivityRow,
} from "./background-agents";

type Props = {
  rows: BackgroundActivityRow[];
  isStopping: (row: BackgroundActivityRow) => boolean;
  onInspectAgent: (id: string) => void;
  onStop: (row: BackgroundActivityRow) => void;
  onDismiss: (row: BackgroundActivityRow) => void;
};

type NativeAgentTranscriptMessage = {
  role: "user" | "assistant" | "system" | "tool" | "unknown";
  type?: string;
  text?: string;
};

type NativeAgentTranscriptResponse = {
  agent?: {
    provider?: string;
    status?: string;
    transcriptAvailable?: boolean;
  };
  source?: string;
  messages?: NativeAgentTranscriptMessage[];
  unsupportedReason?: string;
  error?: string;
};

type TranscriptState =
  | { status: "loading" }
  | { status: "loaded"; data: NativeAgentTranscriptResponse }
  | { status: "error"; error: string };

function rowKey(row: Pick<BackgroundActivityRow, "id" | "kind">): string {
  return backgroundActivityDismissKey(row);
}

function chatSessionIdFromPath(pathname: string): string | null {
  const match = pathname.match(/\/chats\/([^/?#]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1] || null;
  }
}

function transcriptSourceLabel(value: string | undefined): string {
  if (value === "claude-subagent-jsonl") return "Claude transcript";
  if (value === "codex-thread-read") return "Codex thread";
  if (value === "stream-summary") return "Stream summary";
  return "Native transcript";
}

function transcriptRoleLabel(message: NativeAgentTranscriptMessage): string {
  if (message.role === "assistant") return "Assistant";
  if (message.role === "user") return "User";
  if (message.role === "tool") return "Tool";
  if (message.role === "system") return "System";
  return message.type ?? "Event";
}

function transcriptMessageText(message: NativeAgentTranscriptMessage): string {
  const text = message.text?.trim();
  if (text) return text;
  return message.type ? `[${message.type}]` : "[native event]";
}

function agentTypeLabel(row: BackgroundActivityRow): string {
  if (row.kind === "session") return "background chat";
  if (row.provider === "claude") return "Claude sub-agent";
  if (row.provider === "codex") return "Codex sub-agent";
  return "sub-agent";
}

function NativeTranscript({
  state,
  canLoad,
  unavailableReason,
  onRetry,
}: {
  state?: TranscriptState;
  canLoad: boolean;
  unavailableReason?: string;
  onRetry: () => void;
}): JSX.Element {
  if (!canLoad) {
    return (
      <div className="insp-agent-transcript">
        <div className="insp-agent-transcript-empty">
          {unavailableReason ?? "Open this from a chat route to load the native transcript."}
        </div>
      </div>
    );
  }

  if (!state || state.status === "loading") {
    return (
      <div className="insp-agent-transcript">
        <div className="insp-agent-transcript-empty">Loading native transcript...</div>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="insp-agent-transcript">
        <div className="insp-agent-transcript-head">
          <span>Native transcript</span>
          <button type="button" className="insp-agent-link muted" onClick={onRetry}>Retry</button>
        </div>
        <div className="insp-agent-transcript-empty error">{state.error}</div>
      </div>
    );
  }

  const messages = state.data.messages ?? [];
  const provider = state.data.agent?.provider;
  const meta = [
    provider ? `${provider.slice(0, 1).toUpperCase()}${provider.slice(1)}` : undefined,
    transcriptSourceLabel(state.data.source),
    messages.length > 0 ? `${messages.length} messages` : undefined,
  ].filter(Boolean).join(" · ");

  return (
    <div className="insp-agent-transcript">
      <div className="insp-agent-transcript-head">
        <span>{meta}</span>
        <button type="button" className="insp-agent-link muted" onClick={onRetry}>Refresh</button>
      </div>
      {messages.length === 0 ? (
        <div className="insp-agent-transcript-empty">
          {state.data.unsupportedReason ?? "The native CLI did not expose messages for this agent."}
        </div>
      ) : (
        <div className="insp-agent-transcript-list">
          {messages.map((message, index) => (
            <div key={`${message.role}-${message.type ?? "message"}-${index}`} className={`insp-agent-transcript-message ${message.role}`}>
              <div className="insp-agent-transcript-role">{transcriptRoleLabel(message)}</div>
              <div className="insp-agent-transcript-text">{transcriptMessageText(message)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function BackgroundAgentsPanel({
  rows,
  isStopping,
  onInspectAgent,
  onStop,
  onDismiss,
}: Props): JSX.Element {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [routeSessionId, setRouteSessionId] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<Record<string, TranscriptState>>({});
  const [transcriptReloads, setTranscriptReloads] = useState<Record<string, number>>({});
  const transcriptRequestsRef = useRef(new Set<string>());
  const orderedRows = useMemo(() => sortBackgroundActivityRows(rows), [rows]);
  const selected = useMemo(
    () => orderedRows.find((row) => rowKey(row) === selectedKey) ?? orderedRows[0] ?? null,
    [orderedRows, selectedKey],
  );
  const selectedTranscript = selected?.kind === "agent" ? transcripts[selected.id] : undefined;
  const selectedTranscriptReload = selected?.kind === "agent" ? transcriptReloads[selected.id] ?? 0 : 0;
  const counts = useMemo(() => ({
    running: rows.filter((row) => row.status === "run").length,
    done: rows.filter((row) => row.status === "ok").length,
    attention: rows.filter((row) => row.status === "err" || row.status === "stop").length,
  }), [rows]);

  useEffect(() => {
    if (selectedKey && orderedRows.some((row) => rowKey(row) === selectedKey)) return;
    setSelectedKey(orderedRows[0] ? rowKey(orderedRows[0]) : null);
  }, [orderedRows, selectedKey]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setRouteSessionId(chatSessionIdFromPath(window.location.pathname));
  }, []);

  useEffect(() => {
    if (!selected || selected.kind !== "agent" || !routeSessionId || selected.transcriptAvailable === false) return;
    if (transcriptRequestsRef.current.has(selected.id)) return;

    const agentId = selected.id;
    const controller = new AbortController();
    let settled = false;
    transcriptRequestsRef.current.add(agentId);
    setTranscripts((current) => ({
      ...current,
      [agentId]: { status: "loading" },
    }));

    fetch(`/api/sessions/${encodeURIComponent(routeSessionId)}/native-agents/${encodeURIComponent(agentId)}/transcript`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error ?? `Transcript request failed (${response.status})`);
        settled = true;
        setTranscripts((current) => ({
          ...current,
          [agentId]: { status: "loaded", data: body as NativeAgentTranscriptResponse },
        }));
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        settled = true;
        transcriptRequestsRef.current.delete(agentId);
        setTranscripts((current) => ({
          ...current,
          [agentId]: {
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          },
        }));
      });

    return () => {
      if (!settled) {
        controller.abort();
        transcriptRequestsRef.current.delete(agentId);
      }
    };
  }, [routeSessionId, selected?.id, selected?.kind, selected?.transcriptAvailable, selectedTranscriptReload]);

  const retryTranscript = (agentId: string) => {
    transcriptRequestsRef.current.delete(agentId);
    setTranscripts((current) => {
      const next = { ...current };
      delete next[agentId];
      return next;
    });
    setTranscriptReloads((current) => ({
      ...current,
      [agentId]: (current[agentId] ?? 0) + 1,
    }));
  };

  if (rows.length === 0) {
    return (
      <div className="insp-agents-pane">
        <div className="insp-empty">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-2 opacity-30" aria-hidden="true">
            <circle cx="12" cy="7" r="3" />
            <path d="M5 21a7 7 0 0 1 14 0" />
          </svg>
          No agent activity for this chat.
        </div>
      </div>
    );
  }

  return (
    <div className="insp-agents-pane">
      <div className="insp-agents-summary" aria-label="Agent activity summary">
        <div>
          <span>Running</span>
          <strong>{counts.running}</strong>
        </div>
        <div>
          <span>Done</span>
          <strong>{counts.done}</strong>
        </div>
        <div>
          <span>Attention</span>
          <strong>{counts.attention}</strong>
        </div>
      </div>

      <div className="insp-agents-list" aria-label="Agent activity">
        {orderedRows.map((row) => {
          const active = selected ? rowKey(row) === rowKey(selected) : false;
          const stopping = isStopping(row);
          const canInspect = row.kind === "agent" && row.inspectAvailable !== false;
          const canStop = row.status === "run" && row.stopAvailable !== false;
          return (
            <div key={rowKey(row)} className={`insp-agent-row ${active ? "active" : ""}`.trim()}>
              <button
                type="button"
                className="insp-agent-select"
                onClick={() => setSelectedKey(rowKey(row))}
                title={row.title}
              >
                <span className={`background-agent-dot ${row.status}`} aria-hidden="true" />
                <span className="insp-agent-copy">
                  <span className="insp-agent-title">{row.title}</span>
                  <span className="insp-agent-meta">
                    {agentTypeLabel(row)} · {backgroundStatusLabel(row.status)}
                  </span>
                </span>
              </button>
              <div className="insp-agent-actions">
                {row.kind === "session" ? (
                  <Link className="insp-agent-link" href={`/chats/${encodeURIComponent(row.id)}`}>
                    Open
                  </Link>
                ) : canInspect ? (
                  <button type="button" className="insp-agent-link" onClick={() => onInspectAgent(row.inspectToolId ?? row.id)}>
                    Tool
                  </button>
                ) : null}
                {canStop ? (
                  <button
                    type="button"
                    className="insp-agent-link danger"
                    disabled={stopping}
                    onClick={() => onStop(row)}
                  >
                    {stopping ? "..." : "Stop"}
                  </button>
                ) : row.status === "run" ? (
                  <button type="button" className="insp-agent-link muted" disabled>
                    Running
                  </button>
                ) : (
                  <button type="button" className="insp-agent-link muted" onClick={() => onDismiss(row)}>
                    Hide
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {selected && (
        <div className="insp-agent-detail">
          <div className="insp-agent-detail-header">
            <span className={`background-agent-dot ${selected.status}`} aria-hidden="true" />
            <div>
              <h3>{selected.title}</h3>
              <p>{selected.kind === "session" ? "Background chat continuation" : agentTypeLabel(selected)}</p>
            </div>
          </div>
          <div className="kv-stack">
            <div className="kv-row"><span className="kv-label">Status</span><span className="kv-value">{backgroundStatusLabel(selected.status)}</span></div>
            <div className="kv-row"><span className="kv-label">Type</span><span className="kv-value">{selected.kind === "session" ? "Chat" : agentTypeLabel(selected)}</span></div>
            <div className="kv-row"><span className="kv-label">ID</span><span className="kv-value" title={selected.id}>{selected.id}</span></div>
          </div>
          {selected.kind === "agent" && (
            <NativeTranscript
              state={selectedTranscript}
              canLoad={Boolean(routeSessionId) && selected.transcriptAvailable !== false}
              unavailableReason={selected.transcriptAvailable === false
                ? "This native CLI did not expose a transcript reader for this agent."
                : undefined}
              onRetry={() => retryTranscript(selected.id)}
            />
          )}
          <div className="insp-agent-detail-actions">
            {selected.kind === "session" ? (
              <Link className="terminal-primary-button" href={`/chats/${encodeURIComponent(selected.id)}`}>
                Open background chat
              </Link>
            ) : selected.inspectAvailable !== false ? (
              <button type="button" className="terminal-primary-button" onClick={() => onInspectAgent(selected.inspectToolId ?? selected.id)}>
                Inspect tool call
              </button>
            ) : null}
            {selected.status === "run" && selected.stopAvailable !== false ? (
              <button
                type="button"
                className="insp-agent-secondary danger"
                disabled={isStopping(selected)}
                onClick={() => onStop(selected)}
              >
                {isStopping(selected) ? "Stopping..." : "Stop"}
              </button>
            ) : selected.status === "run" ? (
              <button type="button" className="insp-agent-secondary" disabled>
                Running
              </button>
            ) : (
              <button type="button" className="insp-agent-secondary" onClick={() => onDismiss(selected)}>
                Hide from list
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
