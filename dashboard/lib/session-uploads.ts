import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { sessionDir } from "./runs";

export type SavedSessionUpload = {
  name: string;
  path: string;
  size: number;
  type: string;
};

const MAX_UPLOAD_FILES = Number(process.env.SATURN_MAX_UPLOAD_FILES || 8);
const MAX_UPLOAD_FILE_BYTES = Number(process.env.SATURN_MAX_UPLOAD_FILE_BYTES || 25 * 1024 * 1024);
const MAX_UPLOAD_TOTAL_BYTES = Number(process.env.SATURN_MAX_UPLOAD_TOTAL_BYTES || 50 * 1024 * 1024);

export class SessionUploadLimitError extends Error {
  readonly status = 413;
}

export function isSessionUploadLimitError(error: unknown): error is SessionUploadLimitError {
  return error instanceof SessionUploadLimitError;
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+/, "") || "attachment";
}

export async function saveSessionUploads(sessionId: string, files: File[]): Promise<SavedSessionUpload[]> {
  if (files.length === 0) return [];
  if (files.length > MAX_UPLOAD_FILES) {
    throw new SessionUploadLimitError(`too many files; maximum is ${MAX_UPLOAD_FILES}`);
  }

  let totalBytes = 0;
  for (const file of files) {
    if (file.size > MAX_UPLOAD_FILE_BYTES) {
      throw new SessionUploadLimitError(`${file.name || "file"} is too large; maximum is ${Math.floor(MAX_UPLOAD_FILE_BYTES / 1024 / 1024)} MB`);
    }
    totalBytes += file.size;
    if (totalBytes > MAX_UPLOAD_TOTAL_BYTES) {
      throw new SessionUploadLimitError(`attachments are too large; maximum total is ${Math.floor(MAX_UPLOAD_TOTAL_BYTES / 1024 / 1024)} MB`);
    }
  }

  const uploadDir = path.join(sessionDir(sessionId), "uploads");
  await fs.mkdir(uploadDir, { recursive: true });

  const saved: SavedSessionUpload[] = [];
  for (const [index, file] of files.entries()) {
    const name = `${Date.now()}-${index}-${safeName(file.name)}`;
    const abs = path.join(uploadDir, name);
    try {
      await pipeline(
        Readable.fromWeb(file.stream() as unknown as NodeReadableStream),
        createWriteStream(abs, { flags: "wx" }),
      );
    } catch (err) {
      await fs.rm(abs, { force: true }).catch(() => {});
      throw err;
    }
    saved.push({
      name: file.name,
      path: abs,
      size: file.size,
      type: file.type,
    });
  }

  return saved;
}

export function appendUploadReferences(message: string, uploads: SavedSessionUpload[]): string {
  if (uploads.length === 0) return message;
  const lines = uploads.map((file) => `- ${file.path}  (${file.name})`);
  return `${message}\n\n[Attached files - inspect them with the appropriate file or image tool]\n${lines.join("\n")}`;
}
