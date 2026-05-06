"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button, Chip, Input, Select, Textarea } from "@/app/components/ui";
import { MemorySettingsPanel } from "@/app/components/memory/MemorySettingsPanel";

type RawRecord = Record<string, unknown>;

type SourceSession = {
  id: string;
  title: string;
  href?: string;
  at?: string;
};

type MemoryRef = {
  id: string;
  title: string;
  type?: string;
  scope?: string;
};

type MemoryNote = {
  id: string;
  title: string;
  content: string;
  scope: string;
  scopeKind: "global" | "project";
  type: string;
  cwd?: string | null;
  tags: string[];
  aliases: string[];
  createdAt?: string;
  updatedAt?: string;
  sourceSessions: SourceSession[];
  backlinks: MemoryRef[];
  related: MemoryRef[];
};

type MemoryDraft = {
  title: string;
  content: string;
  scope: string;
  type: string;
  cwd: string;
  tagsText: string;
  aliasesText: string;
};

type GraphNode = {
  id: string;
  title: string;
  type?: string;
  scope?: string;
  x?: number;
  y?: number;
};

type GraphEdge = {
  source: string;
  target: string;
  label?: string;
};

type GraphData = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

type LayoutNode = GraphNode & {
  x: number;
  y: number;
  degree: number;
  component: number;
  radius: number;
};

type GraphViewport = {
  x: number;
  y: number;
  k: number;
};

const MEMORY_TYPES = [
  "Entities",
  "Concepts",
  "Projects",
  "Decisions",
  "Troubleshooting",
  "Sessions",
] as const;

const EMPTY_DRAFT: MemoryDraft = {
  title: "",
  content: "",
  scope: "global",
  type: "Concepts",
  cwd: "",
  tagsText: "",
  aliasesText: "",
};

const MARKDOWN_PLUGINS = [remarkGfm];
const MEMORY_LIST_DEBOUNCE_MS = 180;
const MEMORY_LIST_PAGE_SIZE = 50;

type MemoryPageInfo = {
  limit: number;
  offset: number;
  nextOffset: number;
  hasMore: boolean;
};

type MemoryWorkspaceProps = {
  defaultCwd?: string | null;
};

function isRecord(value: unknown): value is RawRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function optionalMemoryType(value: unknown): string | undefined {
  const type = optionalString(value);
  return type && (MEMORY_TYPES as readonly string[]).includes(type) ? type : undefined;
}

function normalizeScope(value: unknown, fallbackCwd?: unknown): {
  label: string;
  kind: "global" | "project";
  cwd?: string | null;
} {
  const cwd = optionalString(fallbackCwd);
  if (isRecord(value)) {
    const kind = stringValue(value.kind ?? value.scope_kind, "global");
    if (kind === "project") {
      const projectKey = stringValue(value.projectKey ?? value.project_key, "project");
      const projectPath = optionalString(value.projectPath ?? value.project_path) ?? cwd;
      return {
        label: `project:${projectKey}`,
        kind: "project",
        cwd: projectPath ?? null,
      };
    }
    return { label: "global", kind: "global", cwd: null };
  }

  const raw = optionalString(value);
  if (!raw || raw === "global") return { label: "global", kind: "global", cwd: null };
  if (raw === "project") return { label: "project", kind: "project", cwd: cwd ?? null };
  if (raw.startsWith("project:")) return { label: raw, kind: "project", cwd: cwd ?? null };
  return { label: raw, kind: "project", cwd: cwd ?? raw };
}

