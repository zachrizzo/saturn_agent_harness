"use client";

import { IconBash, IconEdit, IconRead, IconSearch, IconDoc } from "@/app/components/shell/icons";

export type ToolStatus = "ok" | "err" | "run";

export type ToolChipData = {
  /** Unique id (e.g. the tool_use id) used for selection state. */
  id: string;
  /** Canonical tool name (Read / Bash / Edit / Grep / WebFetch / …). */
  name: string;
  /** Raw tool input — rendered as a short inline args string. */
  input: unknown;
  /** Optional tool result for later inspection. */
  result?: unknown;
  /** `run` while the tool_use has no matching tool_result yet. */
  status: ToolStatus;
};

type Props = {
  tool: ToolChipData;
  active?: boolean;
  onClick?: () => void;
};

const ICON_CLS = "w-[14px] h-[14px]";

const TOOL_ICONS: Record<string, typeof IconRead> = {
  read: IconRead,
  bash: IconBash,
  edit: IconEdit,
  write: IconEdit,
  grep: IconSearch,
  glob: IconSearch,
  webfetch: IconDoc,
  websearch: IconDoc,
};

function ToolIcon({ name }: { name: string }) {
  const Icon = TOOL_ICONS[name.toLowerCase()] ?? IconBash;
  return <Icon className={ICON_CLS} />;
}

const STATUS_LABEL: Record<ToolStatus, string> = {
  ok: "ok",
  err: "err",
  run: "run",
};

function clipPreview(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function detailText(value: unknown, maxLength = 1_200): string {
  if (value === undefined || value === null || value === "") return "—";
  let raw: string | undefined;
  try {
    raw = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    raw = String(value);
  }
  if (!raw) return "—";
  return clipPreview(raw, maxLength);
}

/** Short human preview of a tool's input. Kept deterministic so the chip
 *  doesn't change width mid-stream. */
function previewArgs(name: string, input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return clipPreview(input, 80);
  if (typeof input !== "object") return String(input);
  const rec = input as Record<string, unknown>;
  const keys = Object.keys(rec);
  if (keys.length === 0) return "";
  // Pick a signature field per tool if available, else fall back to first key.
  const pref: Record<string, string[]> = {
    read: ["file_path", "path"],
    write: ["file_path", "path"],
    edit: ["file_path", "path"],
    bash: ["command"],
    grep: ["pattern", "path"],
    glob: ["pattern"],
    webfetch: ["url"],
  };
  const picks = pref[name.toLowerCase()] ?? [];
  for (const k of picks) {
    if (typeof rec[k] === "string") return `${k}: ${clipPreview(String(rec[k]), 120)}`;
  }
  const first = keys[0];
  const v = rec[first];
  if (typeof v === "string") return `${first}: ${clipPreview(v, 120)}`;
  return `${first}: ${JSON.stringify(v).slice(0, 60)}`;
}

export function ToolChip({ tool, active, onClick }: Props) {
  const args = previewArgs(tool.name, tool.input);
  const detailId = `tool-detail-${tool.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  return (
    <span className="tool-chip-wrap">
      <button
        type="button"
        className={`tool-chip ${active ? "active" : ""}`.trim()}
        onClick={onClick}
        aria-describedby={detailId}
      >
        <span className="ic">
          <ToolIcon name={tool.name} />
        </span>
        <span className="name">{tool.name}</span>
        {args ? <span className="args">{args}</span> : null}
        <span className={`status-pill ${tool.status}`}>
          {tool.status === "run" && <span className="status-spinner" aria-hidden="true" />}
          {STATUS_LABEL[tool.status]}
        </span>
      </button>
      <span id={detailId} role="tooltip" className="tool-chip-tooltip">
        <span className="tool-chip-tooltip-head">
          <span className="tool-chip-tooltip-name">{tool.name}</span>
          <span className={`tool-chip-tooltip-status ${tool.status}`}>{STATUS_LABEL[tool.status]}</span>
        </span>
        <span className="tool-chip-tooltip-section">
          <span className="tool-chip-tooltip-label">Input</span>
          <code>{detailText(tool.input)}</code>
        </span>
        <span className="tool-chip-tooltip-section">
          <span className="tool-chip-tooltip-label">{tool.status === "err" ? "Result · error" : "Result"}</span>
          <code>{detailText(tool.result)}</code>
        </span>
      </span>
    </span>
  );
}
