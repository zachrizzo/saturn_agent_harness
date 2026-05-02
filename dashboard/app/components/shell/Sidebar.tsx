"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import {
  IconAgent,
  IconChat,
  IconChevronUp,
  IconDispatch,
  IconHome,
  IconJob,
  IconMemory,
  IconPanelLeftClose,
  IconPanelLeftOpen,
  IconSettings,
  IconSlice,
  IconTask,
  IconTerminal,
} from "./icons";
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
  { href: "/terminals", label: "Terminals", icon: <IconTerminal />, match: matchPrefix("/terminals") },
  { href: "/memory", label: "Memory", icon: <IconMemory />, match: matchPrefix("/memory") },
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
  projectName?: string | null;
  projectPath?: string | null;
  isMultiCli?: boolean;
  /** Orchestrator/swarm sessions get a small badge in the recent list. */
  isSwarm?: boolean;
  lastReplyAt?: string | null;
};

type RecentChatGroup = {
  key: string;
  label: string;
  path: string | null;
  items: RecentChatItem[];
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
      && item.projectName === other.projectName
      && item.projectPath === other.projectPath
      && item.isMultiCli === other.isMultiCli
      && item.isSwarm === other.isSwarm
      && item.lastReplyAt === other.lastReplyAt;
  });
}

type SidebarProps = {
  recents: RecentChatItem[];
  onNavigate?: () => void;
  recentsScrollable?: boolean;
  sidebarCollapsed?: boolean;
  onSidebarCollapsedChange?: (collapsed: boolean) => void;
  showDesktopControls?: boolean;
};

function linkClass(layout: string, active: boolean): string {
  const state = active
    ? "bg-bg-hover text-fg"
    : "text-muted hover:bg-bg-subtle hover:text-fg";
  return `${layout} px-2.5 py-1.5 rounded-md transition-colors ${state}`;
}

const SEEN_KEY = "chat-seen-at";
const COLLAPSED_RECENT_PROJECTS_KEY = "saturn:collapsed-recent-projects";
const COLLAPSED_NAV_KEY = "saturn:sidebar-nav-collapsed";

function getSeenMap(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function getCollapsedRecentProjects(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_RECENT_PROJECTS_KEY) ?? "[]") as unknown;
    if (!Array.isArray(raw)) return new Set();
    return new Set(raw.filter((item): item is string => typeof item === "string"));
  } catch {
    return new Set();
  }
}

function setCollapsedRecentProjects(keys: Set<string>) {
  try {
    localStorage.setItem(COLLAPSED_RECENT_PROJECTS_KEY, JSON.stringify([...keys]));
  } catch {}
}

function getCollapsedNav(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_NAV_KEY) === "1";
  } catch {
    return false;
  }
}

function setCollapsedNav(collapsed: boolean) {
  try {
    localStorage.setItem(COLLAPSED_NAV_KEY, collapsed ? "1" : "0");
  } catch {}
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

function formatProjectName(name: string): string {
  const segment = name.includes("/") ? name.split("/").filter(Boolean).pop() ?? name : name;
  return segment.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function groupRecentChats(items: RecentChatItem[]): RecentChatGroup[] {
  const groups: RecentChatGroup[] = [];
  const byKey = new Map<string, RecentChatGroup>();

  for (const item of items) {
    const key = item.projectPath || item.projectName || "__no_project__";
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        label: item.projectName ? formatProjectName(item.projectName) : "No project",
        path: item.projectPath ?? null,
        items: [],
      };
      byKey.set(key, group);
      groups.push(group);
    }
    group.items.push(item);
  }

  return groups;
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
    setRecents((current) => (sameRecents(current, initial) ? current : initial));
  }, [initial]);

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
          projectName: s.projectName,
          projectPath: s.projectPath,
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