function scopeLabel(value: unknown): string | undefined {
  return normalizeScope(value).label;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function pickArray(data: unknown, keys: string[]): unknown[] {
  if (Array.isArray(data)) return data;
  if (!isRecord(data)) return [];
  for (const key of keys) {
    const value = data[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function normalizeSourceSession(value: unknown): SourceSession | null {
  if (typeof value === "string") {
    return { id: value, title: value, href: `/chats/${encodeURIComponent(value)}` };
  }
  if (!isRecord(value)) return null;
  const id = stringValue(value.id ?? value.sessionId ?? value.session_id ?? value.chatId);
  const title = stringValue(value.title ?? value.name ?? value.summary, id || "Session");
  if (!id && !title) return null;
  const href = optionalString(value.href) ?? (id ? `/chats/${encodeURIComponent(id)}` : undefined);
  return {
    id: id || title,
    title,
    href,
    at: optionalString(value.at ?? value.createdAt ?? value.created_at),
  };
}

function normalizeMemoryRef(value: unknown, fallbackId = ""): MemoryRef | null {
  if (typeof value === "string") {
    return { id: value, title: value };
  }
  if (!isRecord(value)) return null;
  const id = stringValue(value.id ?? value.key ?? value.slug, fallbackId);
  const title = stringValue(value.title ?? value.name ?? value.label, id);
  if (!id && !title) return null;
  return {
    id: id || title,
    title,
    type: optionalString(value.type ?? value.kind),
    scope: scopeLabel(value.scope),
  };
}

function normalizeMemoryNote(value: unknown, index = 0): MemoryNote | null {
  if (!isRecord(value)) return null;
  const source = isRecord(value.note) ? value.note : value;
  const id = stringValue(source.id ?? source._id ?? source.key ?? source.slug, `memory-${index}`);
  const title = stringValue(source.title ?? source.name ?? source.label, id);
  const content = stringValue(
    source.content ?? source.markdown ?? source.body ?? source.text ?? source.excerpt ?? value.snippet,
  );
  const scope = normalizeScope(
    source.scope ?? source.namespace,
    source.cwd ?? source.projectPath ?? source.project_path,
  );
  const metadata = isRecord(source.metadata) ? source.metadata : {};
  const directSessions = pickArray(source.sourceSessions ?? source.source_sessions ?? source.sessions, [
    "sourceSessions",
    "source_sessions",
    "sessions",
  ]);
  const sourceSessionId = stringValue(metadata.session_id ?? metadata.sessionId);
  const sourceSessions = sourceSessionId
    ? [
        ...directSessions,
        {
          id: sourceSessionId,
          title: `Session ${sourceSessionId}`,
          at: optionalString(source.updatedAt ?? source.updated_at),
        },
      ]
    : directSessions;

  return {
    id,
    title,
    content,
    scope: scope.label,
    scopeKind: scope.kind,
    type: optionalMemoryType(source.type ?? source.kind ?? source.category) ?? "Concepts",
    cwd: scope.cwd ?? optionalString(source.cwd ?? source.projectPath ?? source.project_path) ?? null,
    tags: stringArray(source.tags ?? source.tag),
    aliases: stringArray(source.aliases ?? source.alias),
    createdAt: optionalString(source.createdAt ?? source.created_at),
    updatedAt: optionalString(source.updatedAt ?? source.updated_at ?? source.modifiedAt),
    sourceSessions: sourceSessions
      .map(normalizeSourceSession)
      .filter((item): item is SourceSession => Boolean(item)),
    backlinks: pickArray(source.backlinks ?? source.backLinks, ["backlinks", "backLinks"])
      .map((item, refIndex) => normalizeMemoryRef(item, `${id}-backlink-${refIndex}`))
      .filter((item): item is MemoryRef => Boolean(item)),
    related: pickArray(source.related ?? source.relatedNotes, ["related", "relatedNotes"])
      .map((item, refIndex) => normalizeMemoryRef(item, `${id}-related-${refIndex}`))
      .filter((item): item is MemoryRef => Boolean(item)),
  };
}

function normalizeMemoryList(data: unknown): MemoryNote[] {
  return pickArray(data, ["memories", "memory", "items", "notes", "results", "data"])
    .map(normalizeMemoryNote)
    .filter((item): item is MemoryNote => Boolean(item));
}

function normalizeMemoryPageInfo(data: unknown, fallbackOffset: number, loadedCount: number): MemoryPageInfo {
  const record = isRecord(data) && isRecord(data.pageInfo) ? data.pageInfo : {};
  const offset = typeof record.offset === "number" ? record.offset : fallbackOffset;
  const limit = typeof record.limit === "number" ? record.limit : MEMORY_LIST_PAGE_SIZE;
  return {
    limit,
    offset,
    nextOffset: typeof record.nextOffset === "number" ? record.nextOffset : offset + loadedCount,
    hasMore: typeof record.hasMore === "boolean" ? record.hasMore : loadedCount >= limit,
  };
}

function mergeMemoryNote(existing: MemoryNote | undefined, next: MemoryNote): MemoryNote {
  if (!existing) return next;
  const sameUpdatedAt = (existing.updatedAt ?? "") === (next.updatedAt ?? "");
  if (!sameUpdatedAt) return next;
  const merged = {
    ...next,
    content: existing.content.length > next.content.length ? existing.content : next.content,
    backlinks: existing.backlinks.length ? existing.backlinks : next.backlinks,
    related: existing.related.length ? existing.related : next.related,
    sourceSessions: existing.sourceSessions.length ? existing.sourceSessions : next.sourceSessions,
  };
  return memoryNoteEqual(existing, merged) ? existing : merged;
}

function mergeMemoryList(current: MemoryNote[], next: MemoryNote[]): MemoryNote[] {
  if (!current.length) return next;
  const currentById = new Map(current.map((note) => [note.id, note]));
  const nextIds = new Set(next.map((note) => note.id));
  const merged = [
    ...next.map((note) => mergeMemoryNote(currentById.get(note.id), note)),
    ...current.filter((note) => !nextIds.has(note.id)),
  ];
  return memoryListEqual(current, merged) ? current : merged;
}

function appendMemoryList(current: MemoryNote[], next: MemoryNote[]): MemoryNote[] {
  if (!current.length) return next;
  const indexes = new Map(current.map((note, index) => [note.id, index]));
  const merged = [...current];
  for (const note of next) {
    const existingIndex = indexes.get(note.id);
    if (existingIndex === undefined) {
      indexes.set(note.id, merged.length);
      merged.push(note);
    } else {
      merged[existingIndex] = mergeMemoryNote(merged[existingIndex], note);
    }
  }
  return memoryListEqual(current, merged) ? current : merged;
}

function stringListEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sourceSessionsEqual(a: SourceSession[], b: SourceSession[]): boolean {
  return a.length === b.length && a.every((session, index) => {
    const next = b[index];
    return Boolean(next)
      && session.id === next.id
      && session.title === next.title
      && (session.href ?? "") === (next.href ?? "")
      && (session.at ?? "") === (next.at ?? "");
  });
}

function refsEqual(a: MemoryRef[], b: MemoryRef[]): boolean {
  return a.length === b.length && a.every((ref, index) => {
    const next = b[index];
    return Boolean(next)
      && ref.id === next.id
      && ref.title === next.title
      && (ref.type ?? "") === (next.type ?? "")
      && (ref.scope ?? "") === (next.scope ?? "");
  });
}

function memoryNoteEqual(a: MemoryNote, b: MemoryNote): boolean {
  return a.id === b.id
    && a.title === b.title
    && a.content === b.content
    && a.scope === b.scope
    && a.scopeKind === b.scopeKind
    && a.type === b.type
    && (a.cwd ?? "") === (b.cwd ?? "")
    && (a.createdAt ?? "") === (b.createdAt ?? "")
    && (a.updatedAt ?? "") === (b.updatedAt ?? "")
    && stringListEqual(a.tags, b.tags)
    && stringListEqual(a.aliases, b.aliases)
    && sourceSessionsEqual(a.sourceSessions, b.sourceSessions)
    && refsEqual(a.backlinks, b.backlinks)
    && refsEqual(a.related, b.related);
}

function memoryListEqual(a: MemoryNote[], b: MemoryNote[]): boolean {
  return a.length === b.length && a.every((note, index) => {
    const next = b[index];
    return Boolean(next) && memoryNoteEqual(note, next);
  });
}

function pageInfoEqual(a: MemoryPageInfo, b: MemoryPageInfo): boolean {
  return a.limit === b.limit
    && a.offset === b.offset
    && a.nextOffset === b.nextOffset
    && a.hasMore === b.hasMore;
}

function normalizeGraph(data: unknown, notes: MemoryNote[]): GraphData {
  const rawNodes = pickArray(data, ["nodes"]);
  const rawEdges = pickArray(data, ["edges", "links"]);
  const nodes = rawNodes
    .map((node, index): GraphNode | null => {
      const ref = normalizeMemoryRef(node, `node-${index}`);
      if (!ref) return null;
      const raw = isRecord(node) ? node : {};
      return {
        ...ref,
        x: typeof raw.x === "number" ? raw.x : undefined,
        y: typeof raw.y === "number" ? raw.y : undefined,
      };
    })
    .filter((node): node is GraphNode => Boolean(node));

  const edges = rawEdges
    .map((edge): GraphEdge | null => {
      if (!isRecord(edge)) return null;
      const source = stringValue(edge.source ?? edge.from ?? edge.sourceId ?? edge.source_id);
      const target = stringValue(edge.target ?? edge.to ?? edge.targetId ?? edge.target_id);
      if (!source || !target) return null;
      return { source, target, label: optionalString(edge.label ?? edge.type) };
    })
    .filter((edge): edge is GraphEdge => Boolean(edge));

  if (nodes.length) return { nodes, edges };
  return graphFromNotes(notes);
}

function graphFromNotes(notes: MemoryNote[]): GraphData {
  const nodes = notes.map((note) => ({
    id: note.id,
    title: note.title,
    type: note.type,
    scope: note.scope,
  }));
  const edges: GraphEdge[] = [];
  for (const note of notes) {
    for (const target of extractWikilinks(note.content)) {
      const linked = findByTitle(notes, target);
      if (linked) edges.push({ source: note.id, target: linked.id });
    }
  }
  return { nodes, edges };
}

function titleKey(value: string): string {
  return value.trim().toLowerCase();
}

function findByTitle(notes: MemoryNote[], target: string): MemoryNote | undefined {
  const key = titleKey(target);
  return notes.find((note) => (
    titleKey(note.title) === key ||
    titleKey(note.id) === key ||
    note.aliases.some((alias) => titleKey(alias) === key)
  ));
}

function extractWikilinks(content: string): string[] {
  const links = new Set<string>();
  for (const match of content.matchAll(/\[\[([^\]\n]+)\]\]/g)) {
    const [target] = match[1].split("|");
    if (target.trim()) links.add(target.trim());
  }
  return [...links];
}

function markdownLabel(value: string): string {
  return value.replace(/([\\[\]])/g, "\\$1");
}

function preprocessWikilinks(content: string): string {
  return content.replace(/\[\[([^\]\n]+)\]\]/g, (_match, raw: string) => {
    const [targetRaw, labelRaw] = raw.split("|");
    const target = targetRaw.trim();
    const label = (labelRaw ?? target).trim();
    if (!target) return label;
    return `[${markdownLabel(label)}](memory:${encodeURIComponent(target)})`;
  });
}

function draftFromNote(note: MemoryNote | null): MemoryDraft {
  if (!note) return EMPTY_DRAFT;
  return {
    title: note.title,
    content: note.content,
    scope: note.scopeKind,
    type: optionalMemoryType(note.type) ?? "Concepts",
    cwd: note.cwd ?? "",
    tagsText: note.tags.join(", "),
    aliasesText: note.aliases.join(", "),
  };
}

function payloadFromDraft(draft: MemoryDraft) {
  const scope = draft.scope === "project" ? "project" : "global";
  return {
    title: draft.title.trim(),
    content: draft.content,
    scope,
    type: optionalMemoryType(draft.type) ?? "Concepts",
    cwd: scope === "project" ? draft.cwd.trim() || undefined : undefined,
    tags: stringArray(draft.tagsText),
    aliases: stringArray(draft.aliasesText),
  };
}

function formatDate(value?: string): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function notePreview(note: MemoryNote): string {
  const text = note.content
    .replace(/\[\[([^\]\n]+)\]\]/g, (_match, raw: string) => {
      const [targetRaw, labelRaw] = raw.split("|");
      return (labelRaw ?? targetRaw).trim();
    })
    .replace(/\[([^\]\n]+)\]\([^\)\n]+\)/g, "$1");
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^#{1,6}\s+/, "").replace(/^[-*]\s+/, "").trim())
    .filter(Boolean);

  const normalizedTitle = note.title.toLowerCase().replace(/\s+/g, " ").trim();
  const usefulLines = lines.filter((line, index) => {
    const normalizedLine = line.toLowerCase().replace(/\s+/g, " ").trim();
    if (index === 0 && (normalizedLine === normalizedTitle || normalizedTitle.startsWith(normalizedLine))) return false;
    return !/^captured from\s+/i.test(line) && !/^type:\s+/i.test(line) && line.toLowerCase() !== "evidence";
  });
  const normalizedPatterns = [
    /^captured from\s+.*?\.\s*/i,
    /^type:\s+[\w-]+\s*/i,
    /^#{1,6}\s*evidence\s*/i,
    /^evidence\s*/i,
    /^[-*]\s*session:\s+\S+\s*/i,
    /^[-*]\s*turn:\s+\S+\s*/i,
    /^[-*]\s*captured:\s+\S+\s*/i,
    /^[-*]\s*scope:\s+\S+\s*/i,
    /^#{1,6}\s*transcript\s*/i,
    /^transcript\s*/i,
  ];
  let summary = usefulLines.join(" ").replace(/\s+/g, " ").trim().replace(/^#{1,6}\s+/, "");
  if (summary.toLowerCase().startsWith(normalizedTitle)) {
    summary = summary.slice(note.title.length).trim();
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of normalizedPatterns) {
      const next = summary.replace(pattern, "").trim();
      if (next !== summary) {
        summary = next;
        changed = true;
      }
    }
  }
  return summary.slice(0, 118) || "No content yet.";
}

