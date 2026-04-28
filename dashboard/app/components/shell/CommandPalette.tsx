"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Portal } from "../Portal";
import { buildIndex, searchIndex, type CommandItem } from "@/lib/search";
import { useTheme } from "../ThemeProvider";
import { IconSearch } from "./icons";

function kindLabel(k: CommandItem["kind"]): string {
  switch (k) {
    case "job": return "Job";
    case "agent": return "Agent";
    case "chat": return "Chat";
    case "task": return "Task";
    case "action": return "Action";
  }
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { cycle } = useTheme();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const [query, setQuery] = useState("");
  const [items, setItems] = useState<CommandItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(0);

  // Fetch data on open (no caching — per spec).
  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [jobsRes, agentsRes, sessionsRes, tasksRes] = await Promise.all([
          fetch("/api/jobs", { cache: "no-store" }),
          fetch("/api/agents", { cache: "no-store" }),
          fetch("/api/sessions", { cache: "no-store" }),
          fetch("/api/tasks?limit=100", { cache: "no-store" }),
        ]);
        const jobsJson = jobsRes.ok ? await jobsRes.json() : { jobs: [] };
        const agentsJson = agentsRes.ok ? await agentsRes.json() : { agents: [] };
        const sessionsJson = sessionsRes.ok ? await sessionsRes.json() : { sessions: [] };
        const tasksJson = tasksRes.ok ? await tasksRes.json() : { tasks: [] };
        if (cancelled) return;
        const idx = buildIndex(
          jobsJson.jobs ?? [],
          agentsJson.agents ?? [],
          sessionsJson.sessions ?? [],
          tasksJson.tasks ?? []
        );
        setItems(idx);
      } catch {
        if (!cancelled) setItems(buildIndex([], [], []));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Focus input on mount.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const results = useMemo(() => {
    if (!query.trim()) return items.slice(0, 30);
    return searchIndex(items, query, 30);
  }, [items, query]);

  // Clamp selection when results shrink.
  useEffect(() => {
    setSelected((s) => Math.min(Math.max(0, s), Math.max(0, results.length - 1)));
  }, [results.length]);

  // Scroll selected into view.
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLLIElement>(`[data-idx="${selected}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  function activate(item: CommandItem) {
    onClose();
    if (item.action === "toggle-theme") {
      cycle();
      return;
    }
    if (item.href && item.href !== "#") router.push(item.href);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, results.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const it = results[selected];
      if (it) activate(it);
    }
  }

  return (
    <Portal>
      <div
        className="fixed inset-0 z-50 flex items-start justify-center pt-24 px-4"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <div
          className="absolute inset-0 bg-black/50 backdrop-blur-sm"
          onClick={onClose}
        />
        <div
          className="relative w-full max-w-xl rounded-[10px] border border-border bg-bg-elev shadow-lg overflow-hidden"
          onKeyDown={onKey}
        >
          {/* Search input */}
          <div className="flex items-center gap-2 px-3 h-11 border-b border-border">
            <IconSearch className="w-4 h-4 text-subtle" />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search chats, tasks, jobs, agents, URLs…"
              className="flex-1 bg-transparent outline-none text-[13px] placeholder:text-subtle"
            />
            <button
              type="button"
              onClick={onClose}
              className="text-[11px] text-subtle hover:text-fg"
              aria-label="Close"
            >
              Esc
            </button>
          </div>

          {/* Results */}
          <ul ref={listRef} className="max-h-[60vh] overflow-y-auto py-1">
            {loading && results.length === 0 ? (
              <li className="px-3 py-6 text-center text-[12px] text-subtle">Loading…</li>
            ) : results.length === 0 ? (
              <li className="px-3 py-6 text-center text-[12px] text-subtle">
                No matches for “{query.trim()}”.
              </li>
            ) : (
              results.map((item, idx) => {
                const active = idx === selected;
                return (
                  <li key={item.id} data-idx={idx}>
                    <button
                      type="button"
                      onMouseEnter={() => setSelected(idx)}
                      onClick={() => activate(item)}
                      className={[
                        "w-full flex items-center gap-3 px-3 py-2 text-left transition-colors",
                        active ? "bg-bg-hover" : "hover:bg-bg-subtle",
                      ].join(" ")}
                    >
                      <span className="w-12 shrink-0 text-[10px] uppercase tracking-wider text-subtle">
                        {kindLabel(item.kind)}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-[13px] text-fg truncate">{item.title}</span>
                        {item.subtitle && (
                          <span className="block text-[12px] text-subtle truncate">
                            {item.subtitle}
                          </span>
                        )}
                      </span>
                      {item.meta && (
                        <span className="hidden sm:block max-w-[150px] truncate text-[11px] text-subtle">
                          {item.meta}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      </div>
    </Portal>
  );
}
