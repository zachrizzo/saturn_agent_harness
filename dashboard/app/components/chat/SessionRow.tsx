"use client";

import Link from "next/link";
import type { MouseEvent } from "react";
import type { CLI, SessionMeta } from "@/lib/runs";
import { isMultiCli, getCliList } from "@/lib/session-utils";
import { formatRelative } from "@/lib/chat-inbox";
import { Chip } from "@/app/components/ui";
import { CLI_SHORT_LABELS, DEFAULT_CLI, normalizeCli } from "@/lib/clis";

type Props = {
  session: SessionMeta;
};

const CLI_COLORS: Record<CLI, { bg: string; fg: string }> = {
  "claude-bedrock": { bg: "rgba(59,130,246,0.15)", fg: "#3b82f6" },
  "claude-personal": { bg: "rgba(20,184,166,0.15)", fg: "#14b8a6" },
  "claude-local": { bg: "rgba(34,197,94,0.15)", fg: "#22c55e" },
  codex: { bg: "rgba(168,85,247,0.15)", fg: "#a855f7" },
};

const CLI_GLYPHS: Record<CLI, string> = {
  "claude-bedrock": "B",
  "claude-personal": "P",
  "claude-local": "L",
  codex: "C",
};

function sessionStatusVariant(status: SessionMeta["status"]): "fail" | "warn" | "success" {
  if (status === "failed") return "fail";
  if (status === "running") return "warn";
  return "success";
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  return formatRelative(Date.now() - then);
}

function documentNavigate(event: MouseEvent<HTMLAnchorElement>, href: string): void {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }
  event.preventDefault();
  window.location.assign(href);
}

export function SessionRow({ session }: Props) {
  const agentName = session.agent_snapshot?.name ?? "Ad-hoc";
  const firstUser = session.turns.find((t) => t.user_message)?.user_message ?? "";
  const preview = firstUser.replace(/\s+/g, " ").trim();
  const cli: CLI =
    normalizeCli(session.turns[0]?.cli ?? session.agent_snapshot?.cli ?? DEFAULT_CLI);
  const nTurns = session.turns.length;
  const lastTs =
    session.turns[session.turns.length - 1]?.started_at ?? session.started_at;
  const model = session.turns[session.turns.length - 1]?.model ?? session.agent_snapshot?.model;

  const multiCli = isMultiCli(session);
  const cliList = multiCli ? getCliList(session) : [];

  const colors = CLI_COLORS[cli] ?? CLI_COLORS[DEFAULT_CLI];
  const statusVariant = sessionStatusVariant(session.status);

  return (
    <Link
      href={`/chats/${session.session_id}`}
      prefetch={false}
      onClick={(event) => documentNavigate(event, `/chats/${session.session_id}`)}
      className="group grid gap-3 rounded-lg border border-border bg-bg-elev px-3.5 py-3 shadow-sm transition-colors hover:border-border-strong hover:bg-bg-subtle md:grid-cols-[1fr_auto] md:items-center"
    >
      <div className="flex min-w-0 items-start gap-3">
        <span
          className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[12px] font-semibold ring-1 ring-inset ring-current/10"
          style={{ background: colors.bg, color: colors.fg }}
          aria-hidden
        >
          {CLI_GLYPHS[cli]}
        </span>
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate text-[14px] font-medium text-fg">
              {agentName}
            </span>
            <Chip variant={statusVariant} dot className="capitalize">
              {session.status}
            </Chip>
          </div>
          <div className="mt-1 max-w-[70ch] truncate text-[13px] text-muted">
            {preview || <span className="text-subtle italic">no messages</span>}
          </div>
          {model && (
            <div className="mt-1 truncate text-[11px] text-subtle mono">
              {model}
            </div>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2 md:justify-end">
        {multiCli ? (
          <Chip variant="accent" className="text-[10px]">
            Multi-CLI ({cliList.length})
          </Chip>
        ) : (
          <Chip>{CLI_SHORT_LABELS[cli]}</Chip>
        )}
        <span className="text-[12px] text-muted tabular-nums">
          {nTurns} {nTurns === 1 ? "turn" : "turns"}
        </span>
        <span className="text-[12px] text-subtle tabular-nums w-10 text-right">
          {relativeTime(lastTs)}
        </span>
      </div>
    </Link>
  );
}
