"use client";

import { useEffect, useRef, useState } from "react";
import { Button, Input } from "./ui";

const LAST_WORKING_DIR_KEY = "saturn:last-working-directory";
const RECENT_WORKING_DIRS_KEY = "saturn:recent-working-directories";

type Props = {
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  className?: string;
};

type PickResponse = {
  dir?: string;
  recentDirs?: string[];
  cancelled?: boolean;
  error?: string;
};

function isLocalDirectoryCandidate(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return false;
  if (trimmed === "~" || trimmed === "$HOME" || trimmed === "$CODEX_HOME" || trimmed === "." || trimmed === "..") return true;
  return /^(\/|~\/|\$HOME\/|\$CODEX_HOME\/|\.{1,2}\/)/.test(trimmed);
}

export function DirPicker({ value, onChange, disabled, className }: Props) {
  const [dirs, setDirs] = useState<string[]>([]);
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => setQuery(value), [value]);

  useEffect(() => {
    let localDirs: string[] = [];
    try {
      const last = localStorage.getItem(LAST_WORKING_DIR_KEY);
      const recent = JSON.parse(localStorage.getItem(RECENT_WORKING_DIRS_KEY) ?? "[]") as unknown;
      localDirs = Array.isArray(recent)
        ? recent.filter((dir): dir is string => typeof dir === "string" && isLocalDirectoryCandidate(dir))
        : [];
      if (last && !value && isLocalDirectoryCandidate(last)) {
        setQuery(last);
        onChange(last);
        localDirs = [last, ...localDirs.filter((dir) => dir !== last)];
      }
    } catch {}
    if (localDirs.length > 0) setDirs(localDirs);

    fetch("/api/directories")
      .then((r) => r.json())
      .then((d) => {
        const serverDirs = Array.isArray(d.dirs) ? d.dirs.filter((dir: unknown): dir is string => typeof dir === "string") : [];
        setDirs([...new Set([...localDirs, ...serverDirs])]);
      })
      .catch(() => {});
  }, [onChange, value]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const filtered = query.trim()
    ? dirs.filter((d) => d.toLowerCase().includes(query.toLowerCase()))
    : dirs;

  const select = (dir: string) => {
    onChange(dir);
    setQuery(dir);
    persist(dir, { localFirst: true });
    setOpen(false);
    setError(null);
  };

  const persistLocal = (dir: string) => {
    const trimmed = dir.trim();
    if (!isLocalDirectoryCandidate(trimmed)) return;
    try {
      const recent = JSON.parse(localStorage.getItem(RECENT_WORKING_DIRS_KEY) ?? "[]") as unknown;
      const existing = Array.isArray(recent)
        ? recent.filter((item): item is string => typeof item === "string" && isLocalDirectoryCandidate(item))
        : [];
      const next = [trimmed, ...existing.filter((item) => item !== trimmed)].slice(0, 75);
      localStorage.setItem(LAST_WORKING_DIR_KEY, trimmed);
      localStorage.setItem(RECENT_WORKING_DIRS_KEY, JSON.stringify(next));
    } catch {}
  };

  const mergeRecentDirs = (recentDirs: unknown) => {
    const next = Array.isArray(recentDirs)
      ? recentDirs.filter((item): item is string => typeof item === "string")
      : [];
    if (next.length > 0) setDirs((current) => [...new Set([...next, ...current])]);
  };

  const persist = (dir: string, options?: { localFirst?: boolean }) => {
    const trimmed = dir.trim();
    if (!trimmed) return;
    if (options?.localFirst) persistLocal(trimmed);
    fetch("/api/directories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dir: trimmed }),
    })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => {
        if (!d?.dir) return;
        persistLocal(d.dir);
        mergeRecentDirs(d.recentDirs);
      })
      .catch(() => {});
  };

  const pickSystemFolder = async () => {
    setPicking(true);
    setOpen(false);
    setError(null);
    try {
      const res = await fetch("/api/directories/pick", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dir: query.trim() || value.trim() || undefined }),
      });
      const data = (await res.json()) as PickResponse;
      if (data.cancelled) return;
      if (!res.ok || !data.dir) throw new Error(data.error ?? "folder picker failed");

      onChange(data.dir);
      setQuery(data.dir);
      persistLocal(data.dir);
      mergeRecentDirs(data.recentDirs);
    } catch (err) {
      setError(err instanceof Error ? err.message : "folder picker failed");
    } finally {
      setPicking(false);
    }
  };

  return (
    <div ref={containerRef} className={`relative ${className ?? ""}`}>
      <div className="flex gap-2">
        <Input
          value={query}
          onChange={(e) => { setQuery(e.target.value); onChange(e.target.value); setOpen(true); setError(null); }}
          onBlur={() => persist(query)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              persist(query);
              setOpen(false);
            }
          }}
          onFocus={() => setOpen(true)}
          disabled={disabled || picking}
          placeholder="/Users/zachrizzo/programming/..."
          className="min-w-0 mono"
        />
        <Button
          type="button"
          size="sm"
          disabled={disabled || picking}
          onClick={pickSystemFolder}
        >
          {picking ? "Choosing..." : "Browse"}
        </Button>
      </div>
      {error && (
        <div className="mt-1 text-[11px] text-[var(--fail)]">{error}</div>
      )}
      {open && filtered.length > 0 && (
        <ul className="absolute z-50 top-full left-0 right-0 mt-1 bg-bg-elev border border-border rounded-md shadow-lg max-h-64 overflow-y-auto">
          {filtered.slice(0, 50).map((dir) => (
            <li key={dir}>
              <button
                type="button"
                onMouseDown={(e) => { e.preventDefault(); select(dir); }}
                className="w-full text-left px-3 py-1.5 text-xs mono hover:bg-bg-hover transition-colors text-muted hover:text-fg truncate"
                title={dir}
              >
                {dir}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
