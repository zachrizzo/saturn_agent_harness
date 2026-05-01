import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { memoryRoot } from "../paths";
import { readAppSettings, type AppSettings, type MemoryRetrievalMode } from "../settings";
import {
  enqueueMemoryEmbeddingRefresh,
  curateCapturedMemory,
  getSemanticGraphEdges,
  processMemoryEmbeddingQueue,
  semanticSearchMemory,
  type SemanticMemoryResult,
} from "./embeddings";

export const MEMORY_TYPES = [
  "Entities",
  "Concepts",
  "Projects",
  "Decisions",
  "Troubleshooting",
  "Sessions",
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

export type MemoryScope =
  | { kind: "global" }
  | { kind: "project"; projectKey: string; projectPath?: string | null; projectName?: string | null };

export type MemoryFrontmatterValue = string | string[];

export interface MemoryNote {
  id: string;
  title: string;
  type: MemoryType;
  scope: MemoryScope;
  path: string;
  content: string;
  tags: string[];
  aliases: string[];
  links: string[];
  backlinks: string[];
  created_at: string;
  updated_at: string;
  metadata: Record<string, MemoryFrontmatterValue>;
}

export interface MemoryIndexEntry {
  id: string;
  title: string;
  type: MemoryType;
  scope: MemoryScope;
  path: string;
  tags: string[];
  aliases: string[];
  links: string[];
  wikilinks: string[];
  backlinks: string[];
  created_at: string;
  updated_at: string;
  excerpt: string;
}

export interface MemorySearchResult {
  note: MemoryIndexEntry;
  score: number;
  snippet: string;
  reasons: string[];
  retrieval?: {
    keywordScore?: number;
    semanticScore?: number;
    graphScore?: number;
    recencyScore?: number;
    chunkId?: string;
    mode?: MemoryRetrievalMode;
  };
}

export interface MemoryGraph {
  nodes: MemoryIndexEntry[];
  edges: Array<{ source: string; target: string; label?: string }>;
}

export interface MemoryCaptureInput {
  session_id?: string | null;
  sessionId?: string | null;
  turn_id?: string | null;
  turnId?: string | null;
  cwd?: string | null;
  projectPath?: string | null;
  projectName?: string | null;
  success?: boolean | null;
  timestamp?: string | null;
  text?: string | null;
  prompt?: string | null;
  response?: string | null;
  userMessage?: string | null;
  finalText?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  messages?: Array<{ role?: string | null; content?: string | null }> | null;
  session?: unknown;
  meta?: unknown;
  turn?: unknown;
  events?: unknown;
  stderr?: unknown;
  tags?: string[] | null;
  metadata?: Record<string, unknown> | null;
}

export interface MemoryCaptureSummary {
  ok: boolean;
  captured: number;
  skipped: boolean;
  notes: Array<{ id: string; title: string; type: MemoryType }>;
  errors: string[];
  curator?: { skipped: boolean; applied: number; errors: string[] };
}

interface UpsertMemoryNoteInput {
  id?: string;
  title?: string;
  type?: MemoryType;
  scope?: MemoryScopeFilter;
  cwd?: string | null;
  projectScope?: MemoryScope;
  content?: string;
  tags?: string[];
  aliases?: string[];
  metadata?: Record<string, MemoryFrontmatterValue | null | undefined>;
  created_at?: string;
  updated_at?: string;
}

type MemoryScopeFilter = MemoryScope | "all" | "global" | "project";

interface MemoryQueryOptions {
  q?: string;
  query?: string;
  message?: string;
  scope?: MemoryScopeFilter;
  cwd?: string | null;
  projectScope?: MemoryScope;
  type?: MemoryType;
  types?: MemoryType[];
  tag?: string;
  tags?: string[];
  limit?: number;
  includeGlobal?: boolean;
  retrievalMode?: MemoryRetrievalMode;
}

interface MemoryIndexFile {
  generated_at: string;
  notes: MemoryIndexEntry[];
}

const FRONTMATTER_DELIMITER = "---";
const INDEX_FILENAME = "index.json";
const MAX_SNIPPET_LENGTH = 280;
const SECRET_LINE_RE = /\b(token|password|secret|key)\b/i;

const KNOWN_FRONTMATTER_KEYS = new Set([
  "id",
  "title",
  "type",
  "scope",
  "scope_kind",
  "project_key",
  "project_path",
  "project_name",
  "tags",
  "aliases",
  "created_at",
  "updated_at",
]);

function vaultRoot(): string {
  return path.join(memoryRoot(), "vault");
}

function indexPath(): string {
  return path.join(memoryRoot(), INDEX_FILENAME);
}

function isENOENT(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === "string" && (MEMORY_TYPES as readonly string[]).includes(value);
}

function shortHash(value: string): string {
  return createHash("sha1").update(value).digest("hex").slice(0, 8);
}

function slugify(value: string, fallback = "note"): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
  return slug || fallback;
}

function dedupeStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const value = raw?.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function isMemoryScope(value: unknown): value is MemoryScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "global" || kind === "project";
}

function normalizeScope(scope?: MemoryScope | null): MemoryScope {
  if (!scope || scope.kind === "global") return { kind: "global" };
  const projectKey = slugify(scope.projectKey || scope.projectName || scope.projectPath || "project", "project");
  return {
    kind: "project",
    projectKey,
    projectPath: scope.projectPath ?? null,
    projectName: scope.projectName ?? null,
  };
}

function scopeFromQueryOptions(opts?: Pick<MemoryQueryOptions, "scope" | "cwd" | "projectScope" | "includeGlobal">): {
  scope?: MemoryScope;
  includeGlobal: boolean;
} {
  if (!opts) return { includeGlobal: true };
  if (isMemoryScope(opts.scope)) return { scope: normalizeScope(opts.scope), includeGlobal: opts.includeGlobal ?? true };
  if (opts.scope === "all") return { includeGlobal: true };
  if (opts.scope === "global") return { scope: { kind: "global" }, includeGlobal: false };
  if (opts.scope === "project") {
    const scope = opts.projectScope ?? normalizeProjectScope(opts.cwd ?? null);
    return { scope, includeGlobal: opts.includeGlobal ?? true };
  }
  if (opts.projectScope) return { scope: normalizeScope(opts.projectScope), includeGlobal: opts.includeGlobal ?? true };
  if (opts.cwd !== undefined) return { scope: normalizeProjectScope(opts.cwd), includeGlobal: opts.includeGlobal ?? true };
  return { includeGlobal: opts.includeGlobal ?? true };
}

function scopeFromUpsertInput(input: Pick<UpsertMemoryNoteInput, "scope" | "cwd" | "projectScope">, existing?: MemoryNote | null): MemoryScope {
  if (isMemoryScope(input.scope)) return normalizeScope(input.scope);
  if (input.scope === "all") return existing?.scope ?? { kind: "global" };
  if (input.scope === "global") return { kind: "global" };
  if (input.scope === "project") return normalizeScope(input.projectScope ?? normalizeProjectScope(input.cwd ?? null));
  if (input.projectScope) return normalizeScope(input.projectScope);
  if (input.cwd !== undefined) return normalizeProjectScope(input.cwd);
  return existing?.scope ?? { kind: "global" };
}

export function normalizeProjectScope(cwd?: string | null): MemoryScope {
  const raw = cwd?.trim();
  if (!raw) return { kind: "global" };
  const resolved = path.resolve(raw);
  const projectName = path.basename(resolved) || "project";
  return {
    kind: "project",
    projectKey: `${slugify(projectName, "project")}-${shortHash(resolved)}`,
    projectPath: resolved,
    projectName,
  };
}

function scopeDir(scope: MemoryScope): string {
  if (scope.kind === "global") return path.join(vaultRoot(), "Global");
  return path.join(vaultRoot(), "Projects", slugify(scope.projectKey, "project"));
}

function notePathFor(scope: MemoryScope, type: MemoryType, title: string): string {
  return path.join(scopeDir(scope), type, `${slugify(title)}.md`);
}

function idFromPath(filePath: string): string {
  const relative = path.relative(vaultRoot(), filePath);
  return relative.replace(/\\/g, "/").replace(/\.md$/i, "");
}

function pathFromId(id: string): string | null {
  const parts = id.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === ".." || part.includes("\\"))) {
    return null;
  }
  const resolved = path.resolve(vaultRoot(), ...parts) + ".md";
  const root = path.resolve(vaultRoot()) + path.sep;
  return resolved.startsWith(root) ? resolved : null;
}

function yamlQuote(value: string): string {
  return JSON.stringify(value);
}