function isNoisyMemoryTag(tag: string): boolean {
  const normalized = tag.trim();
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(normalized)
    || (/^[a-f0-9-]{24,}$/i.test(normalized) && normalized.includes("-"));
}

function memoryTagLabel(tag: string): string {
  return tag === "captured-turn" ? "captured" : tag;
}

function noteTagSummary(tags: string[]): { visible: Array<{ value: string; label: string }>; hiddenCount: number } {
  const visible = tags
    .filter((tag) => tag.trim() && !isNoisyMemoryTag(tag))
    .slice(0, 2)
    .map((tag) => ({ value: tag, label: memoryTagLabel(tag) }));
  return {
    visible,
    hiddenCount: Math.max(0, tags.length - visible.length),
  };
}

function groupNotes(notes: MemoryNote[]): Array<{ key: string; label: string; notes: MemoryNote[] }> {
  const groups = new Map<string, MemoryNote[]>();
  for (const note of notes) {
    const key = `${note.scope || "global"} / ${note.type || "note"}`;
    groups.set(key, [...(groups.get(key) ?? []), note]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, grouped]) => ({
      key,
      label: key,
      notes: grouped.sort((a, b) => a.title.localeCompare(b.title)),
    }));
}

function useMemoryList(search: string, scope: string, type: string, defaultCwd?: string | null) {
  const [notes, setNotes] = useState<MemoryNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageInfo, setPageInfo] = useState<MemoryPageInfo>({
    limit: MEMORY_LIST_PAGE_SIZE,
    offset: 0,
    nextOffset: 0,
    hasMore: false,
  });
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);
  const controllerRef = useRef<AbortController | null>(null);
  const requestSeqRef = useRef(0);

  const loadNotes = useCallback(async (
    offset: number,
    mode: "replace" | "append" | "refresh",
    showLoading = false,
  ) => {
    const projectCwd = scope === "project" ? defaultCwd?.trim() : "";
    if (scope === "project" && !projectCwd) {
      controllerRef.current?.abort();
      setNotes([]);
      setPageInfo({
        limit: MEMORY_LIST_PAGE_SIZE,
        offset: 0,
        nextOffset: 0,
        hasMore: false,
      });
      setError("Project filter requires a default working directory in Settings.");
      setLoading(false);
      setLoadingMore(false);
      loadedRef.current = true;
      return;
    }

    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const signal = controller.signal;

    if (mode === "append") setLoadingMore(true);
    if (mode === "replace" && (showLoading || !loadedRef.current)) setLoading(true);

    const params = new URLSearchParams();
    if (search.trim()) params.set("q", search.trim());
    if (scope !== "all") params.set("scope", scope);
    if (projectCwd) params.set("cwd", projectCwd);
    if (type !== "all") params.set("type", type);
    params.set("limit", String(MEMORY_LIST_PAGE_SIZE));
    if (offset > 0) params.set("offset", String(offset));

    try {
      const res = await fetch(`/api/memory?${params.toString()}`, { signal });
      if (!res.ok) throw new Error(`Memory request failed: ${res.status}`);
      const data = await res.json();
      const next = normalizeMemoryList(data);
      const nextPageInfo = normalizeMemoryPageInfo(data, offset, next.length);
      if (signal.aborted) return;

      setNotes((current) => {
        if (mode === "append") return appendMemoryList(current, next);
        if (mode === "refresh") return mergeMemoryList(current, next);
        return memoryListEqual(current, next) ? current : next;
      });
      setPageInfo((current) => {
        const updated = mode === "refresh"
          ? {
              ...current,
              hasMore: current.hasMore || nextPageInfo.hasMore,
            }
          : nextPageInfo;
        return pageInfoEqual(current, updated) ? current : updated;
      });
      loadedRef.current = true;
      setError((current) => (current === null ? current : null));
    } catch (err) {
      if (signal.aborted) return;
      if (!loadedRef.current || showLoading || mode === "append") {
        setError(err instanceof Error ? err.message : "Unable to load memory.");
      }
    } finally {
      if (mode === "append") setLoadingMore(false);
      if (!signal.aborted && requestSeqRef.current === requestSeq) {
        if (mode === "replace") setLoading(false);
      }
    }
  }, [defaultCwd, search, scope, type]);

  useEffect(() => {
    let stopped = false;
    loadedRef.current = false;
    setNotes([]);
    setPageInfo({
      limit: MEMORY_LIST_PAGE_SIZE,
      offset: 0,
      nextOffset: 0,
      hasMore: false,
    });
    setError(null);
    setLoading(true);
    setLoadingMore(false);

    const refreshIfVisible = () => {
      if (document.visibilityState === "visible" && loadedRef.current) void loadNotes(0, "refresh");
    };

    const timer = window.setTimeout(() => {
      if (!stopped) void loadNotes(0, "replace", true);
    }, MEMORY_LIST_DEBOUNCE_MS);
    document.addEventListener("visibilitychange", refreshIfVisible);
    window.addEventListener("focus", refreshIfVisible);

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", refreshIfVisible);
      window.removeEventListener("focus", refreshIfVisible);
      controllerRef.current?.abort();
    };
  }, [loadNotes]);

  const loadMore = useCallback(() => {
    if (loading || loadingMore || !pageInfo.hasMore) return;
    void loadNotes(pageInfo.nextOffset, "append");
  }, [loadNotes, loading, loadingMore, pageInfo.hasMore, pageInfo.nextOffset]);

  return {
    notes,
    setNotes,
    loading,
    loadingMore,
    error,
    hasMore: pageInfo.hasMore,
    loadMore,
  };
}

function useMemoryGraph(enabled: boolean, notes: MemoryNote[]) {
  const [graph, setGraph] = useState<GraphData>(() => graphFromNotes(notes));
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setGraph(graphFromNotes(notes));
  }, [notes]);

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setLoading(true);
    fetch("/api/memory/graph?semantic=1", { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`Graph request failed: ${res.status}`))))
      .then((data) => setGraph(normalizeGraph(data, notes)))
      .catch(() => {
        if (!controller.signal.aborted) setGraph(graphFromNotes(notes));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [enabled, notes]);

  return { graph, loading };
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="memory-info-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="memory-empty">
      <h3>{title}</h3>
      <p>{body}</p>
    </div>
  );
}

