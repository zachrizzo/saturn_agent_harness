"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { InboxSession, FolderKey } from "@/lib/chat-inbox";
import {
  FOLDER_LABELS,
  bucketInboxSessions,
  matchesFolder,
} from "@/lib/chat-inbox";
import type { CLI } from "@/lib/runs";
import { normalizeCli } from "@/lib/clis";
import { ChatRow } from "@/app/components/chat/ChatRow";
import {
  IconArchive,
  IconClock,
  IconPin,
  IconSearch,
  IconTrash,
} from "@/app/components/shell/icons";

type Props = {
  initialSessions: InboxSession[];
  counts: Record<FolderKey, number>;
};

type CliFilter = CLI | "all";
type ArchiveFilter = "active" | "archived";

const ACTIVE_FOLDER_ORDER: FolderKey[] = [
  "needs-reply",
  "live",
  "failing",
  "pinned",
  "ad-hoc",
  "from-agent",
];

async function bulkPatch(ids: string[], patch: Record<string, unknown>) {
  return fetch("/api/sessions/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, patch }),
  });
}

export function ChatsInbox({ initialSessions, counts }: Props) {
  const router = useRouter();
  const [archiveFilter, setArchiveFilter] = useState<ArchiveFilter>("active");
  const [folder, setFolder] = useState<FolderKey>("all");
  const [query, setQuery] = useState("");
  const [cli, setCli] = useState<CliFilter>("all");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return initialSessions.filter((s) => {
      if (archiveFilter === "archived") {
        if (!s.archived) return false;
      } else if (!matchesFolder(s, folder)) {
        return false;
      }
      if (unreadOnly && !s.unread) return false;
      if (cli !== "all") {
        if (s.cli === "mixed" || s.cli === "unknown") return false;
        if (normalizeCli(s.cli) !== cli) return false;
      }
      if (!q) return true;
      return (
        s.agent.toLowerCase().includes(q) ||
        s.preview.toLowerCase().includes(q)
      );
    });
  }, [initialSessions, archiveFilter, folder, cli, query, unreadOnly]);

  const buckets = useMemo(() => bucketInboxSessions(filtered), [filtered]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearSelection = () => setSelected(new Set());

  const changeArchiveFilter = (next: ArchiveFilter) => {
    setArchiveFilter(next);
    setFolder("all");
    clearSelection();
  };

  const runBulk = async (patch: Record<string, unknown>) => {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      await bulkPatch(Array.from(selected), patch);
      clearSelection();
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const openChat = (id: string) => {
    window.location.assign(`/chats/${encodeURIComponent(id)}`);
  };

  const selectAll = () => {
    setSelected(new Set(filtered.map((s) => s.id)));
  };

  const emptyTitle = archiveFilter === "archived" ? "No archived chats" : "No matching chats";
  const emptyBody =
    archiveFilter === "archived"
      ? counts.archived > 0
        ? "Try clearing search, CLI, or unread filters."
        : "Archived chats will show up here after you archive them."
      : "Try a different folder or clear the filters.";

  const filterChips: Array<{ label: string; value: CliFilter }> = [
    { label: "All CLIs", value: "all" },
    { label: "Bedrock", value: "claude-bedrock" },
    { label: "Personal", value: "claude-personal" },
    { label: "Local", value: "claude-local" },
    { label: "Codex", value: "codex" },
  ];

  return (
    <div className="chats-page">
      <div className="chats-main">
        <div className="chats-toolbar">
          <label className="chats-search">
            <IconSearch className="w-[13px] h-[13px] text-subtle shrink-0" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search chats…"
              type="search"
            />
          </label>
          <div className="filters">
            <button
              type="button"
              className={`chip-filter ${archiveFilter === "active" ? "on" : ""}`.trim()}
              onClick={() => changeArchiveFilter("active")}
            >
              Active
              <span className="x">{counts.all}</span>
            </button>
            <button
              type="button"
              className={`chip-filter ${archiveFilter === "archived" ? "on" : ""}`.trim()}
              onClick={() => changeArchiveFilter("archived")}
            >
              <IconArchive className="w-[12px] h-[12px]" />
              Archived
              <span className="x">{counts.archived}</span>
            </button>
          </div>
          {archiveFilter === "active" && (
            <div className="filters">
              {ACTIVE_FOLDER_ORDER.map((key) => (
                <button
                  key={key}
                  type="button"
                  className={`chip-filter ${folder === key ? "on" : ""}`.trim()}
                  onClick={() => setFolder(key)}
                >
                  {FOLDER_LABELS[key]}
                  <span className="x">{counts[key]}</span>
                </button>
              ))}
            </div>
          )}
          <div className="filters">
            {filterChips.map((f) => (
              <button
                key={f.value}
                type="button"
                className={`chip-filter ${cli === f.value ? "on" : ""}`.trim()}
                onClick={() => setCli(f.value)}
              >
                {f.label}
              </button>
            ))}
            <button
              type="button"
              className={`chip-filter ${unreadOnly ? "on" : ""}`.trim()}
              onClick={() => setUnreadOnly((v) => !v)}
            >
              Unread only
            </button>
          </div>
          <div className="ml-auto">
            <Link
              href="/chats/new"
              className="chip-filter"
              style={{ color: "var(--accent)", borderColor: "color-mix(in srgb, var(--accent) 40%, var(--border))" }}
            >
              + New chat
            </Link>
          </div>
        </div>

        {selected.size > 0 && (
          <div className="bulk-bar">
            <span className="count">{selected.size} selected</span>
            <button
              type="button"
              className="bulk-action"
              disabled={busy}
              onClick={() => runBulk({ read_at: new Date().toISOString() })}
            >
              Mark read
            </button>
            <button
              type="button"
              className="bulk-action"
              disabled={busy}
              onClick={() => runBulk({ pinned: true })}
            >
              <IconPin className="w-[12px] h-[12px]" />
              Pin
            </button>
            <button
              type="button"
              className="bulk-action"
              disabled={busy}
              onClick={() =>
                runBulk({
                  snoozed_until: new Date(
                    Date.now() + 4 * 60 * 60 * 1000,
                  ).toISOString(),
                })
              }
            >
              <IconClock className="w-[12px] h-[12px]" />
              Snooze 4h
            </button>
            <button
              type="button"
              className="bulk-action"
              disabled={busy}
              onClick={() => runBulk({ archived: archiveFilter !== "archived" })}
            >
              <IconArchive className="w-[12px] h-[12px]" />
              {archiveFilter === "archived" ? "Unarchive" : "Archive"}
            </button>
            <span className="spacer" />
            <button type="button" className="bulk-action" onClick={selectAll} disabled={busy}>
              Select all
            </button>
            <button type="button" className="bulk-action" onClick={clearSelection} disabled={busy}>
              <IconTrash className="w-[12px] h-[12px]" />
              Clear
            </button>
          </div>
        )}

        <div className="chats-list">
          {filtered.length === 0 ? (
            <div className="empty-inbox">
              <h3>{emptyTitle}</h3>
              <div className="text-[12px]">
                {emptyBody}
              </div>
            </div>
          ) : (
            buckets.map((bucket) => (
              <section key={bucket.label}>
                <div className="chats-section-head">
                  <span>{bucket.label}</span>
                  <span className="n">{bucket.items.length}</span>
                  <span className="sep" />
                </div>
                {bucket.items.map((s) => (
                  <ChatRow
                    key={s.id}
                    s={s}
                    selected={selected.has(s.id)}
                    onToggleSelect={toggleSelect}
                    onOpen={openChat}
                  />
                ))}
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
