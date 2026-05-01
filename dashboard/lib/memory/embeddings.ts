import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { memoryRoot } from "../paths";
import { readAppSettings, type AppSettings } from "../settings";
import type { MemoryCaptureInput, MemoryFrontmatterValue, MemoryIndexEntry, MemoryScope, MemoryType } from "./index";

const execFileAsync = promisify(execFile);

const EMBEDDINGS_VERSION = 1;
const CHUNKS_FILENAME = "chunks.jsonl";
const MANIFEST_FILENAME = "manifest.json";
const QUEUE_FILENAME = "queue.json";
const TARGET_CHUNK_TOKENS = 800;
const CHUNK_OVERLAP_TOKENS = 120;
const DEFAULT_DIMENSIONS = 1536;
const SEMANTIC_EDGE_THRESHOLD = 0.82;
const MEMORY_TYPES: MemoryType[] = ["Entities", "Concepts", "Projects", "Decisions", "Troubleshooting", "Sessions"];

type EmbeddingProvider = "openai-compatible" | "bedrock" | "local-http" | "disabled" | string;

export type MemoryEmbeddingChunk = {
  id: string;
  noteId: string;
  chunkIndex: number;
  contentHash: string;
  title: string;
  type: MemoryType;
  scope: MemoryScope;
  tags: string[];
  aliases: string[];
  updatedAt: string;
  text: string;
  embedding: number[];
};

export type MemoryEmbeddingsManifest = {
  version: number;
  provider: string;
  model: string;
  dimensions: number;
  status: "idle" | "indexing" | "error" | "disabled";
  updatedAt?: string;
  totalNotes: number;
  totalChunks: number;
  queued: number;
  noteHashes: Record<string, string>;
  lastError?: string;
};

type EmbeddingQueueItem = {
  noteId: string;
  action: "refresh" | "delete" | "rebuild";
  queuedAt: string;
};

type EmbeddingQueue = {
  version: number;
  items: EmbeddingQueueItem[];
};

export type MemoryEmbeddingsStatus = {
  available: boolean;
  enabled: boolean;
  provider: string;
  model: string;
  dimensions: number;
  status: MemoryEmbeddingsManifest["status"];
  totalNotes: number;
  totalChunks: number;
  queued: number;
  updatedAt?: string;
  lastError?: string;
  paths: {
    root: string;
    chunks: string;
    manifest: string;
    queue: string;
  };
};

export type SemanticMemoryResult = {
  noteId: string;
  score: number;
  snippet: string;
  chunkId: string;
  reasons: string[];
};

type SemanticSearchOptions = {
  query: string;
  entries: MemoryIndexEntry[];
  settings?: AppSettings;
  scope?: MemoryScope;
  includeGlobal?: boolean;
  type?: MemoryType;
  types?: MemoryType[];
  tag?: string;
  tags?: string[];
  limit?: number;
};

type CuratorOp = {
  op?: "upsert" | "merge" | "skip";
  targetId?: string;
  title?: string;
  type?: MemoryType;
  content?: string;
  tags?: string[];
  aliases?: string[];
};

type CuratorPayload = {
  input: MemoryCaptureInput;
  text: string;
  scope: MemoryScope;
  sessionTitle: string;
  metadata: Record<string, MemoryFrontmatterValue>;
  capturedAt: string;
};

function embeddingsRoot(): string {
  return path.join(memoryRoot(), "embeddings");
}

function chunksPath(): string {
  return path.join(embeddingsRoot(), CHUNKS_FILENAME);
}

function manifestPath(): string {
  return path.join(embeddingsRoot(), MANIFEST_FILENAME);
}

function queuePath(): string {
  return path.join(embeddingsRoot(), QUEUE_FILENAME);
}

function embeddingProvider(settings: AppSettings): EmbeddingProvider {
  return settings.memoryEmbeddingProvider || "disabled";
}

