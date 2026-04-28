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

/** Short human preview of a tool's input. Kept deterministic so the chip
 *  doesn't change width mid-stream. */
function previewArgs(name: string, input: unknown): string {
  if (input == null) return "";
  if (typeof input === "string") return input.slice(0, 80);
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
    if (typeof rec[k] === "string") return `${k}: ${String(rec[k])}`;
  }
  const first = keys[0];
  const v = rec[first];
  if (typeof v === "string") return `${first}: ${v}`;
  return `${first}: ${JSON.stringify(v).slice(0, 60)}`;
}

export function ToolChip({ tool, active, onClick }: Props) {
  const args = previewArgs(tool.name, tool.input);
  return (
    <button
      type="button"
      className={`tool-chip ${active ? "active" : ""}`.trim()}
      onClick={onClick}
      title={args || tool.name}
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
  );
}