function parseScalar(raw: string): string {
  const value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

function parseInlineList(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === "[]") return [];
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [parseScalar(trimmed)];
  return trimmed
    .slice(1, -1)
    .split(",")
    .map(parseScalar)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseFrontmatter(raw: string): { frontmatter: Record<string, MemoryFrontmatterValue>; content: string } {
  if (!raw.startsWith(`${FRONTMATTER_DELIMITER}\n`) && !raw.startsWith(`${FRONTMATTER_DELIMITER}\r\n`)) {
    return { frontmatter: {}, content: raw };
  }

  const normalized = raw.replace(/\r\n/g, "\n");
  const end = normalized.indexOf(`\n${FRONTMATTER_DELIMITER}\n`, FRONTMATTER_DELIMITER.length);
  if (end === -1) return { frontmatter: {}, content: raw };

  const frontmatterRaw = normalized.slice(FRONTMATTER_DELIMITER.length + 1, end);
  const content = normalized.slice(end + FRONTMATTER_DELIMITER.length + 2);
  const frontmatter: Record<string, MemoryFrontmatterValue> = {};
  let currentListKey: string | null = null;

  for (const line of frontmatterRaw.split("\n")) {
    const listMatch = line.match(/^\s*-\s*(.*)$/);
    if (listMatch && currentListKey) {
      const current = frontmatter[currentListKey];
      frontmatter[currentListKey] = [...(Array.isArray(current) ? current : []), parseScalar(listMatch[1])];
      continue;
    }

    const keyMatch = line.match(/^([A-Za-z0-9_ -]+):(?:\s*(.*))?$/);
    if (!keyMatch) {
      currentListKey = null;
      continue;
    }

    const key = keyMatch[1].trim();
    const value = keyMatch[2] ?? "";
    if (!value.trim()) {
      frontmatter[key] = [];
      currentListKey = key;
    } else if (value.trim().startsWith("[")) {
      frontmatter[key] = parseInlineList(value);
      currentListKey = null;
    } else {
      frontmatter[key] = parseScalar(value);
      currentListKey = null;
    }
  }

  return { frontmatter, content };
}

function stringValue(value: MemoryFrontmatterValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function listValue(value: MemoryFrontmatterValue | undefined): string[] {
  if (Array.isArray(value)) return dedupeStrings(value);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function formatFrontmatter(meta: Record<string, MemoryFrontmatterValue>): string {
  const lines = [FRONTMATTER_DELIMITER];
  for (const key of Object.keys(meta)) {
    const value = meta[key];
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) lines.push(`  - ${yamlQuote(item)}`);
      }
    } else {
      lines.push(`${key}: ${yamlQuote(value)}`);
    }
  }
  lines.push(FRONTMATTER_DELIMITER, "");
  return lines.join("\n");
}

function stableFrontmatter(note: {
  id: string;
  title: string;
  type: MemoryType;
  scope: MemoryScope;
  tags: string[];
  aliases: string[];
  created_at: string;
  updated_at: string;
  metadata?: Record<string, MemoryFrontmatterValue | null | undefined>;
}): Record<string, MemoryFrontmatterValue> {
  const meta: Record<string, MemoryFrontmatterValue> = {
    id: note.id,
    title: note.title,
    type: note.type,
    scope: note.scope.kind,
  };
  if (note.scope.kind === "project") {
    meta.project_key = note.scope.projectKey;
    if (note.scope.projectPath) meta.project_path = note.scope.projectPath;
    if (note.scope.projectName) meta.project_name = note.scope.projectName;
  }
  meta.tags = note.tags;
  meta.aliases = note.aliases;
  meta.created_at = note.created_at;
  meta.updated_at = note.updated_at;

  const extra = note.metadata ?? {};
  for (const key of Object.keys(extra).sort((a, b) => a.localeCompare(b))) {
    if (KNOWN_FRONTMATTER_KEYS.has(key)) continue;
    const value = extra[key];
    if (typeof value === "string") meta[key] = value;
    if (Array.isArray(value)) meta[key] = dedupeStrings(value);
  }
  return meta;
}

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    await fs.writeFile(tempPath, content, "utf8");
    await fs.rename(tempPath, filePath);
  } catch (err) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
}

async function walkMarkdownFiles(dir: string): Promise<string[]> {
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isENOENT(err)) return [];
    throw err;
  }

  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkMarkdownFiles(fullPath));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}

function scopeFromPath(filePath: string, frontmatter: Record<string, MemoryFrontmatterValue>): MemoryScope {
  const relativeParts = path.relative(vaultRoot(), filePath).split(path.sep);
  const scope = stringValue(frontmatter.scope) ?? stringValue(frontmatter.scope_kind);
  if (scope === "global" || relativeParts[0] === "Global") return { kind: "global" };

  const projectKey = stringValue(frontmatter.project_key) ?? relativeParts[1] ?? "project";
  return {
    kind: "project",
    projectKey: slugify(projectKey, "project"),
    projectPath: stringValue(frontmatter.project_path) ?? null,
    projectName: stringValue(frontmatter.project_name) ?? null,
  };
}

function typeFromPath(filePath: string, frontmatter: Record<string, MemoryFrontmatterValue>): MemoryType | null {
  const fmType = stringValue(frontmatter.type);
  if (isMemoryType(fmType)) return fmType;

  const parts = path.relative(vaultRoot(), filePath).split(path.sep);
  const typePart = parts[0] === "Global" ? parts[1] : parts[2];
  return isMemoryType(typePart) ? typePart : null;
}

function extractWikilinks(content: string): string[] {
  const links: string[] = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const target = match[1].split("|")[0].split("#")[0]?.trim();
    if (target) links.push(target);
  }
  return dedupeStrings(links);
}

function noteKeys(note: Pick<MemoryIndexEntry, "id" | "title" | "aliases">): string[] {
  return dedupeStrings([
    note.id,
    path.basename(note.id),
    slugify(path.basename(note.id)),
    note.title,
    slugify(note.title),
    ...note.aliases,
    ...note.aliases.map((alias) => slugify(alias)),
  ]).map((key) => key.toLowerCase());
}

function cleanExcerpt(content: string, limit = 500): string {
  return content.replace(/\s+/g, " ").trim().slice(0, limit);
}

