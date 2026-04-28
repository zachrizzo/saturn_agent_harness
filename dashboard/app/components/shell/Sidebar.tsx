"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { IconHome, IconChat, IconAgent, IconJob, IconTask, IconSlice, IconSettings, IconDispatch } from "./icons";
import type { SessionMeta } from "@/lib/runs";
import { toInboxSessions } from "@/lib/chat-inbox";


type NavItem = {
  href: string;
  label: string;
  icon: ReactNode;
  match: (pathname: string) => boolean;
};

function matchPrefix(...prefixes: string[]): (p: string) => boolean {
  return (p) => prefixes.some((pre) => p === pre || p.startsWith(`${pre}/`));
}

const NAV: NavItem[] = [
  { href: "/",       label: "Home",   icon: <IconHome />,  match: (p) => p === "/" },
  { href: "/chats",  label: "Chats",  icon: <IconChat />,  match: matchPrefix("/chats", "/chat") },
  { href: "/dispatch", label: "Dispatch", icon: <IconDispatch />, match: matchPrefix("/dispatch") },
  { href: "/agents", label: "Agents", icon: <IconAgent />, match: matchPrefix("/agents") },
  { href: "/slices", label: "Slices", icon: <IconSlice />, match: matchPrefix("/slices") },
  { href: "/jobs",   label: "Jobs",   icon: <IconJob />,   match: matchPrefix("/jobs") },
  { href: "/tasks",  label: "Tasks",  icon: <IconTask />,  match: matchPrefix("/tasks") },
  { href: "/settings", label: "Settings", icon: <IconSettings />, match: matchPrefix("/settings") },
];

export type RecentChatItem = {
  id: string;
  /** Headline shown in the sidebar — the first user message of the session. */
  title: string;
  /** Underlying agent name (saved agent name or "Ad-hoc"). Used as a small
   *  secondary label so the user still knows which agent produced the chat. */
  agent?: string;
  preview: string;
  relTime: string;
  isMultiCli?: boolean;
  /** Orchestrator/swarm sessions get a small badge in the recent list. */
  isSwarm?: boolean;
  lastReplyAt?: string | null;
};

function sameRecents(a: RecentChatItem[], b: RecentChatItem[]): boolean {
  return a.length === b.length && a.every((item, index) => {
    const other = b[index];
    return Boolean(other)
      && item.id === other.id
      && item.title === other.title
      && item.agent === other.agent
      && item.preview === other.preview
      && item.relTime === other.relTime
      && item.isMultiCli === other.isMultiCli
      && item.isSwarm === other.isSwarm
      && item.lastReplyAt === other.lastReplyAt;
  });
}

type SidebarProps = {
  recents: RecentChatItem[];
  onNavigate?: () => void;
};

function linkClass(layout: string, active: boolean): string {
  const state = active
    ? "bg-bg-hover text-fg"
    : "text-muted hover:bg-bg-subtle hover:text-fg";
  return `${layout} px-2.5 py-1.5 rounded-md transition-colors ${state}`;
}

const SEEN_KEY = "chat-seen-at";

