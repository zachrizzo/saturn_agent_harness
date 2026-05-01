import { promises as fs } from "node:fs";
import path from "node:path";
import { sessionDir } from "./runs";

export type SavedSessionUpload = {
  name: string;
  path: string;
  size: number;
  type: string;
};

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+/, "") || "attachment";
}

export async function saveSessionUploads(sessionId: string, files: File[]): Promise<SavedSessionUpload[]> {
  if (files.length === 0) return [];

  const uploadDir = path.join(sessionDir(sessionId), "uploads");
  await fs.mkdir(uploadDir, { recursive: true });

  const saved: SavedSessionUpload[] = [];
  for (const [index, file] of files.entries()) {
    const name = `${Date.now()}-${index}-${safeName(file.name)}`;
    const abs = path.join(uploadDir, name);
    await fs.writeFile(abs, Buffer.from(await file.arrayBuffer()));
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
  return `${message}\n\n[Attached files - read them with the Read tool]\n${lines.join("\n")}`;
}