async function readNoteFile(filePath: string): Promise<MemoryNote | null> {
  const raw = await fs.readFile(filePath, "utf8");
  const stat = await fs.stat(filePath);
  const { frontmatter, content } = parseFrontmatter(raw);
  const type = typeFromPath(filePath, frontmatter);
  if (!type) return null;

  const id = idFromPath(filePath);
  const title = stringValue(frontmatter.title) ?? path.basename(filePath, ".md");
  const scope = scopeFromPath(filePath, frontmatter);
  const created_at = stringValue(frontmatter.created_at) ?? stat.birthtime.toISOString();
  const updated_at = stringValue(frontmatter.updated_at) ?? stat.mtime.toISOString();
  const metadata: Record<string, MemoryFrontmatterValue> = {};
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!KNOWN_FRONTMATTER_KEYS.has(key)) metadata[key] = value;
  }

  return {
    id,
    title,
    type,
    scope,
    path: filePath,
    content,
    tags: listValue(frontmatter.tags),
    aliases: listValue(frontmatter.aliases),
    links: extractWikilinks(content),
    backlinks: [],
    created_at,
    updated_at,
    metadata,
  };
}

function entryFromNote(note: MemoryNote): MemoryIndexEntry {
  return {
    id: note.id,
    title: note.title,
    type: note.type,
    scope: note.scope,
    path: note.path,
    tags: note.tags,
    aliases: note.aliases,
    links: note.links,
    wikilinks: note.links,
    backlinks: note.backlinks,
    created_at: note.created_at,
    updated_at: note.updated_at,
    excerpt: cleanExcerpt(note.content),
  };
}

function resolveGraphLinks(entries: MemoryIndexEntry[]): MemoryIndexEntry[] {
  const lookup = new Map<string, string>();
  for (const entry of entries) {
    for (const key of noteKeys(entry)) lookup.set(key, entry.id);
  }

  const backlinks = new Map<string, Set<string>>();
  const resolved = entries.map((entry) => {
    const links = dedupeStrings(entry.wikilinks.map((target) => lookup.get(target.toLowerCase()) ?? lookup.get(slugify(target)) ?? target));
    for (const link of links) {
      if (!backlinks.has(link)) backlinks.set(link, new Set());
      backlinks.get(link)!.add(entry.id);
    }
    return { ...entry, links };
  });

  return resolved.map((entry) => ({
    ...entry,
    backlinks: [...(backlinks.get(entry.id) ?? new Set<string>())].sort((a, b) => a.localeCompare(b)),
  }));
}

