import { promises as fs } from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import readXlsxFile from "read-excel-file/universal";
import { getSessionMeta } from "@/lib/runs";
import { fileKindForPath, mimeTypeFor, resolveSessionFile } from "@/lib/session-files";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const MAX_TABLE_ROWS = 20_000;
const MAX_SPREADSHEET_BYTES = 20 * 1024 * 1024;

type TableSheet = {
  name: string;
  rows: string[][];
  rowCount: number;
  columnCount: number;
  truncated: boolean;
};

function cellToString(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return String(value);
}

function normalizeRows(rows: unknown[][]): TableSheet["rows"] {
  return rows
    .slice(0, MAX_TABLE_ROWS)
    .map((row) => row.map(cellToString));
}

function columnCount(rows: string[][]): number {
  return rows.reduce((max, row) => Math.max(max, row.length), 0);
}

function parseDelimited(text: string, delimiter: "," | "\t"): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (ch === "\"" && next === "\"") {
        field += "\"";
        i++;
      } else if (ch === "\"") {
        inQuotes = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === "\"") {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (ch === "\r" && next === "\n") i++;
      if (rows.length >= MAX_TABLE_ROWS) break;
      continue;
    }
    field += ch;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

async function readTextPreview(filePath: string, stats: Stats) {
  const handle = await fs.open(filePath, "r");
  try {
    const length = Math.min(stats.size, MAX_TEXT_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, 0);
    return {
      content: buffer.toString("utf8"),
      truncated: stats.size > MAX_TEXT_BYTES,
    };
  } finally {
    await handle.close();
  }
}

async function workbookSheets(filePath: string): Promise<TableSheet[]> {
  const buffer = await fs.readFile(filePath);
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const workbook = await readXlsxFile(arrayBuffer);

  return workbook.map(({ sheet: name, data }) => {
    const allRows = data as unknown[][];
    const rows = normalizeRows(allRows);
    return {
      name,
      rows,
      rowCount: allRows.length,
      columnCount: columnCount(rows),
      truncated: allRows.length > MAX_TABLE_ROWS,
    };
  });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSessionMeta(id);
  if (!session) return NextResponse.json({ error: "not found" }, { status: 404 });

  const rawPath = req.nextUrl.searchParams.get("path");
  if (!rawPath) return NextResponse.json({ error: "missing path" }, { status: 400 });

  const filePath = await resolveSessionFile(id, session.agent_snapshot?.cwd, rawPath);
  if (!filePath) return NextResponse.json({ error: "file not found" }, { status: 404 });

  const stats = await fs.stat(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const kind = fileKindForPath(filePath);
  const base = {
    kind,
    mimeType: mimeTypeFor(filePath),
    name: path.basename(filePath),
    path: rawPath,
    resolvedPath: filePath,
    size: stats.size,
  };

  if (kind === "text") {
    const preview = await readTextPreview(filePath, stats);
    return NextResponse.json({ ...base, ...preview });
  }

  if (kind === "csv") {
    const preview = await readTextPreview(filePath, stats);
    const delimiter = ext === ".tsv" ? "\t" : ",";
    const rows = parseDelimited(preview.content, delimiter);
    return NextResponse.json({
      ...base,
      delimiter,
      sheets: [{
        name: path.basename(filePath),
        rows,
        rowCount: rows.length,
        columnCount: columnCount(rows),
        truncated: preview.truncated || rows.length >= MAX_TABLE_ROWS,
      }],
    });
  }

  if (kind === "spreadsheet") {
    if (stats.size > MAX_SPREADSHEET_BYTES) {
      return NextResponse.json({
        ...base,
        error: `spreadsheet preview is limited to ${Math.floor(MAX_SPREADSHEET_BYTES / 1024 / 1024)} MB`,
      }, { status: 413 });
    }
    return NextResponse.json({
      ...base,
      sheets: await workbookSheets(filePath),
    });
  }

  return NextResponse.json(base);
}