function embeddingModel(settings: AppSettings): string {
  const provider = embeddingProvider(settings);
  if (settings.memoryEmbeddingModel) return settings.memoryEmbeddingModel;
  if (provider === "bedrock") return "amazon.titan-embed-text-v2:0";
  return "text-embedding-3-small";
}

function embeddingBaseUrl(settings: AppSettings): string {
  return (settings.memoryEmbeddingBaseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
}

function embeddingDimensions(settings: AppSettings): number {
  return settings.memoryEmbeddingDimensions || DEFAULT_DIMENSIONS;
}

function curatorProvider(settings: AppSettings): string {
  return settings.memoryCuratorProvider || "disabled";
}

function curatorModel(settings: AppSettings): string {
  return settings.memoryCuratorModel || "gpt-4.1-mini";
}

function curatorBaseUrl(settings: AppSettings): string {
  return (settings.memoryCuratorBaseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
}

function embeddingConfigKey(settings: AppSettings): string {
  return [
    embeddingProvider(settings),
    embeddingModel(settings),
    embeddingBaseUrl(settings),
    embeddingDimensions(settings),
  ].join("|");
}

function isProviderConfigured(settings: AppSettings): boolean {
  const provider = embeddingProvider(settings);
  if (provider === "disabled") return false;
  if (provider === "bedrock") return Boolean(embeddingModel(settings));
  if (provider === "local-http") {
    return Boolean(embeddingBaseUrl(settings) && embeddingModel(settings));
  }
  if (provider === "openai-compatible") {
    return Boolean(embeddingBaseUrl(settings) && embeddingModel(settings) && settings.memoryEmbeddingApiKey);
  }
  return false;
}

function deterministicEmbeddingsEnabled(settings: AppSettings): boolean {
  return process.env.SATURN_MEMORY_DETERMINISTIC_EMBEDDINGS === "1"
    || embeddingProvider(settings) === "disabled";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.writeFile(tempPath, content, "utf8");
    await fs.rename(tempPath, filePath);
  } catch (err) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return fallback;
    return fallback;
  }
}

function emptyManifest(settings: AppSettings): MemoryEmbeddingsManifest {
  return {
    version: EMBEDDINGS_VERSION,
    provider: embeddingProvider(settings),
    model: embeddingModel(settings),
    dimensions: embeddingDimensions(settings),
    status: embeddingProvider(settings) === "disabled" ? "disabled" : "idle",
    totalNotes: 0,
    totalChunks: 0,
    queued: 0,
    noteHashes: {},
  };
}

async function readManifest(settings: AppSettings): Promise<MemoryEmbeddingsManifest> {
  return readJson(manifestPath(), emptyManifest(settings));
}

async function writeManifest(manifest: MemoryEmbeddingsManifest): Promise<void> {
  await atomicWriteFile(manifestPath(), JSON.stringify(manifest, null, 2) + "\n");
}

async function readQueue(): Promise<EmbeddingQueue> {
  return readJson(queuePath(), { version: EMBEDDINGS_VERSION, items: [] });
}

async function writeQueue(queue: EmbeddingQueue): Promise<void> {
  await atomicWriteFile(queuePath(), JSON.stringify(queue, null, 2) + "\n");
}

export async function readMemoryEmbeddingChunks(): Promise<MemoryEmbeddingChunk[]> {
  try {
    const raw = await fs.readFile(chunksPath(), "utf8");
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as MemoryEmbeddingChunk;
          return Array.isArray(parsed.embedding) ? [parsed] : [];
        } catch {
          return [];
        }
      });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw err;
  }
}

async function writeChunks(chunks: MemoryEmbeddingChunk[]): Promise<void> {
  await atomicWriteFile(chunksPath(), chunks.map((chunk) => JSON.stringify(chunk)).join("\n") + (chunks.length ? "\n" : ""));
}

function noteScopeKey(scope: MemoryScope): string {
  return scope.kind === "global" ? "global" : `project:${scope.projectKey}`;
}