function indexPayload(entries: MemoryIndexEntry[]): MemoryIndexFile {
  return {
    generated_at: new Date().toISOString(),
    notes: entries.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export async function buildMemoryIndex(): Promise<MemoryIndexFile> {
  const files = await walkMarkdownFiles(vaultRoot());
  const settled = await Promise.allSettled(files.map((file) => readNoteFile(file)));
  const entries = settled.flatMap((result) => (
    result.status === "fulfilled" && result.value ? [entryFromNote(result.value)] : []
  ));
  const payload = indexPayload(resolveGraphLinks(entries));
  await atomicWriteFile(indexPath(), JSON.stringify(payload, null, 2) + "\n");
  return payload;
}

function scopeMatches(entry: MemoryIndexEntry, scope?: MemoryScope, includeGlobal = true): boolean {
  if (!scope) return true;
  if (scope.kind === "global") return entry.scope.kind === "global";
  if (entry.scope.kind === "global") return includeGlobal;
  return entry.scope.projectKey === scope.projectKey;
}

export async function listMemoryNotes(opts?: {
  scope?: MemoryScopeFilter;
  cwd?: string | null;
  projectScope?: MemoryScope;
  type?: MemoryType;
  types?: MemoryType[];
  tag?: string;
  tags?: string[];
  limit?: number;
  includeGlobal?: boolean;
}): Promise<MemoryIndexEntry[]> {
  const index = await buildMemoryIndex();
  const tags = opts?.tags ?? (opts?.tag ? [opts.tag] : []);
  const scopeFilter = scopeFromQueryOptions(opts);
  let notes = index.notes;
  if (scopeFilter.scope) notes = notes.filter((entry) => scopeMatches(entry, scopeFilter.scope, scopeFilter.includeGlobal));
  if (opts?.type) notes = notes.filter((entry) => entry.type === opts.type);
  if (opts?.types?.length) notes = notes.filter((entry) => opts.types!.includes(entry.type));
  if (tags.length) {
    const wanted = tags.map((tag) => tag.toLowerCase());
    notes = notes.filter((entry) => wanted.every((tag) => entry.tags.some((entryTag) => entryTag.toLowerCase() === tag)));
  }
  notes = [...notes].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return opts?.limit ? notes.slice(0, opts.limit) : notes;
}

export async function getMemoryNote(id: string): Promise<MemoryNote | null> {
  const index = await buildMemoryIndex();
  const entry = index.notes.find((note) => note.id === id);
  if (!entry) return null;
  const note = await readNoteFile(entry.path);
  if (!note) return null;
  return { ...note, links: entry.links, backlinks: entry.backlinks };
}

export async function upsertMemoryNote(input: UpsertMemoryNoteInput): Promise<MemoryNote> {
  const existingById = input.id ? await getMemoryNote(input.id).catch(() => null) : null;
  const title = (input.title ?? existingById?.title ?? "").trim();
  if (!title) throw new Error("Memory note title is required");

  const type = isMemoryType(input.type) ? input.type : existingById?.type ?? "Concepts";
  const scope = scopeFromUpsertInput(input, existingById);
  const filePath = notePathFor(scope, type, title);
  const id = idFromPath(filePath);
  const existingAtTarget = await readNoteFile(filePath).catch((err) => {
    if (isENOENT(err)) return null;
    throw err;
  });
  const existing = existingById ?? existingAtTarget;
  const now = new Date().toISOString();

  const created_at = input.created_at ?? existing?.created_at ?? now;
  const updated_at = input.updated_at ?? now;
  const tags = input.tags ? dedupeStrings(input.tags) : existing?.tags ?? [];
  const aliases = input.aliases ? dedupeStrings(input.aliases) : existing?.aliases ?? [];
  const metadata = { ...(existing?.metadata ?? {}), ...(input.metadata ?? {}) };
  const content = input.content ?? existing?.content ?? "";
  const frontmatter = stableFrontmatter({
    id,
    title,
    type,
    scope,
    tags,
    aliases,
    created_at,
    updated_at,
    metadata,
  });

  await atomicWriteFile(filePath, formatFrontmatter(frontmatter) + content.trimEnd() + "\n");
  if (existingById && existingById.path !== filePath) {
    await fs.rm(existingById.path, { force: true });
  }
  await buildMemoryIndex();
  const note = await getMemoryNote(id);
  if (!note) throw new Error(`Failed to read memory note after write: ${id}`);
  void enqueueMemoryEmbeddingRefresh(note.id, "refresh").catch(() => {});
  return note;
}

export async function deleteMemoryNote(id: string): Promise<void> {
  const filePath = pathFromId(id);
  if (!filePath) return;
  await fs.rm(filePath, { force: true });
  await buildMemoryIndex();
  void enqueueMemoryEmbeddingRefresh(id, "delete").catch(() => {});
}

function tokenize(value: string): string[] {
  return dedupeStrings(value.toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? []);
}

function recencyScore(updatedAt: string): number {
  const time = new Date(updatedAt).getTime();
  if (!Number.isFinite(time)) return 0;
  const days = Math.max(0, (Date.now() - time) / 86_400_000);
  return Math.max(0, 5 - Math.log1p(days));
}

async function noteContentForEntry(entry: MemoryIndexEntry): Promise<string> {
  try {
    const note = await readNoteFile(entry.path);
    return note?.content ?? entry.excerpt;
  } catch {
    return entry.excerpt;
  }
}

function snippetFor(content: string, terms: string[]): string {
  const compact = content.replace(/\s+/g, " ").trim();
  if (!compact) return "";
  const lower = compact.toLowerCase();
  const hit = terms.map((term) => lower.indexOf(term)).filter((idx) => idx >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, hit - 90);
  const snippet = compact.slice(start, start + MAX_SNIPPET_LENGTH);
  return `${start > 0 ? "..." : ""}${snippet}${start + MAX_SNIPPET_LENGTH < compact.length ? "..." : ""}`;
}

function graphBoost(entry: MemoryIndexEntry, seedIds: Set<string>): number {
  if (!seedIds.size || seedIds.has(entry.id)) return 0;
  if (entry.links.some((id) => seedIds.has(id)) || entry.backlinks.some((id) => seedIds.has(id))) return 4;
  return 0;
}

export async function searchMemory(opts: {
  query?: string;
  q?: string;
  message?: string;
  scope?: MemoryScopeFilter;
  cwd?: string | null;
  projectScope?: MemoryScope;
  type?: MemoryType;
  types?: MemoryType[];
  tag?: string;
  tags?: string[];
  limit?: number;
  includeGlobal?: boolean;
  retrievalMode?: MemoryRetrievalMode;
}): Promise<MemorySearchResult[]> {
  const scopeFilter = scopeFromQueryOptions(opts);
  let settings: AppSettings | undefined;
  try {
    settings = await readAppSettings();
  } catch {
    settings = undefined;
  }
  const mode = opts.retrievalMode ?? settings?.memoryRetrievalMode ?? "keyword";
  const index = await buildMemoryIndex();
  if (mode !== "keyword") {
    void processMemoryEmbeddingQueue().catch(() => {});
  }
  const terms = tokenize(opts.query ?? opts.q ?? opts.message ?? "");
  const queryText = opts.query ?? opts.q ?? opts.message ?? "";
  const wantedTags = (opts.tags ?? (opts.tag ? [opts.tag] : [])).map((tag) => tag.toLowerCase());
  const filtered = index.notes.filter((entry) => {
    if (!scopeMatches(entry, scopeFilter.scope, scopeFilter.includeGlobal)) return false;
    if (opts.type && entry.type !== opts.type) return false;
    if (opts.types?.length && !opts.types.includes(entry.type)) return false;
    if (wantedTags.length && !wantedTags.every((tag) => entry.tags.some((entryTag) => entryTag.toLowerCase() === tag))) return false;
    return true;
  });

  const seedIds = new Set<string>();
  if (terms.length) {
    for (const entry of filtered) {
      const titleTokens = tokenize([entry.title, ...entry.aliases, ...entry.tags].join(" "));
      if (terms.some((term) => titleTokens.includes(term))) seedIds.add(entry.id);
    }
  }

  const keywordResults = await Promise.all(filtered.map(async (entry) => {
    const content = await noteContentForEntry(entry);
    const titleTokens = tokenize(entry.title);
    const tagTokens = tokenize(entry.tags.join(" "));
    const aliasTokens = tokenize(entry.aliases.join(" "));
    const bodyTokens = tokenize(content);
    const reasons: string[] = [];
    const recent = recencyScore(entry.updated_at);
    let score = recent;
    let graphScore = 0;

    if (!terms.length) {
      reasons.push("recent");
    } else {
      for (const term of terms) {
        if (titleTokens.includes(term)) {
          score += 8;
          reasons.push(`title:${term}`);
        }
        if (tagTokens.includes(term)) {
          score += 5;
          reasons.push(`tag:${term}`);
        }
        if (aliasTokens.includes(term)) {
          score += 5;
          reasons.push(`alias:${term}`);
        }
        if (bodyTokens.includes(term)) {
          score += 1;
          reasons.push(`body:${term}`);
        }
      }
    }

    const proximity = graphBoost(entry, seedIds);
    if (proximity) {
      graphScore = proximity;
      score += proximity;
      reasons.push("graph");
    }

    return {
      note: entry,
      score,
      snippet: snippetFor(content || entry.excerpt, terms),
      reasons: dedupeStrings(reasons),
      retrieval: {
        keywordScore: score,
        graphScore,
        recencyScore: recent,
        mode,
      },
    };
  }));

  const keywordOnly = keywordResults
    .filter((result) => !terms.length || result.reasons.length > 0)
    .sort((a, b) => b.score - a.score || b.note.updated_at.localeCompare(a.note.updated_at));

  if (mode === "keyword" || !queryText.trim()) {
    return keywordOnly.slice(0, opts.limit ?? 10);
  }

  let semanticResults: SemanticMemoryResult[] = [];
  try {
    semanticResults = await semanticSearchMemory({
      query: queryText,
      entries: filtered,
      settings,
      scope: scopeFilter.scope,
      includeGlobal: scopeFilter.includeGlobal,
      type: opts.type,
      types: opts.types,
      tag: opts.tag,
      tags: opts.tags,
      limit: Math.max(opts.limit ?? 10, 20),
    });
  } catch {
    if (mode === "semantic") return [];
    return keywordOnly.slice(0, opts.limit ?? 10);
  }

  const byId = new Map<string, MemorySearchResult>();
  for (const result of keywordOnly) byId.set(result.note.id, result);
  const entriesById = new Map(filtered.map((entry) => [entry.id, entry]));

  for (const semantic of semanticResults) {
    const entry = entriesById.get(semantic.noteId);
    if (!entry) continue;
    const existing = byId.get(entry.id);
    const semanticScore = semantic.score;
    const keywordScore = existing?.retrieval?.keywordScore ?? 0;
    const graphScore = existing?.retrieval?.graphScore ?? 0;
    const recent = recencyScore(entry.updated_at);
    const score = mode === "semantic"
      ? semanticScore * 100 + recent
      : semanticScore * 55 + Math.min(1, keywordScore / 20) * 30 + Math.min(1, graphScore / 4) * 10 + Math.min(1, recent / 5) * 5;
    byId.set(entry.id, {
      note: entry,
      score,
      snippet: semantic.snippet || existing?.snippet || entry.excerpt,
      reasons: dedupeStrings([...(existing?.reasons ?? []), ...semantic.reasons, "semantic"]),
      retrieval: {
        keywordScore,
        semanticScore,
        graphScore,
        recencyScore: recent,
        chunkId: semantic.chunkId,
        mode,
      },
    });
  }

  const merged = [...byId.values()].filter((result) => {
    if (!terms.length) return true;
    if (mode === "semantic") return typeof result.retrieval?.semanticScore === "number";
    return result.reasons.length > 0;
  });
  return merged
    .sort((a, b) => b.score - a.score || b.note.updated_at.localeCompare(a.note.updated_at))
    .slice(0, opts.limit ?? 10);
}

export async function getMemoryGraph(opts?: {
  q?: string;
  scope?: MemoryScopeFilter;
  cwd?: string | null;
  projectScope?: MemoryScope;
  type?: MemoryType;
  types?: MemoryType[];
  tag?: string;
  includeGlobal?: boolean;
  semantic?: boolean;
}): Promise<MemoryGraph> {
  const scopeFilter = scopeFromQueryOptions(opts);
  const index = await buildMemoryIndex();
  const nodes = index.notes.filter((entry) => {
    if (!scopeMatches(entry, scopeFilter.scope, scopeFilter.includeGlobal)) return false;
    if (opts?.type && entry.type !== opts.type) return false;
    if (opts?.types?.length && !opts.types.includes(entry.type)) return false;
    if (opts?.tag && !entry.tags.some((tag) => tag.toLowerCase() === opts.tag!.toLowerCase())) return false;
    return true;
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = nodes.flatMap((node) => (
    node.links
      .filter((target) => nodeIds.has(target))
      .map((target) => ({ source: node.id, target, label: "wikilink" }))
  ));
  if (!opts?.semantic) return { nodes, edges };
  try {
    const semanticEdges = await getSemanticGraphEdges({ entries: nodes });
    return {
      nodes,
      edges: [
        ...edges,
        ...semanticEdges
          .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
          .map((edge) => ({ source: edge.source, target: edge.target, label: `semantic:${edge.score.toFixed(2)}` })),
      ],
    };
  } catch {
    return { nodes, edges };
  }
}

export async function buildMemoryRecallBlock(opts: {
  query?: string;
  q?: string;
  message?: string;
  scope?: MemoryScopeFilter;
  cwd?: string | null;
  projectScope?: MemoryScope;
  type?: MemoryType;
  types?: MemoryType[];
  tag?: string;
  tags?: string[];
  limit?: number;
  includeGlobal?: boolean;
}): Promise<string> {
  const results = await searchMemory({ ...opts, limit: opts.limit ?? 6 });
  if (!results.length) return "";
  const lines = ["## Memory Recall", ""];
  for (const result of results) {
    const scope = result.note.scope.kind === "global" ? "global" : `project:${result.note.scope.projectKey}`;
    lines.push(`- [[${result.note.title}]] (${result.note.type}, ${scope}, score ${result.score.toFixed(1)})`);
    if (result.snippet) lines.push(`  ${result.snippet}`);
  }
  return lines.join("\n");
}

function captureText(input: MemoryCaptureInput): string {
  const parts: string[] = [];
  if (input.text) parts.push(input.text);
  if (input.prompt) parts.push(`Prompt:\n${input.prompt}`);
  if (input.response) parts.push(`Response:\n${input.response}`);
  if (input.userMessage) parts.push(`User:\n${input.userMessage}`);
  if (input.finalText) parts.push(`Assistant:\n${input.finalText}`);
  const turn = recordValue(input.turn);
  const turnUserMessage = stringField(turn, "user_message");
  const turnFinalText = stringField(turn, "final_text");
  if (turnUserMessage) parts.push(`User:\n${turnUserMessage}`);
  if (turnFinalText) parts.push(`Assistant:\n${turnFinalText}`);
  for (const message of input.messages ?? []) {
    if (!message?.content) continue;
    parts.push(`${message.role ?? "message"}:\n${message.content}`);
  }
  return parts.join("\n\n");
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sanitizeCapturedText(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !SECRET_LINE_RE.test(line))
    .join("\n")
    .trim()
    .slice(0, 12_000);
}

function firstMatchingLine(text: string, re: RegExp): string | null {
  for (const line of text.split(/\r?\n/)) {
    const cleaned = line.replace(/^[\s>*#-]+/, "").trim();
    if (cleaned && re.test(cleaned)) return cleaned;
  }
  return null;
}

function compactTitle(value: string, fallback: string): string {
  const cleaned = value
    .replace(/\s+/g, " ")
    .replace(/[`*_()[\]{}]/g, "")
    .trim()
    .slice(0, 90);
  return cleaned || fallback;
}

function turnIdentity(input: MemoryCaptureInput): { sessionId: string; turnId: string } {
  const session = recordValue(input.session);
  const meta = recordValue(input.meta) ?? recordValue(session?.meta);
  const turn = recordValue(input.turn);
  const sessionId = (
    input.session_id ??
    input.sessionId ??
    stringField(meta, "session_id") ??
    stringField(session, "session_id") ??
    ""
  ).trim();
  const turnId = (
    input.turn_id ??
    input.turnId ??
    stringField(turn, "turn_id") ??
    ""
  ).trim();
  return { sessionId, turnId };
}

function captureScope(input: MemoryCaptureInput): MemoryScope {
  if (input.cwd || input.projectPath) {
    const scope = normalizeProjectScope(input.cwd ?? input.projectPath ?? null);
    if (scope.kind === "project" && input.projectName) return { ...scope, projectName: input.projectName };
    return scope;
  }
  const session = recordValue(input.session);
  const meta = recordValue(input.meta) ?? recordValue(session?.meta);
  const agentSnapshot = recordValue(meta?.agent_snapshot);
  const cwd = stringField(agentSnapshot, "cwd");
  if (cwd) return normalizeProjectScope(cwd);
  return { kind: "global" };
}

function sessionContent(input: MemoryCaptureInput, text: string, capturedAt: string, scope: MemoryScope): string {
  const { sessionId, turnId } = turnIdentity(input);
  const scopeLabel = scope.kind === "global" ? "global" : `project:${scope.projectKey}`;
  return [
    `# Session ${sessionId} Turn ${turnId}`,
    "",
    `- Session: ${sessionId}`,
    `- Turn: ${turnId}`,
    `- Captured: ${capturedAt}`,
    `- Scope: ${scopeLabel}`,
    "",
    "## Transcript",
    "",
    text || "_No non-sensitive transcript text captured._",
  ].join("\n");
}

function heuristicContent(title: string, type: MemoryType, line: string, sessionTitle: string): string {
  return [
    `# ${title}`,
    "",
    `Captured from [[${sessionTitle}]].`,
    "",
    `Type: ${type}`,
    "",
    "## Evidence",
    "",
    line,
  ].join("\n");
}

export async function captureMemoryFromTurn(input: MemoryCaptureInput): Promise<MemoryCaptureSummary> {
  const summary: MemoryCaptureSummary = { ok: true, captured: 0, skipped: false, notes: [], errors: [] };
  try {
    const turn = recordValue(input.turn);
    const turnStatus = stringField(turn, "status");
    if (input.success === false) {
      return { ...summary, skipped: true };
    }
    if (turnStatus && turnStatus !== "success") {
      return { ...summary, skipped: true };
    }

    const { sessionId, turnId } = turnIdentity(input);
    if (!sessionId || !turnId) {
      return { ...summary, ok: false, skipped: true, errors: ["session_id and turn_id are required"] };
    }

    const rawText = captureText(input);
    const text = sanitizeCapturedText(rawText);
    const scope = captureScope(input);
    const capturedAt = input.timestamp ?? new Date().toISOString();
    const baseTags = dedupeStrings([...(input.tags ?? []), "captured-turn", sessionId]);
    const sessionTitle = `Session ${sessionId} Turn ${turnId}`;
    const metadata: Record<string, MemoryFrontmatterValue> = {
      session_id: sessionId,
      turn_id: turnId,
      source: "captureMemoryFromTurn",
    };

    const sessionNote = await upsertMemoryNote({
      title: sessionTitle,
      type: "Sessions",
      scope,
      tags: baseTags,
      aliases: [`${sessionId}/${turnId}`],
      metadata,
      updated_at: capturedAt,
      content: sessionContent(input, text, capturedAt, scope),
    });
    summary.notes.push({ id: sessionNote.id, title: sessionNote.title, type: sessionNote.type });

    const candidates: Array<{ type: MemoryType; re: RegExp; fallback: string; tags: string[] }> = [
      { type: "Projects", re: /\b(project|repo|repository|workspace|build|test|lint|package|dashboard|saturn)\b/i, fallback: "Project context", tags: ["project"] },
      { type: "Concepts", re: /\b(concept|pattern|architecture|design|api|module|component|schema|model)\b/i, fallback: "Concept from turn", tags: ["concept"] },
      { type: "Troubleshooting", re: /\b(error|failed|failure|bug|fix|issue|exception|regression|broken)\b/i, fallback: "Troubleshooting from turn", tags: ["troubleshooting"] },
      { type: "Decisions", re: /\b(decision|decided|choose|chosen|will use|use .* instead|should use)\b/i, fallback: "Decision from turn", tags: ["decision"] },
    ];

    for (const candidate of candidates) {
      const line = firstMatchingLine(text, candidate.re);
      if (!line) continue;
      const projectName = scope.kind === "project" ? scope.projectName ?? scope.projectKey : "Global";
      const title = candidate.type === "Projects"
        ? projectName
        : compactTitle(line.replace(/^(decision|concept|issue|error|fix|project)\s*[: -]\s*/i, ""), candidate.fallback);
      const note = await upsertMemoryNote({
        title,
        type: candidate.type,
        scope,
        tags: dedupeStrings([...baseTags, ...candidate.tags]),
        metadata,
        updated_at: capturedAt,
        content: heuristicContent(title, candidate.type, line, sessionTitle),
      });
      summary.notes.push({ id: note.id, title: note.title, type: note.type });
    }

    try {
      summary.curator = await curateCapturedMemory({
        input,
        text,
        scope,
        sessionTitle,
        metadata,
        capturedAt,
      });
    } catch (err) {
      summary.curator = {
        skipped: false,
        applied: 0,
        errors: [(err as Error)?.message ?? String(err)],
      };
    }

    summary.captured = summary.notes.length;
    return summary;
  } catch (err) {
    return {
      ...summary,
      ok: false,
      errors: [(err as Error)?.message ?? String(err)],
    };
  }
}
