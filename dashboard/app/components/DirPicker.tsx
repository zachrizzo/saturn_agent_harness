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
  recentVariant?: "pills" | "cards";
  recentLimit?: number;
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

function projectName(dir: string): string {
  const normalized = dir.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).filter(Boolean).pop() ?? dir;
}

function parentPath(dir: string): string {
  const normalized = dir.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 1) return dir;
  const prefix = normalized.startsWith("/") ? "/" : "";
  return `${prefix}${parts.slice(0, -1).join("/")}`;
}

export function DirPicker({
  value,
  onChange,
  disabled,
  className,
  recentVariant = "pills",
  recentLimit = 5,
}: Props) {
  const [dirs, setDirs] = useState<string[]>([]);
  const [recentDirs, setRecentDirs] = useState<string[]>([]);
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const onChangeRef = useRef(onChange);

  useEffect(() => setQuery(value), [value]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

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
        onChangeRef.current(last);
        localDirs = [last, ...localDirs.filter((dir) => dir !== last)];
      }
    } catch {}
    if (localDirs.length > 0) {
      setDirs(localDirs);
      setRecentDirs(localDirs);
    }

    fetch("/api/directories")
      .then((r) => r.json())
      .then((d) => {
        const serverDirs = Array.isArray(d.dirs) ? d.dirs.filter((dir: unknown): dir is string => typeof dir === "string") : [];
        const serverRecentDirs = Array.isArray(d.recentDirs)
          ? d.recentDirs.filter((dir: unknown): dir is string => typeof dir === "string")
          : [];
        setRecentDirs([...new Set([...localDirs, ...serverRecentDirs])]);
        setDirs([...new Set([...localDirs, ...serverDirs])]);
      })
      .catch(() => {});
  }, []);

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
  const visibleRecentDirs = (recentDirs.length > 0 ? recentDirs : dirs).slice(0, recentLimit);

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
    if (next.length > 0) {
      setRecentDirs((current) => [...new Set([...next, ...current])]);
      setDirs((current) => [...new Set([...next, ...current])]);
    }
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
          placeholder="$HOME/programming/..."
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
      {recentVariant === "cards" && visibleRecentDirs.length > 0 && (
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-2">
          {visibleRecentDirs.map((dir) => {
            const selected = value.trim() === dir;
            return (
              <button
                key={dir}
                type="button"
                disabled={disabled || picking}
                onMouseDown={(e) => { e.preventDefault(); select(dir); }}
                className={[
                  "min-w-0 rounded-md border px-3 py-2 text-left transition-colors disabled:opacity-40",
                  selected
                    ? "border-accent bg-accent-soft"
                    : "border-border bg-bg-elev hover:bg-bg-hover hover:border-border-strong",
                ].join(" ")}
                title={dir}
              >
                <span className="flex min-w-0 items-start gap-2">
                  <svg className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                  </svg>
                  <span className="min-w-0">
                    <span className="block truncate text-[12px] font-medium text-fg">{projectName(dir)}</span>
                    <span className="mt-0.5 block truncate mono text-[11px] text-muted">{parentPath(dir)}</span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
      {recentVariant === "pills" && !open && visibleRecentDirs.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {visibleRecentDirs.map((dir) => (
            <button
              key={dir}
              type="button"
              disabled={disabled || picking}
              onMouseDown={(e) => { e.preventDefault(); select(dir); }}
              className="text-[11px] px-2 py-0.5 rounded-md bg-bg-elev border border-border text-muted hover:text-fg hover:border-fg/30 transition-colors mono max-w-[200px] truncate disabled:opacity-40"
              title={dir}
            >
              {dir.split("/").filter(Boolean).pop() ?? dir}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
