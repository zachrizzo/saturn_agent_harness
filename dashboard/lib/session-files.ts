import { promises as fs } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import { sessionDir } from "@/lib/runs";

export const MIME_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".csv": "text/csv; charset=utf-8",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif",
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".json": "application/json; charset=utf-8",
  ".m4a": "audio/mp4",
  ".md": "text/markdown; charset=utf-8",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".oga": "audio/ogg",
  ".ogg": "audio/ogg",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".svg": "image/svg+xml",
  ".tsv": "text/tab-separated-values; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xml": "application/xml; charset=utf-8",
  ".yaml": "text/yaml; charset=utf-8",
  ".yml": "text/yaml; charset=utf-8",
};

const IMAGE_EXTS = new Set([".avif", ".bmp", ".gif", ".jpg", ".jpeg", ".png", ".svg", ".webp"]);
const AUDIO_EXTS = new Set([".m4a", ".mp3", ".oga", ".ogg", ".wav"]);
const VIDEO_EXTS = new Set([".mov", ".mp4", ".webm"]);
const TEXT_EXTS = new Set([
  ".c", ".cpp", ".cs", ".css", ".go", ".graphql", ".gql", ".h", ".hpp",
  ".htm", ".html", ".java", ".js", ".jsx", ".json", ".jsonc", ".kt",
  ".less", ".lua", ".md", ".mdx", ".ml", ".php", ".prisma", ".py", ".r",
  ".rb", ".rs", ".sass", ".scala", ".scss", ".sh", ".sql", ".svelte",
  ".swift", ".toml", ".ts", ".tsx", ".txt", ".vue", ".xml", ".yaml",
  ".yml", ".zsh",
]);

export type SessionFileKind =
  | "audio"
  | "binary"
  | "csv"
  | "image"
  | "pdf"
  | "spreadsheet"
  | "text"
  | "video";

export function extOf(filePath: string): string {
  const base = path.basename(filePath).toLowerCase();
  if (base === "dockerfile") return ".dockerfile";
  return path.extname(base);
}

export function mimeTypeFor(filePath: string): string {
  return MIME_TYPES[extOf(filePath)] ?? "application/octet-stream";
}

export function fileKindForPath(filePath: string): SessionFileKind {
  const ext = extOf(filePath);
  if (ext === ".pdf") return "pdf";
  if (ext === ".csv" || ext === ".tsv") return "csv";
  if (ext === ".xlsx") return "spreadsheet";
  if (IMAGE_EXTS.has(ext)) return "image";
  if (AUDIO_EXTS.has(ext)) return "audio";
  if (VIDEO_EXTS.has(ext)) return "video";
  if (TEXT_EXTS.has(ext) || ext === ".dockerfile") return "text";
  return "binary";
}

export function isInspectableFilePath(filePath: string): boolean {
  return fileKindForPath(filePath) !== "binary" || [".doc", ".docx", ".ppt", ".pptx"].includes(extOf(filePath));
}

async function existingRealpath(candidate: string): Promise<string | null> {
  try {
    const stats = await fs.stat(candidate);
    if (!stats.isFile()) return null;
    return await fs.realpath(candidate);
  } catch {
    return null;
  }
}

async function allowedRoots(id: string, cwd: string | undefined): Promise<string[]> {
  const roots = [sessionDir(id), cwd, path.join(process.cwd(), "public")].filter(
    (value): value is string => Boolean(value),
  );
  const realRoots = await Promise.all(
    roots.map(async (root) => {
      try {
        return await fs.realpath(root);
      } catch {
        return null;
      }
    }),
  );
  return realRoots.filter((root): root is string => root !== null);
}

function isWithinRoot(filePath: string, root: string): boolean {
  const relative = path.relative(root, filePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function stripFileUrl(rawPath: string): string {
  if (!rawPath.startsWith("file://")) return rawPath;
  try {
    return decodeURIComponent(new URL(rawPath).pathname);
  } catch {
    return rawPath;
  }
}

function candidatePaths(rawPath: string, roots: string[]): string[] {
  const requested = stripFileUrl(rawPath).trim();
  if (!requested) return [];

  const candidates = new Set<string>();
  if (path.isAbsolute(requested)) {
    candidates.add(path.resolve(requested));
    const relativeToProject = requested.replace(/^\/+/, "");
    for (const root of roots) {
      candidates.add(path.resolve(root, relativeToProject));
      candidates.add(path.resolve(root, "public", relativeToProject));
      candidates.add(path.resolve(root, "site", "public", relativeToProject));
    }
  } else {
    for (const root of roots) {
      candidates.add(path.resolve(root, requested));
    }
  }

  return Array.from(candidates);
}

const SEARCH_SKIP_DIRS = new Set([
  ".git",
  ".next",
  ".next-build",
  ".venv",
  "cache",
  "node_modules",
]);

function searchableSuffix(rawPath: string): string | null {
  const requested = stripFileUrl(rawPath).trim();
  if (!requested) return null;
  const suffix = requested.replace(/^[/\\]+/, "");
  if (!suffix || suffix === "." || suffix.split(/[\\/]+/).includes("..")) return null;
  return path.normalize(suffix);
}

function pathMatchesSuffix(relativePath: string, suffix: string): boolean {
  if (relativePath === suffix) return true;
  if (!suffix.includes(path.sep)) return path.basename(relativePath) === suffix;
  return relativePath.endsWith(`${path.sep}${suffix}`);
}

async function findBySuffix(roots: string[], rawPath: string): Promise<string | null> {
  const suffix = searchableSuffix(rawPath);
  if (!suffix) return null;
  const targetSuffix = suffix;
  const matches: string[] = [];

  async function walk(root: string, dir: string): Promise<void> {
    if (matches.length >= 20) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (matches.length >= 20) return;
      if (entry.isDirectory()) {
        if (SEARCH_SKIP_DIRS.has(entry.name)) continue;
        await walk(root, path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const candidate = path.join(dir, entry.name);
      const relative = path.relative(root, candidate);
      if (pathMatchesSuffix(relative, targetSuffix)) {
        const realCandidate = await existingRealpath(candidate);
        if (realCandidate && isWithinRoot(realCandidate, root)) matches.push(realCandidate);
      }
    }
  }

  for (const root of roots) await walk(root, root);
  matches.sort((a, b) => a.length - b.length || a.localeCompare(b));
  return matches[0] ?? null;
}

export async function resolveSessionFile(
  id: string,
  cwd: string | undefined,
  rawPath: string,
): Promise<string | null> {
  const roots = await allowedRoots(id, cwd);
  for (const candidate of candidatePaths(rawPath, roots)) {
    const realCandidate = await existingRealpath(candidate);
    if (!realCandidate) continue;
    if (roots.some((root) => isWithinRoot(realCandidate, root))) return realCandidate;
  }
  return findBySuffix(roots, rawPath);
}