function noteHash(entry: MemoryIndexEntry, content: string, settings: AppSettings): string {
  return sha256(JSON.stringify({
    id: entry.id,
    title: entry.title,
    type: entry.type,
    scope: entry.scope,
    tags: entry.tags,
    aliases: entry.aliases,
    content,
    config: embeddingConfigKey(settings),
  }));
}

function stripMarkdown(value: string): string {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[\[([^\]\n]+)\]\]/g, (_match, raw: string) => raw.split("|").at(-1)?.trim() ?? raw)
    .replace(/\[([^\]\n]+)\]\([^\)\n]+\)/g, "$1")
    .replace(/[`*_>#-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenWindows(text: string, target = TARGET_CHUNK_TOKENS, overlap = CHUNK_OVERLAP_TOKENS): string[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length <= target) return [tokens.join(" ")].filter(Boolean);
  const chunks: string[] = [];
  const step = Math.max(1, target - overlap);
  for (let start = 0; start < tokens.length; start += step) {
    chunks.push(tokens.slice(start, start + target).join(" "));
    if (start + target >= tokens.length) break;
  }
  return chunks;
}

export function chunkMemoryEntry(entry: MemoryIndexEntry, content: string, settings: AppSettings): MemoryEmbeddingChunk[] {
  const prefix = [
    `Title: ${entry.title}`,
    `Type: ${entry.type}`,
    `Scope: ${noteScopeKey(entry.scope)}`,
    entry.tags.length ? `Tags: ${entry.tags.join(", ")}` : "",
    entry.aliases.length ? `Aliases: ${entry.aliases.join(", ")}` : "",
  ].filter(Boolean).join("\n");

  const sections = content
    .replace(/\r\n/g, "\n")
    .split(/\n(?=#{1,6}\s+)/)
    .map(stripMarkdown)
    .filter(Boolean);
  const textSections = sections.length ? sections : [stripMarkdown(content || entry.excerpt || entry.title)];
  const contentHash = noteHash(entry, content, settings);
  const chunks: MemoryEmbeddingChunk[] = [];
  let chunkIndex = 0;

  for (const section of textSections) {
    for (const text of tokenWindows(`${prefix}\n\n${section}`)) {
      chunks.push({
        id: `${entry.id}#${chunkIndex}`,
        noteId: entry.id,
        chunkIndex,
        contentHash,
        title: entry.title,
        type: entry.type,
        scope: entry.scope,
        tags: entry.tags,
        aliases: entry.aliases,
        updatedAt: entry.updated_at,
        text,
        embedding: [],
      });
      chunkIndex += 1;
    }
  }

  return chunks;
}

function normalizeVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? vector.map((value) => value / norm) : vector;
}

function deterministicEmbedding(text: string, dimensions: number): number[] {
  const vector = new Array(dimensions).fill(0);
  const rawTokens = stripMarkdown(text).toLowerCase().match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [];
  const synonyms: Record<string, string[]> = {
    persistence: ["storage", "durable", "file-backed", "vault", "atomic", "writes"],
    storage: ["persistence", "durable", "file-backed", "vault"],
    durable: ["persistence", "storage"],
    "file-backed": ["persistence", "storage", "vault"],
    vault: ["persistence", "storage", "file-backed"],
    retry: ["backoff", "retries", "transient"],
    retries: ["retry", "backoff", "transient"],
    auth: ["authentication", "login", "credentials"],
    bug: ["error", "failure", "issue", "fix"],
    architecture: ["design", "pattern", "system"],
  };
  const tokens = rawTokens.flatMap((token) => [token, ...(synonyms[token] ?? [])]);
  for (const token of tokens) {
    const hash = createHash("sha256").update(token).digest();
    for (let i = 0; i < hash.length; i += 2) {
      const index = ((hash[i] << 8) + hash[i + 1]) % dimensions;
      vector[index] += 1;
    }
  }
  return normalizeVector(vector);
}