function getSeenMap(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function markSeen(id: string) {
  const map = getSeenMap();
  map[id] = new Date().toISOString();
  try { localStorage.setItem(SEEN_KEY, JSON.stringify(map)); } catch {}
}

function hasUnread(item: RecentChatItem, seenMap: Record<string, string>): boolean {
  if (!item.lastReplyAt) return false;
  const seen = seenMap[item.id];
  if (!seen) return true;
  return item.lastReplyAt > seen;
}

const MultiCliIcon = (
  <svg
    className="w-3 h-3 text-accent shrink-0"
    fill="none"
    stroke="currentColor"
    viewBox="0 0 24 24"
    aria-label="Multi-CLI session"
  >
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
  </svg>
);

function ArchiveButton({
  id,
  archiving,
  onArchive,
}: {
  id: string;
  archiving: boolean;
  onArchive: (e: React.MouseEvent, id: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={(e) => onArchive(e, id)}
      disabled={archiving}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title="Archive chat"
      aria-label="Archive chat"
      style={{
        position: "absolute",
        right: "6px",
        top: "50%",
        transform: "translateY(-50%)",
        zIndex: 10,
        padding: "4px",
        borderRadius: "4px",
        border: "none",
        cursor: archiving ? "default" : "pointer",
        opacity: hovered && !archiving ? 1 : 0.35,
        background: hovered ? "var(--bg-hover)" : "transparent",
        color: hovered ? "var(--fg)" : "var(--text-subtle, var(--muted))",
        transition: "opacity 0.15s, background 0.15s",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {archiving ? (
        <svg style={{ width: 14, height: 14, animation: "spin 1s linear infinite" }} fill="none" viewBox="0 0 24 24">
          <circle style={{ opacity: 0.25 }} cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path style={{ opacity: 0.75 }} fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
      ) : (
        <svg style={{ width: 14, height: 14 }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8l1 12a2 2 0 002 2h8a2 2 0 002-2l1-12" />
        </svg>
      )}
    </button>
  );
}

function useRecents(initial: RecentChatItem[]): RecentChatItem[] {
  const [recents, setRecents] = useState<RecentChatItem[]>(initial);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch("/api/sessions");
        if (!res.ok || cancelled) return;
        const { sessions } = await res.json() as { sessions: SessionMeta[] };
        const active = sessions.filter(
          (s) => !s.archived && ((s.turns ?? []).length > 0 || s.status === "running"),
        );
        const items = toInboxSessions(active).slice(0, 8).map((s) => ({
          id: s.id,
          title: s.title,
          agent: s.agent,
          preview: s.preview,
          relTime: s.relTime,
          isMultiCli: s.multi,
          isSwarm: s.isSwarm,
          lastReplyAt: s.lastFinishedAt ?? null,
        }));
        if (!cancelled) {
          setRecents((current) => (sameRecents(current, items) ? current : items));
        }
      } catch {}
      if (!cancelled) timerRef.current = setTimeout(poll, 5000);
    };

    timerRef.current = setTimeout(poll, 5000);
    return () => {
      cancelled = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return recents;
}

export function Sidebar({ recents: initialRecents, onNavigate }: SidebarProps): JSX.Element {
  const pathname = usePathname() || "/";
  const recents = useRecents(initialRecents);
  const [seenMap, setSeenMap] = useState<Record<string, string>>({});
  const [archiving, setArchiving] = useState<string | null>(null);
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());

  const archiveChat = async (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setArchiving(id);
    setHiddenIds((prev) => new Set([...prev, id]));
    try {
      await fetch(`/api/sessions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: true }),
      });
    } catch {
      setHiddenIds((prev) => { const s = new Set(prev); s.delete(id); return s; });
    } finally {
      setArchiving(null);
    }
  };

  const recordSeen = (id: string) => {
    markSeen(id);
    setSeenMap((prev) => ({ ...prev, [id]: new Date().toISOString() }));
  };

  // Load from localStorage on mount (client-only)
  useEffect(() => {
    setSeenMap(getSeenMap());
  }, []);

  // When navigating to a chat, mark it seen
  useEffect(() => {
    const match = pathname.match(/^\/chats\/([^/]+)$/);
    if (match) recordSeen(match[1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const unreadCount = recents.filter((r) => hasUnread(r, seenMap)).length;

  return (
    <nav className="flex flex-col gap-4 p-3 w-full h-full">
      <ul className="flex flex-col gap-0.5" data-shell="sidebar-nav">
        {NAV.map((n) => {
          const isChats = n.href === "/chats";
          return (
            <li key={n.href}>
              <Link href={n.href} onClick={onNavigate} className={linkClass("flex items-center gap-2.5 text-[13px]", n.match(pathname))}>
                <span className="shrink-0 text-current">{n.icon}</span>
                <span>{n.label}</span>
                {isChats && unreadCount > 0 && (
                  <span className="nav-badge hot">{unreadCount}</span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>

      <div className="flex flex-col gap-1 min-h-0 flex-1">
        <div className="flex items-center justify-between px-2.5">
          <span className="text-[11px] font-medium uppercase tracking-wider text-subtle">
            Recent
          </span>
          <Link
            href="/chats/new"
            onClick={onNavigate}
            title="New chat"
            className="text-subtle hover:text-fg transition-colors text-base leading-none"
          >
            +
          </Link>
        </div>
        <ul className="flex flex-col gap-0.5 overflow-y-auto">
          {recents.filter((r) => !hiddenIds.has(r.id)).length === 0 ? (
            <li className="px-2.5 py-1.5 text-[12px] text-subtle">No chats yet.</li>
          ) : (
            recents.filter((r) => !hiddenIds.has(r.id)).map((r) => {
              const active = pathname === `/chats/${r.id}` || pathname === `/chat/${r.id}`;
              const unread = !active && hasUnread(r, seenMap);
              const isArchiving = archiving === r.id;
              return (
                <li key={r.id} className="group" style={{ position: "relative" }}>
                  <Link
                    href={`/chats/${r.id}`}
                    onClick={() => {
                      recordSeen(r.id);
                      onNavigate?.();
                    }}
                    className={linkClass("flex flex-col gap-0.5 pr-7", active)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 min-w-0 flex-1">
                        {unread && (
                          <span
                            className="shrink-0 w-2 h-2 rounded-full bg-accent"
                            aria-label="unread reply"
                          />
                        )}
                        {r.isSwarm && (
                          <span
                            className="shrink-0 text-[8.5px] font-semibold uppercase tracking-wider px-1 py-[1px] rounded"
                            style={{
                              color: "var(--purple)",
                              background: "color-mix(in srgb, var(--purple) 18%, transparent)",
                              letterSpacing: "0.05em",
                            }}
                            title="Swarm / orchestrator"
                          >
                            swarm
                          </span>
                        )}
                        <span className={[
                          "truncate text-[13px]",
                          unread ? "text-fg font-medium" : "text-fg",
                        ].join(" ")}>
                          {r.title}
                        </span>
                        {r.isMultiCli && MultiCliIcon}
                      </div>
                      <span className={[
                        "shrink-0 text-[11px]",
                        unread ? "text-accent font-medium" : "text-subtle",
                      ].join(" ")}>
                        {r.relTime}
                      </span>
                    </div>
                    {r.agent && r.agent !== "Ad-hoc" && (
                      <span className="text-[10.5px] text-subtle truncate">
                        {r.agent}
                      </span>
                    )}
                    <span className={[
                      "truncate text-[12px]",
                      unread ? "text-muted" : "text-subtle",
                    ].join(" ")}>
                      {r.preview}
                    </span>
                  </Link>
                  <ArchiveButton
                    id={r.id}
                    archiving={isArchiving}
                    onArchive={archiveChat}
                  />
                </li>
              );
            })
          )}
        </ul>
        <div className="px-2.5 pt-1">
          <Link
            href="/chats"
            onClick={onNavigate}
            className="text-[11px] text-muted hover:text-fg transition-colors"
          >
            See all &rarr;
          </Link>
        </div>
      </div>
    </nav>
  );
}
