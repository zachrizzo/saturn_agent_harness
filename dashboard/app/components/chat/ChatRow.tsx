"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { InboxSession } from "@/lib/chat-inbox";
import { cliGlyph } from "@/lib/chat-inbox";
import { IconArchive, IconCheck, IconClock, IconPin } from "@/app/components/shell/icons";

type Props = {
  s: InboxSession;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onOpen: (id: string) => void;
};

const SNOOZE_OPTIONS: Array<{ label: string; minutes: number }> = [
  { label: "1 hour", minutes: 60 },
  { label: "4 hours", minutes: 4 * 60 },
  { label: "Tomorrow", minutes: 24 * 60 },
  { label: "Next week", minutes: 7 * 24 * 60 },
];

async function patchSession(id: string, patch: Record<string, unknown>) {
  return fetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export function ChatRow({ s, selected, onToggleSelect, onOpen }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const runAction = async (patch: Record<string, unknown>) => {
    setBusy(true);
    try {
      await patchSession(s.id, patch);
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      className={`chat-row ${s.unread ? "unread" : ""} ${selected ? "selected" : ""}`.trim()}
      onClick={() => onOpen(s.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen(s.id);
      }}
    >
      <button
        type="button"
        className="check"
        aria-label={selected ? "Deselect" : "Select"}
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelect(s.id);
        }}
      >
        <IconCheck className="w-[10px] h-[10px]" />
      </button>

      <span className={`cli-glyph ${s.cli}`}>{cliGlyph(s.cli)}</span>
      <span className={`status-dot ${s.status}`} aria-label={s.status} />

      <div className="agent">
        <span className="name">{s.title}</span>
        {s.isSwarm && <span className="multi" style={{ background: "var(--purple)" }}>swarm</span>}
        {!s.isSwarm && s.multi && <span className="multi">multi</span>}
      </div>

      <div className="preview">
        {!s.adHoc && (
          <span className="you" title="Agent">
            {s.agent} ›
          </span>
        )}
        {s.who === "you" ? <span className="you">you ›</span> : null}
        <span className="preview-text">{s.preview}</span>
        {s.tags
          .filter((t) => t.label !== "swarm")
          .slice(0, 2)
          .map((t, i) => (
            <span key={i} className={`tag ${t.kind}`}>
              {t.label}
            </span>
          ))}
      </div>

      <div className="meta-right">
        {s.turns > 0 && <span className="turns">{s.turns}t</span>}
        <span className="time">{s.relTime}</span>
      </div>

      <div className="actions" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="btn-row-icon"
          title={s.pinned ? "Unpin" : "Pin"}
          disabled={busy}
          onClick={() => runAction({ pinned: !s.pinned })}
        >
          <IconPin className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          className="btn-row-icon"
          title="Snooze 4 hours"
          disabled={busy}
          onClick={() => {
            const mins = SNOOZE_OPTIONS[1].minutes;
            runAction({ snoozed_until: new Date(Date.now() + mins * 60000).toISOString() });
          }}
        >
          <IconClock className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          className="btn-row-icon"
          title={s.archived ? "Unarchive" : "Archive"}
          disabled={busy}
          onClick={() => runAction({ archived: !s.archived })}
        >
          <IconArchive className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