export function MemoryWorkspace({ defaultCwd = null }: MemoryWorkspaceProps) {
  const [search, setSearch] = useState("");
  const [scopeFilter, setScopeFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setMode] = useState<"preview" | "edit" | "graph">("preview");
  const [mobileMode, setMobileMode] = useState<"notes" | "note" | "context">("notes");
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<MemoryDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const { notes, setNotes, loading, loadingMore, error, hasMore, loadMore } = useMemoryList(
    search,
    scopeFilter,
    typeFilter,
    defaultCwd,
  );
  const selected = useMemo(
    () => notes.find((note) => note.id === selectedId) ?? notes[0] ?? null,
    [notes, selectedId],
  );
  const { graph, loading: graphLoading } = useMemoryGraph(mode === "graph", notes);

  const scopes = ["all", "global", "project"];
  const types = ["all", ...MEMORY_TYPES];
  const grouped = useMemo(() => groupNotes(notes), [notes]);

  useEffect(() => {
    if (creating) return;
    if (!selectedId && selected) setSelectedId(selected.id);
    if (selectedId && notes.length && !notes.some((note) => note.id === selectedId)) {
      setSelectedId(notes[0]?.id ?? null);
    }
  }, [creating, notes, selected, selectedId]);

  useEffect(() => {
    if (creating || mode === "edit") return;
    setDraft(draftFromNote(selected));
    setDeleteConfirmId(null);
    setDeleteError(null);
  }, [creating, mode, selected]);

  useEffect(() => {
    if (creating || !selected?.id) return;
    const controller = new AbortController();

    fetch(`/api/memory/${encodeURIComponent(selected.id)}`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`Memory detail failed: ${res.status}`))))
      .then((data) => {
        const note = normalizeMemoryNote(
          isRecord(data) ? (data.memory ?? data.note ?? data.item ?? data.data ?? data) : data,
          0,
        );
        if (!note) return;
        setNotes((current) => {
          const exists = current.some((item) => item.id === note.id);
          if (!exists) return [note, ...current];
          let changed = false;
          const updated = current.map((item) => {
            if (item.id !== note.id) return item;
            const merged = mergeMemoryNote(item, note);
            if (memoryNoteEqual(item, merged)) return item;
            changed = true;
            return merged;
          });
          return changed ? updated : current;
        });
      })
      .catch(() => {
        // Detail hydration is best-effort; list results still render useful excerpts.
      });

    return () => controller.abort();
  }, [creating, selected?.id, selected?.updatedAt, setNotes]);

  const backlinks = useMemo(() => {
    if (!selected) return [];
    const names = new Set([selected.title, selected.id, ...selected.aliases].map(titleKey));
    const computed = notes
      .filter((note) => note.id !== selected.id)
      .filter((note) => extractWikilinks(note.content).some((link) => names.has(titleKey(link))))
      .map((note) => ({ id: note.id, title: note.title, type: note.type, scope: note.scope }));
    const merged = new Map<string, MemoryRef>();
    for (const ref of [...selected.backlinks, ...computed]) merged.set(ref.id, ref);
    return [...merged.values()];
  }, [notes, selected]);

  const related = useMemo(() => {
    if (!selected) return [];
    const adjacent = graph.edges
      .filter((edge) => edge.source === selected.id || edge.target === selected.id)
      .map((edge) => (edge.source === selected.id ? edge.target : edge.source))
      .map((id) => notes.find((note) => note.id === id))
      .filter((note): note is MemoryNote => Boolean(note))
      .map((note) => ({ id: note.id, title: note.title, type: note.type, scope: note.scope }));
    const merged = new Map<string, MemoryRef>();
    for (const ref of [...selected.related, ...adjacent]) merged.set(ref.id, ref);
    return [...merged.values()].filter((ref) => ref.id !== selected.id);
  }, [graph.edges, notes, selected]);

  const markdownComponents = useMemo<Components>(() => ({
    a: ({ href, children }) => {
      const url = String(href ?? "");
      if (url.startsWith("memory:")) {
        const target = decodeURIComponent(url.slice("memory:".length));
        return (
          <button
            type="button"
            className="memory-wikilink"
            onClick={() => openMemoryTarget(target)}
          >
            {children}
          </button>
        );
      }
      return (
        <a href={url} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [notes]);

  function selectNote(id: string) {
    setCreating(false);
    setSelectedId(id);
    setMode((current) => (current === "edit" ? "preview" : current));
    setMobileMode("note");
    setDeleteConfirmId(null);
    setDeleteError(null);
  }

  function openMemoryTarget(target: string) {
    const note = findByTitle(notes, target);
    if (note) {
      selectNote(note.id);
      return;
    }
    setSearch(target);
    setMobileMode("notes");
  }

  function startNewNote() {
    setCreating(true);
    setSelectedId(null);
    setDraft(EMPTY_DRAFT);
    setMode("edit");
    setMobileMode("note");
    setSaveError(null);
    setDeleteConfirmId(null);
    setDeleteError(null);
  }

  async function saveDraft() {
    const payload = payloadFromDraft(draft);
    if (!payload.title) {
      setSaveError("Title is required.");
      return;
    }

    setSaving(true);
    setSaveError(null);
    try {
      const url = creating || !selected ? "/api/memory" : `/api/memory/${encodeURIComponent(selected.id)}`;
      const method = creating || !selected ? "POST" : "PATCH";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`Save failed: ${res.status}`);
      let saved = normalizeMemoryNote({ ...selected, ...payload }, 0);
      try {
        const data = await res.json();
        saved = normalizeMemoryNote(
          isRecord(data) ? (data.memory ?? data.note ?? data.item ?? data.data ?? data) : data,
          0,
        ) ?? saved;
      } catch {}
      if (!saved) throw new Error("Save response did not include a memory note.");

      setNotes((current) => {
        const exists = current.some((note) => note.id === saved.id);
        return exists
          ? current.map((note) => (note.id === saved.id ? saved : note))
          : [saved, ...current];
      });
      setSelectedId(saved.id);
      setCreating(false);
      setMode("preview");
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Unable to save memory.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteSelectedNote() {
    if (!selected) return;
    if (deleteConfirmId !== selected.id) {
      setDeleteConfirmId(selected.id);
      setDeleteError(null);
      return;
    }

    const deletedId = selected.id;
    setDeletingId(deletedId);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/memory/${encodeURIComponent(deletedId)}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Delete failed: ${res.status}`);

      setNotes((current) => {
        const next = current.filter((note) => note.id !== deletedId);
        setSelectedId(next[0]?.id ?? null);
        return next;
      });
      setMode("preview");
      setDeleteConfirmId(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Unable to delete memory.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="memory-workspace" data-mobile-mode={mobileMode} data-mode={mode}>
      <div className="memory-mobile-tabs" aria-label="Memory panes">
        <button type="button" className={mobileMode === "notes" ? "active" : ""} onClick={() => setMobileMode("notes")}>Notes</button>
        <button type="button" className={mobileMode === "note" ? "active" : ""} onClick={() => setMobileMode("note")}>Note</button>
        <button type="button" className={mobileMode === "context" ? "active" : ""} onClick={() => setMobileMode("context")}>Context</button>
      </div>

      <aside className="memory-pane memory-pane-left">
        <div className="memory-pane-header">
          <div>
            <h1>Memory</h1>
            <p>{loading ? "Loading notes" : `${notes.length}${hasMore ? "+" : ""} notes indexed`}</p>
          </div>
          <Button type="button" size="sm" onClick={startNewNote}>New</Button>
        </div>

        <div className="memory-search">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search memory..."
            aria-label="Search memory"
          />
          <div className="memory-filter-grid">
            <Select value={scopeFilter} onChange={(event) => setScopeFilter(event.target.value)} aria-label="Filter by scope">
              {scopes.map((scope) => <option key={scope} value={scope}>{scope === "all" ? "All scopes" : scope}</option>)}
            </Select>
            <Select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)} aria-label="Filter by type">
              {types.map((type) => <option key={type} value={type}>{type === "all" ? "All types" : type}</option>)}
            </Select>
          </div>
        </div>

        <div className="memory-list">
          {error && <div className="memory-alert">{error}</div>}
          {!error && !loading && grouped.length === 0 && (
            <EmptyState title="No memory yet" body="Create a note or change filters to see saved memory." />
          )}
          {grouped.map((group) => (
            <section key={group.key} className="memory-group">
              <div className="memory-group-title">
                <span>{group.label}</span>
                <span>{group.notes.length}</span>
              </div>
              {group.notes.map((note) => {
                const tagSummary = noteTagSummary(note.tags);
                return (
                  <button
                    key={note.id}
                    type="button"
                    className={`memory-note-row ${selected?.id === note.id && !creating ? "active" : ""}`}
                    onClick={() => selectNote(note.id)}
                  >
                    <span className="memory-note-row-title">{note.title}</span>
                    <span className="memory-note-row-preview">{notePreview(note)}</span>
                    <span className="memory-note-row-meta">
                      <span className="memory-note-row-date">{formatDate(note.updatedAt ?? note.createdAt)}</span>
                      <span className="memory-note-row-tags">
                        {tagSummary.visible.map((tag) => (
                          <Chip key={tag.value} className="memory-note-chip" title={tag.value}>{tag.label}</Chip>
                        ))}
                        {tagSummary.hiddenCount > 0 && (
                          <Chip className="memory-note-chip memory-note-chip-count" title={note.tags.join(", ")}>
                            {tagSummary.visible.length > 0 ? `+${tagSummary.hiddenCount}` : `${tagSummary.hiddenCount} tags`}
                          </Chip>
                        )}
                      </span>
                    </span>
                  </button>
                );
              })}
            </section>
          ))}
          {!error && grouped.length > 0 && hasMore && (
            <div className="memory-list-footer">
              <Button type="button" size="sm" disabled={loadingMore} onClick={loadMore}>
                {loadingMore ? "Loading..." : "Load more"}
              </Button>
            </div>
          )}
        </div>
      </aside>

      <main className="memory-pane memory-pane-center">
        <div className="memory-editor-header">
          <div className="min-w-0">
            <div className="memory-kicker">{creating ? "New memory" : selected?.scope ?? "Memory"}</div>
            <h2>{creating ? draft.title || "Untitled note" : selected?.title ?? "Select a note"}</h2>
          </div>
          <div className="memory-mode-switch">
            <button type="button" className={mode === "preview" ? "active" : ""} onClick={() => setMode("preview")}>Preview</button>
            <button type="button" className={mode === "edit" ? "active" : ""} onClick={() => setMode("edit")}>Edit</button>
            <button type="button" className={mode === "graph" ? "active" : ""} onClick={() => setMode("graph")}>Graph</button>
          </div>
        </div>

        {mode === "graph" ? (
          <MemoryGraph
            graph={graph}
            selectedId={selected?.id ?? null}
            loading={graphLoading}
            onSelect={(id) => {
              const note = notes.find((item) => item.id === id);
              if (note) selectNote(note.id);
            }}
          />
        ) : mode === "edit" ? (
          <div className="memory-editor">
            <div className="memory-field-grid">
              <label>
                <span>Title</span>
                <Input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
              </label>
              <label>
                <span>Type</span>
                <Select value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value })}>
                  {MEMORY_TYPES.map((type) => <option key={type} value={type}>{type}</option>)}
                </Select>
              </label>
              <label>
                <span>Scope</span>
                <Select value={draft.scope} onChange={(event) => setDraft({ ...draft, scope: event.target.value })}>
                  <option value="global">Global</option>
                  <option value="project">Project</option>
                </Select>
              </label>
              <label>
                <span>CWD</span>
                <Input
                  value={draft.cwd}
                  onChange={(event) => setDraft({ ...draft, cwd: event.target.value })}
                  placeholder="/path/to/project"
                  disabled={draft.scope !== "project"}
                />
              </label>
              <label>
                <span>Tags</span>
                <Input value={draft.tagsText} onChange={(event) => setDraft({ ...draft, tagsText: event.target.value })} placeholder="tag, another-tag" />
              </label>
              <label>
                <span>Aliases</span>
                <Input value={draft.aliasesText} onChange={(event) => setDraft({ ...draft, aliasesText: event.target.value })} placeholder="alias, alternate title" />
              </label>
            </div>
            <label className="memory-content-field">
              <span>Content</span>
              <Textarea
                value={draft.content}
                onChange={(event) => setDraft({ ...draft, content: event.target.value })}
                placeholder="Write markdown. Use [[wikilinks]] to connect notes."
              />
            </label>
            <div className="memory-editor-actions">
              {saveError && <span className="memory-save-error">{saveError}</span>}
              <Button type="button" variant="ghost" onClick={() => {
                setCreating(false);
                setDraft(draftFromNote(selected));
                setMode("preview");
              }}>
                Cancel
              </Button>
              <Button type="button" variant="primary" disabled={saving} onClick={saveDraft}>
                {saving ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
        ) : selected ? (
          <article className="memory-preview prose-dashboard">
            <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS} components={markdownComponents}>
              {preprocessWikilinks(selected.content || "_No content yet._")}
            </ReactMarkdown>
          </article>
        ) : (
          <EmptyState title="Select a memory note" body="Choose a note from the left pane or create a new one." />
        )}
      </main>

      <aside className="memory-pane memory-pane-right">
        <MemorySettingsPanel compact className="memory-inspector-settings" />
        {selected && !creating ? (
          <MemoryInspector
            note={selected}
            backlinks={backlinks}
            related={related}
            deleteConfirming={deleteConfirmId === selected.id}
            deleting={deletingId === selected.id}
            deleteError={deleteError}
            onSelect={(id) => {
              const note = notes.find((item) => item.id === id);
              if (note) selectNote(note.id);
            }}
            onDelete={deleteSelectedNote}
            onCancelDelete={() => {
              setDeleteConfirmId(null);
              setDeleteError(null);
            }}
          />
        ) : (
          <EmptyState title="No properties" body="Metadata, backlinks, source sessions, and related notes appear here." />
        )}
      </aside>
    </div>
  );
}

function MemoryInspector({
  note,
  backlinks,
  related,
  onSelect,
  onDelete,
  onCancelDelete,
  deleteConfirming,
  deleting,
  deleteError,
}: {
  note: MemoryNote;
  backlinks: MemoryRef[];
  related: MemoryRef[];
  onSelect: (id: string) => void;
  onDelete: () => void;
  onCancelDelete: () => void;
  deleteConfirming: boolean;
  deleting: boolean;
  deleteError: string | null;
}) {
  return (
    <div className="memory-inspector">
      <section>
        <h3>Properties</h3>
        <dl>
          <InfoRow label="Type"><Chip>{note.type}</Chip></InfoRow>
          <InfoRow label="Scope">{note.scope}</InfoRow>
          <InfoRow label="Updated">{formatDate(note.updatedAt ?? note.createdAt)}</InfoRow>
          {note.cwd && <InfoRow label="CWD"><span className="mono">{note.cwd}</span></InfoRow>}
          {note.aliases.length > 0 && (
            <InfoRow label="Aliases">
              <span className="memory-chip-stack">{note.aliases.map((alias) => <Chip key={alias}>{alias}</Chip>)}</span>
            </InfoRow>
          )}
          {note.tags.length > 0 && (
            <InfoRow label="Tags">
              <span className="memory-chip-stack">{note.tags.map((tag) => <Chip key={tag}>{tag}</Chip>)}</span>
            </InfoRow>
          )}
        </dl>
      </section>

      <MemoryRefList title="Backlinks" refs={backlinks} empty="No incoming wikilinks yet." onSelect={onSelect} />

      <section>
        <h3>Source Sessions</h3>
        {note.sourceSessions.length === 0 ? (
          <p className="memory-muted">No source sessions recorded.</p>
        ) : (
          <div className="memory-ref-list">
            {note.sourceSessions.map((session) => (
              session.href ? (
                <Link key={session.id} href={session.href} className="memory-ref-row">
                  <span>{session.title}</span>
                  <small>{session.at ? formatDate(session.at) : session.id}</small>
                </Link>
              ) : (
                <div key={session.id} className="memory-ref-row">
                  <span>{session.title}</span>
                  <small>{session.at ? formatDate(session.at) : session.id}</small>
                </div>
              )
            ))}
          </div>
        )}
      </section>

      <MemoryRefList title="Related Notes" refs={related} empty="No related notes found." onSelect={onSelect} />

      <section>
        <h3>Actions</h3>
        {deleteError && <p className="memory-action-error">{deleteError}</p>}
        {deleteConfirming ? (
          <div className="memory-action-row">
            <Button type="button" variant="ghost" size="sm" disabled={deleting} onClick={onCancelDelete}>
              Cancel
            </Button>
            <Button type="button" variant="danger" size="sm" disabled={deleting} onClick={onDelete}>
              {deleting ? "Deleting..." : "Confirm delete"}
            </Button>
          </div>
        ) : (
          <Button type="button" variant="danger" size="sm" disabled={deleting} onClick={onDelete}>
            Delete
          </Button>
        )}
      </section>
    </div>
  );
}

function MemoryRefList({
  title,
  refs,
  empty,
  onSelect,
}: {
  title: string;
  refs: MemoryRef[];
  empty: string;
  onSelect: (id: string) => void;
}) {
  return (
    <section>
      <h3>{title}</h3>
      {refs.length === 0 ? (
        <p className="memory-muted">{empty}</p>
      ) : (
        <div className="memory-ref-list">
          {refs.map((ref) => (
            <button key={`${title}-${ref.id}`} type="button" className="memory-ref-row" onClick={() => onSelect(ref.id)}>
              <span>{ref.title}</span>
              <small>{[ref.scope, ref.type].filter(Boolean).join(" / ")}</small>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function MemoryGraph({
  graph,
  selectedId,
  loading,
  onSelect,
}: {
  graph: GraphData;
  selectedId: string | null;
  loading: boolean;
  onSelect: (id: string) => void;
}) {
  const width = 900;
  const height = 620;
  const graphKey = useMemo(() => graphSignature(graph), [graph]);
  const world = useMemo(() => graphWorldSize(graph.nodes.length), [graph.nodes.length]);
  const nodes = useMemo(() => layoutNodes(graph.nodes, graph.edges, world.width, world.height), [graph.edges, graph.nodes, world.height, world.width]);
  const nodeMap = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const adjacency = useMemo(() => graphAdjacency(nodes, graph.edges), [graph.edges, nodes]);
  const selectedNode = selectedId ? nodeMap.get(selectedId) ?? null : null;
  const [viewport, setViewport] = useState<GraphViewport>(() => fitGraphViewport(world.width, world.height, width, height));
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [listQuery, setListQuery] = useState("");
  const svgRef = useRef<SVGSVGElement | null>(null);
  const panRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    viewport: GraphViewport;
    moved: boolean;
  } | null>(null);
  const panMovedRef = useRef(false);

  useEffect(() => {
    setViewport(selectedNode
      ? centerGraphViewport(selectedNode.x, selectedNode.y, width, height, 1.35)
      : fitGraphViewport(world.width, world.height, width, height));
  }, [graphKey, selectedNode, world.height, world.width]);

  const visibleRect = useMemo(() => viewportRect(viewport, width, height), [viewport]);
  const focusPoint = selectedNode ?? {
    x: visibleRect.x + visibleRect.width / 2,
    y: visibleRect.y + visibleRect.height / 2,
  };
  const hoveredNode = hoveredId ? nodeMap.get(hoveredId) ?? null : null;
  const visibleNodes = useMemo(
    () => nodes.filter((node) => rectContainsNode(visibleRect, node, 96 / viewport.k)),
    [nodes, viewport.k, visibleRect],
  );
  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const visibleEdges = useMemo(
    () => graph.edges.filter((edge) => visibleNodeIds.has(edge.source) || visibleNodeIds.has(edge.target)),
    [graph.edges, visibleNodeIds],
  );
  const labelIds = useMemo(
    () => foveatedLabelIds(visibleNodes, focusPoint, adjacency, selectedId, hoveredId, viewport.k),
    [adjacency, focusPoint, hoveredId, selectedId, viewport.k, visibleNodes],
  );
  const filteredListNodes = useMemo(
    () => filterGraphList(nodes, adjacency, listQuery, selectedId, hoveredId, focusPoint),
    [adjacency, focusPoint, hoveredId, listQuery, nodes, selectedId],
  );
  const selectedNeighborIds = selectedId ? adjacency.get(selectedId) ?? new Set<string>() : new Set<string>();

  if (!nodes.length) {
    return <EmptyState title="No graph data" body="Memory graph links appear after notes are connected." />;
  }

  function zoomAt(clientX: number, clientY: number, delta: number) {
    const rect = svgPoint(clientX, clientY);
    setViewport((current) => {
      const worldX = (rect.x - current.x) / current.k;
      const worldY = (rect.y - current.y) / current.k;
      const nextK = clamp(current.k * delta, 0.26, 2.2);
      return {
        x: rect.x - worldX * nextK,
        y: rect.y - worldY * nextK,
        k: nextK,
      };
    });
  }

  function svgPoint(clientX: number, clientY: number) {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: width / 2, y: height / 2 };
    return {
      x: ((clientX - rect.left) / rect.width) * width,
      y: ((clientY - rect.top) / rect.height) * height,
    };
  }

  function focusSelection() {
    if (!selectedNode) {
      setViewport(fitGraphViewport(world.width, world.height, width, height));
      return;
    }
    setViewport(centerGraphViewport(selectedNode.x, selectedNode.y, width, height, 1.35));
  }

  return (
    <div className="memory-graph-wrap">
      {loading && <div className="memory-graph-loading">Loading graph...</div>}
      <div className="memory-graph-stage">
        <div className="memory-graph-toolbar">
          <button type="button" onClick={() => setViewport(fitGraphViewport(world.width, world.height, width, height))}>
            Fit
          </button>
          <button type="button" onClick={focusSelection} disabled={!selectedNode}>
            Focus
          </button>
          <button type="button" aria-label="Zoom out" onClick={() => setViewport((current) => ({ ...current, k: clamp(current.k * 0.82, 0.26, 2.2) }))}>
            -
          </button>
          <input
            type="range"
            min="0.26"
            max="2.2"
            step="0.02"
            value={viewport.k}
            aria-label="Graph zoom"
            onChange={(event) => {
              const nextK = Number(event.target.value);
              setViewport((current) => centerPreservingZoom(current, nextK, width, height));
            }}
          />
          <button type="button" aria-label="Zoom in" onClick={() => setViewport((current) => ({ ...current, k: clamp(current.k * 1.18, 0.26, 2.2) }))}>
            +
          </button>
          <span>{visibleNodes.length} / {nodes.length} notes</span>
        </div>
        <svg
          ref={svgRef}
          className="memory-graph"
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="Memory graph"
          onWheel={(event) => {
            event.preventDefault();
            zoomAt(event.clientX, event.clientY, event.deltaY > 0 ? 0.88 : 1.14);
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            panRef.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              viewport,
              moved: false,
            };
            panMovedRef.current = false;
          }}
          onPointerMove={(event) => {
            const pan = panRef.current;
            if (!pan || pan.pointerId !== event.pointerId) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const dx = ((event.clientX - pan.startX) / rect.width) * width;
            const dy = ((event.clientY - pan.startY) / rect.height) * height;
            if (Math.abs(dx) + Math.abs(dy) > 3) {
              pan.moved = true;
              panMovedRef.current = true;
            }
            setViewport({ ...pan.viewport, x: pan.viewport.x + dx, y: pan.viewport.y + dy });
          }}
          onPointerUp={(event) => {
            if (panRef.current?.pointerId === event.pointerId) {
              event.currentTarget.releasePointerCapture(event.pointerId);
              panRef.current = null;
            }
          }}
          onPointerCancel={(event) => {
            if (panRef.current?.pointerId === event.pointerId) panRef.current = null;
          }}
        >
          <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.k})`}>
            <g className="memory-graph-edges">
              {visibleEdges.map((edge, index) => {
                const source = nodeMap.get(edge.source);
                const target = nodeMap.get(edge.target);
                if (!source || !target) return null;
                const selectedEdge = Boolean(selectedId && (edge.source === selectedId || edge.target === selectedId));
                return (
                  <line
                    key={`${edge.source}-${edge.target}-${index}`}
                    className={selectedEdge ? "selected" : ""}
                    x1={source.x}
                    y1={source.y}
                    x2={target.x}
                    y2={target.y}
                  />
                );
              })}
            </g>
            <g className="memory-graph-nodes">
              {visibleNodes.map((node) => {
                const labelLines = graphLabelLines(node);
                const isSelected = node.id === selectedId;
                const isHovered = node.id === hoveredId;
                const isNeighbor = selectedNeighborIds.has(node.id);
                const showLabel = labelIds.has(node.id);
                const labelFontSize = clamp(11 / viewport.k, 5.5, 12);
                return (
                  <g
                    key={node.id}
                    className={[
                      isSelected ? "selected" : "",
                      isHovered ? "hovered" : "",
                      isNeighbor ? "neighbor" : "",
                      showLabel ? "labeled" : "dim-label",
                    ].filter(Boolean).join(" ")}
                    transform={`translate(${node.x} ${node.y})`}
                    role="button"
                    tabIndex={0}
                    onMouseEnter={() => setHoveredId(node.id)}
                    onMouseLeave={() => setHoveredId((current) => (current === node.id ? null : current))}
                    onClick={() => {
                      if (panMovedRef.current) return;
                      onSelect(node.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") onSelect(node.id);
                    }}
                    aria-label={`Open ${node.title}`}
                  >
                    <title>{node.title}</title>
                    <circle className={`memory-graph-node-${memoryTypeClass(node.type)}`} r={isSelected ? node.radius + 5 : node.radius} />
                    {showLabel && (
                      <text
                        y={node.radius + 16 / viewport.k}
                        style={{
                          fontSize: `${labelFontSize}px`,
                          fontWeight: isSelected || isHovered ? 680 : 560,
                        }}
                      >
                        {labelLines.map((line, index) => (
                          <tspan key={`${node.id}-label-${index}`} x={0} dy={index === 0 ? 0 : 13 / viewport.k}>
                            {line}
                          </tspan>
                        ))}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          </g>
          {hoveredNode && (
            <g className="memory-graph-focus-ring" transform={`translate(${viewport.x + hoveredNode.x * viewport.k} ${viewport.y + hoveredNode.y * viewport.k})`}>
              <circle r={Math.max(34, 52 * viewport.k)} />
            </g>
          )}
        </svg>
      </div>
      <aside className="memory-graph-data" aria-label="Memory graph data">
        <div className="memory-graph-data-head">
          <div>
            <h3>Graph Data</h3>
            <p>{graph.edges.length} relationships across {nodes.length} notes</p>
          </div>
        </div>
        <Input
          value={listQuery}
          onChange={(event) => setListQuery(event.target.value)}
          placeholder="Filter nodes..."
          aria-label="Filter graph nodes"
        />
        <div className="memory-graph-data-list">
          {filteredListNodes.map((node) => {
            const isSelected = node.id === selectedId;
            return (
              <button
                key={`graph-list-${node.id}`}
                type="button"
                className={`memory-graph-data-row ${isSelected ? "active" : ""}`}
                onMouseEnter={() => setHoveredId(node.id)}
                onMouseLeave={() => setHoveredId((current) => (current === node.id ? null : current))}
                onClick={() => onSelect(node.id)}
              >
                <span className={`memory-graph-data-dot memory-graph-node-${memoryTypeClass(node.type)}`} />
                <span className="memory-graph-data-main">
                  <span>{node.title}</span>
                  <small>{[node.scope, node.type].filter(Boolean).join(" / ") || "Memory"}</small>
                </span>
                <span className="memory-graph-degree">{node.degree}</span>
              </button>
            );
          })}
        </div>
      </aside>
    </div>
  );
}

function graphLabelLines(node: Pick<GraphNode, "title" | "type">): string[] {
  const title = node.title.replace(/\s+/g, " ").trim();
  const sessionMatch = title.match(/^Session ([a-f0-9-]{36}) Turn ([a-f0-9-]{36})$/i);
  if (sessionMatch) {
    return [`Session ${sessionMatch[1].slice(0, 8)}`, `Turn ${sessionMatch[2].slice(0, 8)}`];
  }

  const commandMatch = title.match(/^\/mcp\s+(\S+)(?:\s+(.+))?$/i);
  if (commandMatch) {
    const command = `/mcp ${commandMatch[1]}`;
    const tail = commandMatch[2] ? truncateGraphLabel(commandMatch[2], 22) : "";
    return tail ? [command, tail] : [command];
  }

  return wrapGraphLabel(title);
}

function wrapGraphLabel(value: string): string[] {
  if (value.length <= 24) return [value];
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length <= 1) return [truncateGraphLabel(value, 24)];

  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length <= 24) {
      current = next;
      continue;
    }
    if (current) lines.push(current);
    current = word;
    if (lines.length === 1) break;
  }

  if (current && lines.length < 2) lines.push(current);
  if (!lines.length) return [truncateGraphLabel(value, 24)];
  if (lines.length === 1) return [truncateGraphLabel(lines[0], 24)];
  return [lines[0], truncateGraphLabel(lines[1], 24)];
}

function truncateGraphLabel(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function graphSignature(graph: GraphData): string {
  return `${graph.nodes.map((node) => node.id).join("|")}::${graph.edges.map((edge) => `${edge.source}>${edge.target}`).join("|")}`;
}

function graphWorldSize(nodeCount: number) {
  const scale = Math.sqrt(Math.max(1, nodeCount));
  return {
    width: Math.round(clamp(620 + scale * 180, 980, 2800)),
    height: Math.round(clamp(440 + scale * 135, 700, 2000)),
  };
}

function graphAdjacency(nodes: LayoutNode[], edges: GraphEdge[]): Map<string, Set<string>> {
  const adjacency = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of edges) {
    if (!adjacency.has(edge.source) || !adjacency.has(edge.target)) continue;
    adjacency.get(edge.source)!.add(edge.target);
    adjacency.get(edge.target)!.add(edge.source);
  }
  return adjacency;
}

function layoutNodes(nodes: GraphNode[], edges: GraphEdge[], width: number, height: number): LayoutNode[] {
  const indexById = new Map(nodes.map((node, index) => [node.id, index]));
  const degrees = new Map(nodes.map((node) => [node.id, 0]));
  const linkedEdges = edges
    .map((edge) => {
      const source = indexById.get(edge.source);
      const target = indexById.get(edge.target);
      if (source === undefined || target === undefined || source === target) return null;
      degrees.set(edge.source, (degrees.get(edge.source) ?? 0) + 1);
      degrees.set(edge.target, (degrees.get(edge.target) ?? 0) + 1);
      return { source, target };
    })
    .filter((edge): edge is { source: number; target: number } => Boolean(edge));
  const components = connectedComponents(nodes, linkedEdges);
  const anchors = componentAnchors(components.count, width, height);
  const centerX = width / 2;
  const centerY = height / 2;

  const working = nodes.map((node, index) => {
    const component = components.byIndex[index] ?? 0;
    const anchor = anchors[component] ?? { x: centerX, y: centerY };
    const hash = hashString(node.id || node.title || String(index));
    const angle = ((hash % 360) / 360) * Math.PI * 2;
    const spread = 52 + ((hash >>> 8) % 96);
    const x = typeof node.x === "number" ? node.x : anchor.x + Math.cos(angle) * spread;
    const y = typeof node.y === "number" ? node.y : anchor.y + Math.sin(angle) * spread;
    const degree = degrees.get(node.id) ?? 0;
    return {
      ...node,
      x: clamp(x, 48, width - 48),
      y: clamp(y, 48, height - 48),
      vx: 0,
      vy: 0,
      degree,
      component,
      radius: clamp(8 + Math.sqrt(degree + 1) * 2.2, 10, 19),
    };
  });

  const iterations = nodes.length > 220 ? 110 : 170;
  for (let tick = 0; tick < iterations; tick += 1) {
    const alpha = 1 - tick / iterations;
    for (let i = 0; i < working.length; i += 1) {
      for (let j = i + 1; j < working.length; j += 1) {
        const a = working[i]!;
        const b = working[j]!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distanceSq = dx * dx + dy * dy;
        if (distanceSq < 0.01) {
          dx = 0.1 + (hashString(`${a.id}:${b.id}`) % 17) / 17;
          dy = 0.1 + (hashString(`${b.id}:${a.id}`) % 19) / 19;
          distanceSq = dx * dx + dy * dy;
        }
        const distance = Math.sqrt(distanceSq);
        const minDistance = a.radius + b.radius + 18;
        const sameComponent = a.component === b.component;
        const repulsion = (sameComponent ? 680 : 1080) * alpha / distanceSq;
        const pushX = (dx / distance) * repulsion;
        const pushY = (dy / distance) * repulsion;
        a.vx -= pushX;
        a.vy -= pushY;
        b.vx += pushX;
        b.vy += pushY;

        if (distance < minDistance) {
          const overlap = ((minDistance - distance) / distance) * 0.08;
          a.vx -= dx * overlap;
          a.vy -= dy * overlap;
          b.vx += dx * overlap;
          b.vy += dy * overlap;
        }
      }
    }

    for (const edge of linkedEdges) {
      const source = working[edge.source]!;
      const target = working[edge.target]!;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const desired = 94 + Math.min(source.degree + target.degree, 10) * 8;
      const pull = (distance - desired) * 0.018 * alpha;
      const pullX = (dx / distance) * pull;
      const pullY = (dy / distance) * pull;
      source.vx += pullX;
      source.vy += pullY;
      target.vx -= pullX;
      target.vy -= pullY;
    }

    for (const node of working) {
      const anchor = anchors[node.component] ?? { x: centerX, y: centerY };
      node.vx += (anchor.x - node.x) * 0.004 * alpha;
      node.vy += (anchor.y - node.y) * 0.004 * alpha;
      node.vx += (centerX - node.x) * 0.0008 * alpha;
      node.vy += (centerY - node.y) * 0.0008 * alpha;
      node.x = clamp(node.x + node.vx, 38, width - 38);
      node.y = clamp(node.y + node.vy, 38, height - 38);
      node.vx *= 0.78;
      node.vy *= 0.78;
    }
  }

  return working.map(({ vx: _vx, vy: _vy, ...node }) => node);
}

function connectedComponents(nodes: GraphNode[], edges: Array<{ source: number; target: number }>) {
  const neighbors = nodes.map(() => [] as number[]);
  for (const edge of edges) {
    neighbors[edge.source]!.push(edge.target);
    neighbors[edge.target]!.push(edge.source);
  }
  const byIndex = new Array<number>(nodes.length).fill(-1);
  let count = 0;
  for (let index = 0; index < nodes.length; index += 1) {
    if (byIndex[index] !== -1) continue;
    const stack = [index];
    byIndex[index] = count;
    while (stack.length) {
      const current = stack.pop()!;
      for (const next of neighbors[current] ?? []) {
        if (byIndex[next] !== -1) continue;
        byIndex[next] = count;
        stack.push(next);
      }
    }
    count += 1;
  }
  return { byIndex, count: Math.max(1, count) };
}

function componentAnchors(count: number, width: number, height: number) {
  if (count <= 1) return [{ x: width / 2, y: height / 2 }];
  const columns = Math.ceil(Math.sqrt(count * (width / height)));
  const rows = Math.ceil(count / columns);
  const cellW = width / columns;
  const cellH = height / rows;
  return Array.from({ length: count }, (_value, index) => ({
    x: cellW * (index % columns) + cellW / 2,
    y: cellH * Math.floor(index / columns) + cellH / 2,
  }));
}

function viewportRect(viewport: GraphViewport, width: number, height: number) {
  return {
    x: -viewport.x / viewport.k,
    y: -viewport.y / viewport.k,
    width: width / viewport.k,
    height: height / viewport.k,
  };
}

function rectContainsNode(
  rect: { x: number; y: number; width: number; height: number },
  node: Pick<LayoutNode, "x" | "y" | "radius">,
  margin: number,
) {
  return (
    node.x >= rect.x - margin &&
    node.x <= rect.x + rect.width + margin &&
    node.y >= rect.y - margin &&
    node.y <= rect.y + rect.height + margin
  );
}

function fitGraphViewport(worldWidth: number, worldHeight: number, width: number, height: number): GraphViewport {
  const k = clamp(Math.min((width - 64) / worldWidth, (height - 64) / worldHeight), 0.26, 1.2);
  return {
    x: (width - worldWidth * k) / 2,
    y: (height - worldHeight * k) / 2,
    k,
  };
}

function centerGraphViewport(x: number, y: number, width: number, height: number, k: number): GraphViewport {
  return {
    x: width / 2 - x * k,
    y: height / 2 - y * k,
    k: clamp(k, 0.26, 2.2),
  };
}

function centerPreservingZoom(viewport: GraphViewport, nextK: number, width: number, height: number): GraphViewport {
  const worldX = (width / 2 - viewport.x) / viewport.k;
  const worldY = (height / 2 - viewport.y) / viewport.k;
  const k = clamp(nextK, 0.26, 2.2);
  return {
    x: width / 2 - worldX * k,
    y: height / 2 - worldY * k,
    k,
  };
}

function foveatedLabelIds(
  visibleNodes: LayoutNode[],
  focusPoint: Pick<LayoutNode, "x" | "y">,
  adjacency: Map<string, Set<string>>,
  selectedId: string | null,
  hoveredId: string | null,
  zoom: number,
) {
  const selectedNeighbors = selectedId ? adjacency.get(selectedId) ?? new Set<string>() : new Set<string>();
  const fovea = 118 / Math.max(0.65, zoom);
  const limit = Math.max(7, Math.min(18, Math.round(8 + zoom * 4)));
  const ranked = visibleNodes
    .map((node) => {
      const distance = Math.hypot(node.x - focusPoint.x, node.y - focusPoint.y);
      const priority =
        node.id === selectedId ? -10000 :
        node.id === hoveredId ? -9000 :
        selectedNeighbors.has(node.id) ? -5000 :
        distance < fovea ? -1200 :
        0;
      return { node, score: priority + distance - node.degree * 9 };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, limit);
  return new Set(ranked.map((item) => item.node.id));
}

function filterGraphList(
  nodes: LayoutNode[],
  adjacency: Map<string, Set<string>>,
  query: string,
  selectedId: string | null,
  hoveredId: string | null,
  focusPoint: Pick<LayoutNode, "x" | "y">,
) {
  const normalizedQuery = query.trim().toLowerCase();
  const selectedNeighbors = selectedId ? adjacency.get(selectedId) ?? new Set<string>() : new Set<string>();
  return nodes
    .filter((node) => {
      if (!normalizedQuery) return true;
      return [node.title, node.type, node.scope].filter(Boolean).some((value) => value!.toLowerCase().includes(normalizedQuery));
    })
    .map((node) => {
      const priority =
        node.id === selectedId ? -10000 :
        node.id === hoveredId ? -9000 :
        selectedNeighbors.has(node.id) ? -5000 :
        0;
      const distance = Math.hypot(node.x - focusPoint.x, node.y - focusPoint.y);
      return { node, score: priority - node.degree * 20 + distance * 0.05 };
    })
    .sort((a, b) => a.score - b.score || a.node.title.localeCompare(b.node.title))
    .map((item) => item.node);
}

function memoryTypeClass(type?: string): string {
  return (type ?? "memory").toLowerCase().replace(/[^a-z0-9]+/g, "-") || "memory";
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
