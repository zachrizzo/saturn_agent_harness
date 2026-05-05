"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { SessionMeta } from "@/lib/runs";
import { toInboxSessions } from "@/lib/chat-inbox";
import type { RecentChatItem } from "./Sidebar";
import { SIDEBAR_RECENT_CHAT_LIMIT } from "./recent-chat-limit";

const RECENTS_POLL_MS = 5000;

type ShellRecentsContextValue = {
  recents: RecentChatItem[];
  removeRecent: (id: string) => void;
};

const ShellRecentsContext = createContext<ShellRecentsContextValue | null>(null);

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

function sessionsToRecentItems(sessions: SessionMeta[]): RecentChatItem[] {
  const active = sessions.filter(
    (s) => !s.archived && ((s.turns ?? []).length > 0 || s.status === "running"),
  );
  return toInboxSessions(active).slice(0, SIDEBAR_RECENT_CHAT_LIMIT).map((s) => ({
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
}

export function ShellRecentsProvider({
  initialRecents,
  children,
}: {
  initialRecents: RecentChatItem[];
  children: ReactNode;
}): JSX.Element {
  const [recents, setRecents] = useState<RecentChatItem[]>(initialRecents);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setRecents((current) => (sameRecents(current, initialRecents) ? current : initialRecents));
  }, [initialRecents]);

  useEffect(() => {
    let cancelled = false;

    const clearTimer = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const schedule = (delayMs = RECENTS_POLL_MS) => {
      clearTimer();
      timerRef.current = setTimeout(poll, delayMs);
    };

    const poll = async () => {
      if (cancelled) return;
      if (document.visibilityState === "hidden") {
        schedule();
        return;
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const res = await fetch("/api/sessions", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok || cancelled) return;
        const { sessions } = await res.json() as { sessions: SessionMeta[] };
        const items = sessionsToRecentItems(sessions);
        if (!cancelled) {
          setRecents((current) => (sameRecents(current, items) ? current : items));
        }
      } catch {
        // Keep the existing recents; the next scheduled poll will retry.
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        if (!cancelled) schedule();
      }
    };

    const refreshWhenVisible = () => {
      if (document.visibilityState !== "visible") return;
      schedule(0);
    };

    schedule();
    document.addEventListener("visibilitychange", refreshWhenVisible);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      clearTimer();
      abortRef.current?.abort();
    };
  }, []);

  const removeRecent = useCallback((id: string) => {
    setRecents((current) => current.filter((item) => item.id !== id));
  }, []);

  const value = useMemo(() => ({ recents, removeRecent }), [recents, removeRecent]);

  return (
    <ShellRecentsContext.Provider value={value}>
      {children}
    </ShellRecentsContext.Provider>
  );
}

export function useShellRecents(): ShellRecentsContextValue {
  const value = useContext(ShellRecentsContext);
  if (!value) {
    throw new Error("useShellRecents must be used inside ShellRecentsProvider");
  }
  return value;
}