async function openAICompatibleEmbeddings(settings: AppSettings, inputs: string[]): Promise<number[][]> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (settings.memoryEmbeddingApiKey) headers.Authorization = `Bearer ${settings.memoryEmbeddingApiKey}`;
  const res = await fetch(`${embeddingBaseUrl(settings)}/embeddings`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: embeddingModel(settings),
      input: inputs,
      dimensions: embeddingDimensions(settings),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data?.error?.message === "string" ? data.error.message : `embedding request failed: ${res.status}`);
  const embeddings = Array.isArray(data?.data) ? data.data : [];
  if (embeddings.length !== inputs.length) throw new Error("embedding response count did not match input count");
  return embeddings.map((item: { embedding?: unknown }) => {
    if (!Array.isArray(item.embedding)) throw new Error("embedding response item is missing embedding");
    return normalizeVector(item.embedding.filter((value): value is number => typeof value === "number"));
  });
}

async function bedrockEmbedding(settings: AppSettings, input: string): Promise<number[]> {
  const outputPath = path.join(os.tmpdir(), `saturn-bedrock-embedding-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const body = JSON.stringify({
    inputText: input,
    dimensions: embeddingDimensions(settings),
    normalize: true,
  });
  try {
    await execFileAsync("aws", [
      "bedrock-runtime",
      "invoke-model",
      "--model-id",
      embeddingModel(settings),
      "--body",
      body,
      "--content-type",
      "application/json",
      "--accept",
      "application/json",
      outputPath,
      "--profile",
      settings.bedrockProfile,
      "--region",
      settings.bedrockRegion,
      "--output",
      "json",
      "--no-cli-pager",
    ], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        AWS_PROFILE: settings.bedrockProfile,
        AWS_REGION: settings.bedrockRegion,
        AWS_PAGER: "",
      },
    });
    const parsed = JSON.parse(await fs.readFile(outputPath, "utf8")) as { embedding?: unknown };
    if (!Array.isArray(parsed.embedding)) throw new Error("Bedrock embedding response is missing embedding");
    return normalizeVector(parsed.embedding.filter((value): value is number => typeof value === "number"));
  } finally {
    await fs.rm(outputPath, { force: true }).catch(() => {});
  }
}

async function invokeOpenAICompatibleCurator(settings: AppSettings, system: string, prompt: string): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (settings.memoryCuratorApiKey) headers.Authorization = `Bearer ${settings.memoryCuratorApiKey}`;
  const res = await fetch(`${curatorBaseUrl(settings)}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: curatorModel(settings),
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(typeof data?.error?.message === "string" ? data.error.message : `curator request failed: ${res.status}`);
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("curator response did not include text");
  return text;
}

async function invokeBedrockCurator(settings: AppSettings, system: string, prompt: string): Promise<string> {
  const outputPath = path.join(os.tmpdir(), `saturn-bedrock-curator-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const body = JSON.stringify({
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: 1800,
    system,
    messages: [{ role: "user", content: prompt }],
  });
  try {
    await execFileAsync("aws", [
      "bedrock-runtime",
      "invoke-model",
      "--model-id",
      curatorModel(settings),
      "--body",
      body,
      "--content-type",
      "application/json",
      "--accept",
      "application/json",
      outputPath,
      "--profile",
      settings.bedrockProfile,
      "--region",
      settings.bedrockRegion,
      "--output",
      "json",
      "--no-cli-pager",
    ], {
      timeout: 90_000,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        AWS_PROFILE: settings.bedrockProfile,
        AWS_REGION: settings.bedrockRegion,
        AWS_PAGER: "",
      },
    });
    const parsed = JSON.parse(await fs.readFile(outputPath, "utf8")) as { content?: Array<{ text?: string }> };
    const text = parsed.content?.find((item) => typeof item.text === "string")?.text;
    if (!text) throw new Error("Bedrock curator response did not include text");
    return text;
  } finally {
    await fs.rm(outputPath, { force: true }).catch(() => {});
  }
}

async function invokeCurator(settings: AppSettings, system: string, prompt: string): Promise<string> {
  const provider = curatorProvider(settings);
  if (provider === "openai-compatible" || provider === "local-http") {
    return invokeOpenAICompatibleCurator(settings, system, prompt);
  }
  if (provider === "bedrock") return invokeBedrockCurator(settings, system, prompt);
  throw new Error("memory curator provider is disabled");
}

async function embedTexts(settings: AppSettings, inputs: string[]): Promise<number[][]> {
  const dimensions = embeddingDimensions(settings);
  if (!inputs.length) return [];
  if (deterministicEmbeddingsEnabled(settings) && !isProviderConfigured(settings)) {
    return inputs.map((input) => deterministicEmbedding(input, dimensions));
  }
  const provider = embeddingProvider(settings);
  if (provider === "openai-compatible" || provider === "local-http") {
    return openAICompatibleEmbeddings(settings, inputs);
  }
  if (provider === "bedrock") {
    const vectors: number[][] = [];
    for (const input of inputs) vectors.push(await bedrockEmbedding(settings, input));
    return vectors;
  }
  return inputs.map((input) => deterministicEmbedding(input, dimensions));
}

async function noteContentForEntry(entry: MemoryIndexEntry): Promise<string> {
  try {
    const { getMemoryNote } = await import("./index");
    return (await getMemoryNote(entry.id))?.content ?? entry.excerpt;
  } catch {
    return entry.excerpt;
  }
}

async function loadIndexEntries(): Promise<MemoryIndexEntry[]> {
  const { buildMemoryIndex } = await import("./index");
  return (await buildMemoryIndex()).notes;
}

export async function enqueueMemoryEmbeddingRefresh(noteId: string, action: "refresh" | "delete" = "refresh"): Promise<void> {
  const queue = await readQueue();
  queue.items = [
    ...queue.items.filter((item) => item.noteId !== noteId),
    { noteId, action, queuedAt: new Date().toISOString() },
  ];
  await writeQueue(queue);
  scheduleMemoryEmbeddingQueue();
}

let queueScheduled = false;

function scheduleMemoryEmbeddingQueue(): void {
  if (queueScheduled) return;
  queueScheduled = true;
  setTimeout(() => {
    queueScheduled = false;
    void processMemoryEmbeddingQueue().catch(() => {});
  }, 25);
}

export async function processMemoryEmbeddingQueue(): Promise<MemoryEmbeddingsStatus> {
  const settings = await readAppSettings();
  const queue = await readQueue();
  if (!queue.items.length) return getMemoryEmbeddingsStatus({ settings });
  return rebuildMemoryEmbeddings({ settings });
}

export async function rebuildMemoryEmbeddings(opts: {
  settings?: AppSettings;
  entries?: MemoryIndexEntry[];
  force?: boolean;
} = {}): Promise<MemoryEmbeddingsStatus> {
  const settings = opts.settings ?? await readAppSettings();
  const entries = opts.entries ?? await loadIndexEntries();
  const existingChunks = await readMemoryEmbeddingChunks();
  const existingByNote = new Map<string, MemoryEmbeddingChunk[]>();
  for (const chunk of existingChunks) {
    existingByNote.set(chunk.noteId, [...(existingByNote.get(chunk.noteId) ?? []), chunk]);
  }
  const previousManifest = await readManifest(settings);
  const now = new Date().toISOString();
  const baseManifest: MemoryEmbeddingsManifest = {
    ...previousManifest,
    version: EMBEDDINGS_VERSION,
    provider: embeddingProvider(settings),
    model: embeddingModel(settings),
    dimensions: embeddingDimensions(settings),
    status: "indexing",
    updatedAt: now,
    queued: 0,
    lastError: undefined,
    noteHashes: {},
  };
  await writeManifest(baseManifest);

  try {
    const nextChunks: MemoryEmbeddingChunk[] = [];
    for (const entry of entries) {
      const content = await noteContentForEntry(entry);
      const hash = noteHash(entry, content, settings);
      const existing = existingByNote.get(entry.id) ?? [];
      if (!opts.force && existing.length && existing.every((chunk) => chunk.contentHash === hash)) {
        nextChunks.push(...existing);
        baseManifest.noteHashes[entry.id] = hash;
        continue;
      }
      const chunks = chunkMemoryEntry(entry, content, settings);
      const vectors = await embedTexts(settings, chunks.map((chunk) => chunk.text));
      nextChunks.push(...chunks.map((chunk, index) => ({ ...chunk, embedding: vectors[index] ?? [] })));
      baseManifest.noteHashes[entry.id] = hash;
    }

    await writeChunks(nextChunks);
    await writeQueue({ version: EMBEDDINGS_VERSION, items: [] });
    const done: MemoryEmbeddingsManifest = {
      ...baseManifest,
      status: embeddingProvider(settings) === "disabled" ? "disabled" : "idle",
      totalNotes: entries.length,
      totalChunks: nextChunks.length,
      updatedAt: new Date().toISOString(),
      queued: 0,
    };
    await writeManifest(done);
    return statusFromManifest(done, settings);
  } catch (err) {
    const failed: MemoryEmbeddingsManifest = {
      ...baseManifest,
      status: "error",
      totalNotes: entries.length,
      totalChunks: existingChunks.length,
      queued: (await readQueue()).items.length,
      updatedAt: new Date().toISOString(),
      lastError: err instanceof Error ? err.message : String(err),
    };
    await writeManifest(failed);
    return statusFromManifest(failed, settings);
  }
}

function statusFromManifest(manifest: MemoryEmbeddingsManifest, settings: AppSettings): MemoryEmbeddingsStatus {
  return {
    available: true,
    enabled: embeddingProvider(settings) !== "disabled",
    provider: embeddingProvider(settings),
    model: embeddingModel(settings),
    dimensions: embeddingDimensions(settings),
    status: manifest.status,
    totalNotes: manifest.totalNotes,
    totalChunks: manifest.totalChunks,
    queued: manifest.queued,
    updatedAt: manifest.updatedAt,
    lastError: manifest.lastError,
    paths: {
      root: embeddingsRoot(),
      chunks: chunksPath(),
      manifest: manifestPath(),
      queue: queuePath(),
    },
  };
}

export async function getMemoryEmbeddingsStatus(opts: { settings?: AppSettings } = {}): Promise<MemoryEmbeddingsStatus> {
  const settings = opts.settings ?? await readAppSettings();
  const queue = await readQueue();
  const manifest = await readManifest(settings);
  return statusFromManifest({
    ...manifest,
    queued: queue.items.length,
  }, settings);
}

function cosine(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  if (!length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function scopeMatches(scope: MemoryScope, wanted?: MemoryScope, includeGlobal = true): boolean {
  if (!wanted) return true;
  if (wanted.kind === "global") return scope.kind === "global";
  if (scope.kind === "global") return includeGlobal;
  return scope.projectKey === wanted.projectKey;
}

export async function semanticSearchMemory(opts: SemanticSearchOptions): Promise<SemanticMemoryResult[]> {
  const settings = opts.settings ?? await readAppSettings();
  if (!opts.query.trim()) return [];
  if (embeddingProvider(settings) === "disabled" && !deterministicEmbeddingsEnabled(settings)) return [];

  const entryIds = new Set(opts.entries.map((entry) => entry.id));
  const wantedTags = (opts.tags ?? (opts.tag ? [opts.tag] : [])).map((tag) => tag.toLowerCase());
  const chunks = (await readMemoryEmbeddingChunks()).filter((chunk) => {
    if (!entryIds.has(chunk.noteId)) return false;
    if (!scopeMatches(chunk.scope, opts.scope, opts.includeGlobal)) return false;
    if (opts.type && chunk.type !== opts.type) return false;
    if (opts.types?.length && !opts.types.includes(chunk.type)) return false;
    if (wantedTags.length && !wantedTags.every((tag) => chunk.tags.some((entryTag) => entryTag.toLowerCase() === tag))) return false;
    return true;
  });
  if (!chunks.length) return [];

  const [queryVector] = await embedTexts(settings, [opts.query]);
  const bestByNote = new Map<string, SemanticMemoryResult>();
  for (const chunk of chunks) {
    const similarity = cosine(queryVector, chunk.embedding);
    const score = Math.max(0, similarity);
    const existing = bestByNote.get(chunk.noteId);
    if (!existing || score > existing.score) {
      bestByNote.set(chunk.noteId, {
        noteId: chunk.noteId,
        score,
        snippet: chunk.text.slice(0, 280),
        chunkId: chunk.id,
        reasons: [`semantic:${score.toFixed(3)}`],
      });
    }
  }

  return [...bestByNote.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 10);
}

export async function getSemanticGraphEdges(opts: {
  entries: MemoryIndexEntry[];
  settings?: AppSettings;
  threshold?: number;
  limit?: number;
}): Promise<Array<{ source: string; target: string; label: string; score: number }>> {
  const settings = opts.settings ?? await readAppSettings();
  if (embeddingProvider(settings) === "disabled" && !deterministicEmbeddingsEnabled(settings)) return [];
  const ids = new Set(opts.entries.map((entry) => entry.id));
  const chunks = (await readMemoryEmbeddingChunks()).filter((chunk) => ids.has(chunk.noteId));
  const bestChunkByNote = new Map<string, MemoryEmbeddingChunk>();
  for (const chunk of chunks) {
    if (!bestChunkByNote.has(chunk.noteId)) bestChunkByNote.set(chunk.noteId, chunk);
  }
  const notes = [...bestChunkByNote.values()];
  const edges: Array<{ source: string; target: string; label: string; score: number }> = [];
  for (let i = 0; i < notes.length; i += 1) {
    for (let j = i + 1; j < notes.length; j += 1) {
      const score = cosine(notes[i].embedding, notes[j].embedding);
      if (score >= (opts.threshold ?? SEMANTIC_EDGE_THRESHOLD)) {
        edges.push({ source: notes[i].noteId, target: notes[j].noteId, label: "semantic", score });
      }
    }
  }
  return edges.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 100);
}

function parseCuratorJson(raw: string): CuratorOp[] {
  const jsonStart = raw.indexOf("{");
  const jsonEnd = raw.lastIndexOf("}");
  const text = jsonStart >= 0 && jsonEnd > jsonStart ? raw.slice(jsonStart, jsonEnd + 1) : raw;
  const parsed = JSON.parse(text) as { ops?: unknown; operations?: unknown };
  const ops = Array.isArray(parsed.ops) ? parsed.ops : Array.isArray(parsed.operations) ? parsed.operations : [];
  return ops
    .filter((op): op is Record<string, unknown> => Boolean(op) && typeof op === "object" && !Array.isArray(op))
    .slice(0, 5)
    .map((op) => ({
      op: op.op === "merge" || op.op === "upsert" || op.op === "skip" ? op.op : "skip",
      targetId: typeof op.targetId === "string" ? op.targetId : typeof op.target_id === "string" ? op.target_id : undefined,
      title: typeof op.title === "string" ? op.title.trim() : undefined,
      type: MEMORY_TYPES.includes(op.type as MemoryType) ? op.type as MemoryType : undefined,
      content: typeof op.content === "string" ? op.content.trim() : undefined,
      tags: Array.isArray(op.tags) ? op.tags.filter((tag): tag is string => typeof tag === "string") : undefined,
      aliases: Array.isArray(op.aliases) ? op.aliases.filter((alias): alias is string => typeof alias === "string") : undefined,
    }));
}

export async function curateCapturedMemory(payload: CuratorPayload): Promise<{ skipped: boolean; applied: number; errors: string[] }> {
  const settings = await readAppSettings();
  if (!settings.memoryCuratorEnabled || curatorProvider(settings) === "disabled") {
    return { skipped: true, applied: 0, errors: [] };
  }

  const { searchMemory, getMemoryNote, upsertMemoryNote } = await import("./index");
  const candidates = await searchMemory({
    query: payload.text.slice(0, 2000),
    scope: payload.scope,
    includeGlobal: true,
    limit: 6,
    retrievalMode: settings.memoryRetrievalMode,
  }).catch(() => []);

  const system = [
    "You curate Saturn memory notes.",
    "Return only JSON with an ops array.",
    "Each op must be one of upsert, merge, or skip.",
    "Create or merge only durable facts, preferences, decisions, troubleshooting outcomes, and project knowledge.",
    "Do not store secrets, tokens, passwords, API keys, or transient chatter.",
    "Use at most 5 ops.",
  ].join(" ");
  const prompt = JSON.stringify({
    session: payload.sessionTitle,
    scope: payload.scope,
    transcript: payload.text.slice(0, 10_000),
    candidates: candidates.map((candidate) => ({
      id: candidate.note.id,
      title: candidate.note.title,
      type: candidate.note.type,
      snippet: candidate.snippet,
      score: candidate.score,
    })),
    schema: {
      ops: [
        {
          op: "upsert | merge | skip",
          targetId: "required for merge",
          title: "required for upsert",
          type: "Entities | Concepts | Projects | Decisions | Troubleshooting | Sessions",
          content: "Markdown memory note body",
          tags: ["short-tags"],
          aliases: ["optional aliases"],
        },
      ],
    },
  });

  const errors: string[] = [];
  let ops: CuratorOp[] = [];
  try {
    ops = parseCuratorJson(await invokeCurator(settings, system, prompt));
  } catch (err) {
    return { skipped: false, applied: 0, errors: [err instanceof Error ? err.message : String(err)] };
  }

  let applied = 0;
  for (const op of ops) {
    if (op.op === "skip") continue;
    try {
      if (op.op === "merge" && op.targetId) {
        const existing = await getMemoryNote(op.targetId);
        if (!existing) continue;
        await upsertMemoryNote({
          id: existing.id,
          title: existing.title,
          type: existing.type,
          scope: existing.scope,
          tags: [...existing.tags, ...(op.tags ?? [])],
          aliases: [...existing.aliases, ...(op.aliases ?? [])],
          metadata: payload.metadata,
          updated_at: payload.capturedAt,
          content: [
            existing.content.trimEnd(),
            "",
            `## Curated update ${payload.capturedAt}`,
            "",
            op.content ?? "",
          ].join("\n").trimEnd(),
        });
        applied += 1;
      } else if (op.op === "upsert" && op.title && op.content) {
        await upsertMemoryNote({
          title: op.title,
          type: op.type ?? "Concepts",
          scope: payload.scope,
          tags: op.tags ?? [],
          aliases: op.aliases ?? [],
          metadata: payload.metadata,
          updated_at: payload.capturedAt,
          content: op.content,
        });
        applied += 1;
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  return { skipped: false, applied, errors };
}

export async function curateMemorySession(input: { sessionId?: string; session_id?: string }): Promise<unknown> {
  const sessionId = input.sessionId ?? input.session_id;
  if (!sessionId) throw new Error("sessionId is required");
  const { getSession } = await import("../runs");
  const { captureMemoryFromTurn } = await import("./index");
  const session = await getSession(sessionId);
  if (!session) throw new Error("session not found");
  const turn = session.meta.turns?.at(-1);
  if (!turn) throw new Error("session has no turns");
  return captureMemoryFromTurn({
    session,
    meta: session.meta,
    events: session.events,
    stderr: session.stderr,
    turn,
    turn_id: turn.turn_id,
    cwd: session.meta.agent_snapshot?.cwd,
  });
}