export function Sidebar({
  recents: initialRecents,
  onNavigate,
  recentsScrollable = false,
  sidebarCollapsed = false,
  onSidebarCollapsedChange,
  showDesktopControls = false,
}: SidebarProps): JSX.Element {
  const pathname = usePathname() || "/";
  const recents = useRecents(initialRecents);
  const [seenMap, setSeenMap] = useState<Record<string, string>>({});
  const [collapsedProjectsLoaded, setCollapsedProjectsLoaded] = useState(false);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const [navCollapsedLoaded, setNavCollapsedLoaded] = useState(false);
  const [desktopNavCollapsed, setDesktopNavCollapsed] = useState(false);
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
    setCollapsedProjects(getCollapsedRecentProjects());
    setDesktopNavCollapsed(getCollapsedNav());
    setCollapsedProjectsLoaded(true);
    setNavCollapsedLoaded(true);
  }, []);

  useEffect(() => {
    if (!collapsedProjectsLoaded) return;
    setCollapsedRecentProjects(collapsedProjects);
  }, [collapsedProjects, collapsedProjectsLoaded]);

  useEffect(() => {
    if (!navCollapsedLoaded) return;
    setCollapsedNav(desktopNavCollapsed);
  }, [desktopNavCollapsed, navCollapsedLoaded]);

  // When navigating to a chat, mark it seen
  useEffect(() => {
    const match = pathname.match(/^\/chats\/([^/]+)$/);
    if (match) recordSeen(match[1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const visibleRecents = recents.filter((r) => !hiddenIds.has(r.id));
  const unreadCount = visibleRecents.filter((r) => hasUnread(r, seenMap)).length;
  const recentGroups = groupRecentChats(visibleRecents);
  const navCollapsed = showDesktopControls && desktopNavCollapsed && !sidebarCollapsed;
  const toggleProjectCollapsed = (key: string) => {
    setCollapsedProjects((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <nav
      className={[
        "flex flex-col w-full h-full",
        sidebarCollapsed ? "items-center gap-2 p-2" : "gap-4 p-3",
      ].join(" ")}
      data-shell="sidebar"
      data-sidebar-collapsed={sidebarCollapsed ? "true" : "false"}
    >
      {showDesktopControls && (
        <div className={`sidebar-controls ${sidebarCollapsed ? "is-collapsed" : ""}`}>
          <button
            type="button"
            className="sidebar-icon-button"
            onClick={() => onSidebarCollapsedChange?.(!sidebarCollapsed)}
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {sidebarCollapsed ? <IconPanelLeftOpen /> : <IconPanelLeftClose />}
          </button>
          {!sidebarCollapsed && (
            <button
              type="button"
              className="sidebar-icon-button"
              onClick={() => setDesktopNavCollapsed((current) => !current)}
              title={navCollapsed ? "Expand navigation" : "Collapse navigation"}
              aria-label={navCollapsed ? "Expand navigation" : "Collapse navigation"}
              aria-expanded={!navCollapsed}
            >
              <IconChevronUp className={`w-4 h-4 transition-transform ${navCollapsed ? "rotate-180" : ""}`} />
            </button>
          )}
        </div>
      )}

      {!navCollapsed && (
        <ul className={sidebarCollapsed ? "flex flex-col items-center gap-1" : "flex flex-col gap-0.5"} data-shell="sidebar-nav">
          {NAV.map((n) => {
            const active = n.match(pathname);
            const isChats = n.href === "/chats";
            return (
              <li key={n.href} className={sidebarCollapsed ? "w-9" : undefined}>
                <Link
                  href={n.href}
                  onClick={onNavigate}
                  title={sidebarCollapsed ? n.label : undefined}
                  aria-label={sidebarCollapsed ? n.label : undefined}
                  className={linkClass(
                    sidebarCollapsed
                      ? "sidebar-rail-link"
                      : "flex items-center gap-2.5 text-[13px]",
                    active,
                  )}
                >
                  <span className="shrink-0 text-current">{n.icon}</span>
                  {!sidebarCollapsed && <span>{n.label}</span>}
                  {isChats && unreadCount > 0 && !sidebarCollapsed && (
                    <span className="nav-badge hot">{unreadCount}</span>
                  )}
                  {isChats && unreadCount > 0 && sidebarCollapsed && (
                    <span className="sidebar-rail-hot" aria-label={`${unreadCount} unread chats`} />
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      )}

      {!sidebarCollapsed && <div className="flex flex-col gap-1 min-h-0 flex-1">
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
        <div className={["flex flex-col gap-2", recentsScrollable ? "overflow-y-auto" : "overflow-hidden"].join(" ")}>
          {visibleRecents.length === 0 ? (
            <div className="px-2.5 py-1.5 text-[12px] text-subtle">No chats yet.</div>
          ) : (
            recentGroups.map((group) => {
              const collapsed = collapsedProjects.has(group.key);
              const groupUnread = group.items.filter((r) => hasUnread(r, seenMap)).length;
              return (
              <section key={group.key} className="min-w-0">
                <button
                  type="button"
                  className={`recent-project-toggle ${collapsed ? "collapsed" : ""}`}
                  onClick={() => toggleProjectCollapsed(group.key)}
                  title={group.path ?? group.label}
                  aria-expanded={!collapsed}
                >
                  <svg
                    aria-hidden="true"
                    className="recent-project-chevron"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="m6 4 4 4-4 4" />
                  </svg>
                  {group.path && (
                    <span
                      aria-hidden="true"
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ background: "color-mix(in srgb, var(--teal) 75%, transparent)" }}
                    />
                  )}
                  <span className="recent-project-label">{group.label}</span>
                  {groupUnread > 0 && <span className="recent-project-unread">{groupUnread}</span>}
                  <span className="recent-project-count">{group.items.length}</span>
                </button>
                {!collapsed && <ul className="flex flex-col gap-0.5">
                  {group.items.map((r) => {
                    const active = pathname === `/chats/${r.id}` || pathname === `/chat/${r.id}`;
                    const unread = !active && hasUnread(r, seenMap);
                    const isArchiving = archiving === r.id;
                    return (
                      <li key={r.id} className="group" style={{ position: "relative" }}>
                        <Link
                          href={`/chats/${r.id}`}
                          prefetch={false}
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
                  })}
                </ul>}
              </section>
              );
            })
          )}
        </div>
        <div className="px-2.5 pt-1">
          <Link
            href="/chats"
            onClick={onNavigate}
            className="text-[11px] text-muted hover:text-fg transition-colors"
          >
            See all &rarr;
          </Link>
        </div>
      </div>}
    </nav>
  );
}
