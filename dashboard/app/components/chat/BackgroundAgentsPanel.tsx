"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
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

function rowKey(row: Pick<BackgroundActivityRow, "id" | "kind">): string {
  return backgroundActivityDismissKey(row);
}

export function BackgroundAgentsPanel({
  rows,
  isStopping,
  onInspectAgent,
  onStop,
  onDismiss,
}: Props): JSX.Element {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const orderedRows = useMemo(() => sortBackgroundActivityRows(rows), [rows]);
  const selected = useMemo(
    () => orderedRows.find((row) => rowKey(row) === selectedKey) ?? orderedRows[0] ?? null,
    [orderedRows, selectedKey],
  );
  const counts = useMemo(() => ({
    running: rows.filter((row) => row.status === "run").length,
    done: rows.filter((row) => row.status === "ok").length,
    attention: rows.filter((row) => row.status === "err" || row.status === "stop").length,
  }), [rows]);

  useEffect(() => {
    if (selectedKey && orderedRows.some((row) => rowKey(row) === selectedKey)) return;
    setSelectedKey(orderedRows[0] ? rowKey(orderedRows[0]) : null);
  }, [orderedRows, selectedKey]);

  if (rows.length === 0) {
    return (
      <div className="insp-agents-pane">
        <div className="insp-empty">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-2 opacity-30" aria-hidden="true">
            <circle cx="12" cy="7" r="3" />
            <path d="M5 21a7 7 0 0 1 14 0" />
          </svg>
          No background agents for this chat.
        </div>
      </div>
    );
  }

  return (
    <div className="insp-agents-pane">
      <div className="insp-agents-summary" aria-label="Background agent summary">
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

      <div className="insp-agents-list" aria-label="Background agents">
        {orderedRows.map((row) => {
          const active = selected ? rowKey(row) === rowKey(selected) : false;
          const stopping = isStopping(row);
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
                    {row.kind === "session" ? "background chat" : "sub-agent"} · {backgroundStatusLabel(row.status)}
                  </span>
                </span>
              </button>
              <div className="insp-agent-actions">
                {row.kind === "session" ? (
                  <Link className="insp-agent-link" href={`/chats/${encodeURIComponent(row.id)}`}>
                    Open
                  </Link>
                ) : (
                  <button type="button" className="insp-agent-link" onClick={() => onInspectAgent(row.id)}>
                    Tool
                  </button>
                )}
                {row.status === "run" ? (
                  <button
                    type="button"
                    className="insp-agent-link danger"
                    disabled={stopping}
                    onClick={() => onStop(row)}
                  >
                    {stopping ? "..." : "Stop"}
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
              <p>{selected.kind === "session" ? "Background chat continuation" : "Background sub-agent"}</p>
            </div>
          </div>
          <div className="kv-stack">
            <div className="kv-row"><span className="kv-label">Status</span><span className="kv-value">{backgroundStatusLabel(selected.status)}</span></div>
            <div className="kv-row"><span className="kv-label">Type</span><span className="kv-value">{selected.kind === "session" ? "Chat" : "Sub-agent"}</span></div>
            <div className="kv-row"><span className="kv-label">ID</span><span className="kv-value" title={selected.id}>{selected.id}</span></div>
          </div>
          <div className="insp-agent-detail-actions">
            {selected.kind === "session" ? (
              <Link className="terminal-primary-button" href={`/chats/${encodeURIComponent(selected.id)}`}>
                Open background chat
              </Link>
            ) : (
              <button type="button" className="terminal-primary-button" onClick={() => onInspectAgent(selected.id)}>
                Inspect tool call
              </button>
            )}
            {selected.status === "run" ? (
              <button
                type="button"
                className="insp-agent-secondary danger"
                disabled={isStopping(selected)}
                onClick={() => onStop(selected)}
              >
                {isStopping(selected) ? "Stopping..." : "Stop"}
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
