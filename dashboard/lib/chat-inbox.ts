import type { CLI, SessionMeta, TurnRecord } from "./runs";
import { isMultiCli } from "./session-utils";
import { normalizeCli } from "./clis";

export type InboxCli = CLI | "mixed" | "unknown";

export type InboxStatus = "running" | "success" | "failed" | "idle";

export type InboxTag = {
  kind: "tool" | "struct" | "warn" | "default";
  label: string;
};

export type InboxSession = {
  id: string;
  /** Headline used everywhere the session is listed — the first user message
   *  for ad-hoc chats, the agent name for saved agents. Never "Ad-hoc chat". */
  title: string;
  /** Underlying agent name (e.g. "Code Review Swarm" or "Ad-hoc"). Kept so we
   *  can still show the agent badge next to the title. */
  agent: string;
  cli: InboxCli;
  model: string | null;
  projectName: string | null;
  projectPath: string | null;
  preview: string;
  who: "you" | "agent";
  relTime: string;
  relMin: number;         // minutes since last activity
  lastActivityAt: string; // ISO
  lastFinishedAt: string | null; // ISO of last turn's finished_at; null while still running
  status: InboxStatus;
  turns: number;
  unread: boolean;
  pinned: boolean;
  archived: boolean;
  snoozedUntil: string | null;
  needsReply: boolean;
  tags: InboxTag[];
  multi: boolean;
  adHoc: boolean;
  /** True when the agent behind this session is an orchestrator / swarm. */
  isSwarm: boolean;
};

export type InboxBucket = {
  label: string;
  items: InboxSession[];
};

const CLI_GLYPHS: Record<CLI, string> = {
  "claude-bedrock": "B",
  "claude-personal": "P",
  "claude-local": "L",
  codex: "C",
};

export function cliGlyph(cli: InboxCli): string {
  if (cli === "mixed") return "∗";
  if (cli === "unknown") return "·";
  return CLI_GLYPHS[cli] ?? "?";
}

function pickCli(s: SessionMeta): InboxCli {
  if (isMultiCli(s)) return "mixed";
  const turns = s.turns ?? [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t?.cli) return normalizeCli(t.cli);
  }
  const explicit = s.agent_snapshot?.defaultCli ?? s.agent_snapshot?.cli;
  if (explicit) return normalizeCli(explicit);
  return "unknown";
}

function pickModel(s: SessionMeta): string | null {
  if (s.overrides?.model) return s.overrides.model;
  const agent = s.agent_snapshot;
  if (agent) {
    if (agent.model) return agent.model;
    const models = agent.models;
    if (models) {
      const first = Object.values(models).find((m): m is string => typeof m === "string");
      if (first) return first;
    }
  }
  const turns = s.turns ?? [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const model = turns[i]?.model;
    if (model) return model;
  }
  return null;
}

function lastTurn(s: SessionMeta): TurnRecord | undefined {
  const turns = s.turns ?? [];
  return turns[turns.length - 1];
}

function previewText(last: TurnRecord | undefined): { preview: string; who: "you" | "agent" } {
  if (!last) return { preview: "(no messages yet)", who: "agent" };
  const finalText = last.final_text?.trim();
  const userText = last.user_message?.trim();
  // "who sent last" — final text means agent answered last; otherwise user is waiting.
  if (finalText) {
    return { preview: finalText.replace(/\s+/g, " ").slice(0, 200), who: "agent" };
  }
  if (userText) {
    return { preview: userText.replace(/\s+/g, " ").slice(0, 200), who: "you" };
  }
  return { preview: "(no preview)", who: "agent" };
}

function lastActivityIso(s: SessionMeta, last: TurnRecord | undefined): string {
  return last?.finished_at ?? last?.started_at ?? s.started_at;
}

function projectNameFromCwd(cwd: string | undefined): string | null {
  const normalized = cwd?.trim().replace(/\\/g, "/");
  if (!normalized) return null;
  const parts = normalized.split("/").filter(Boolean);
  return parts.at(-1) ?? normalized;
}

export function formatRelative(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.round(mo / 12)}y`;
}

function deriveTags(
  s: SessionMeta,
  status: InboxStatus,
  multi: boolean,
  isSwarm: boolean,
): InboxTag[] {
  const tags: InboxTag[] = [];
  if (isSwarm) tags.push({ kind: "struct", label: "swarm" });
  if (status === "running") tags.push({ kind: "warn", label: "live" });
  if (status === "failed") tags.push({ kind: "warn", label: "failed" });
  if (multi) tags.push({ kind: "struct", label: "multi-CLI" });
  for (const label of s.tags ?? []) {
    tags.push({ kind: "default", label });
  }
  return tags;
}

/**
 * Pick the display title for a session. Priority:
 *   1. First user message (trimmed, single-lined, ~120 chars) — works for both
 *      ad-hoc and saved-agent sessions, matches what most chat UIs do.
 *   2. Agent name — if there are no turns yet (session just created).
 *   3. "New chat" — last-resort fallback.
 */
export function sessionTitle(s: SessionMeta): string {
  const turns = s.turns ?? [];
  for (const t of turns) {
    const msg = t?.user_message?.replace(/\s+/g, " ").trim();
    if (msg) {
      return msg.length > 120 ? msg.slice(0, 117) + "…" : msg;
    }
  }
  const name = s.agent_snapshot?.name;
  if (name && name !== "Ad-hoc chat") return name;
  return "New chat";
}

function isUnread(s: SessionMeta, last: TurnRecord | undefined): boolean {
  if (!last?.finished_at) return false;
  if (!s.read_at) return true;
  return new Date(last.finished_at).getTime() > new Date(s.read_at).getTime();
}

function isSnoozed(s: SessionMeta, nowMs: number): boolean {
  if (!s.snoozed_until) return false;
  const until = new Date(s.snoozed_until).getTime();
  return Number.isFinite(until) && until > nowMs;
}

export function toInboxSession(s: SessionMeta, nowMs: number = Date.now()): InboxSession {
  const last = lastTurn(s);
  const lastIso = lastActivityIso(s, last);
  const lastMs = new Date(lastIso).getTime();
  const relMin = Math.max(0, Math.round((nowMs - lastMs) / 60000));
  const multi = isMultiCli(s);
  const cli = pickCli(s);
  const { preview, who } = previewText(last);
  const needsReply = who === "agent" && s.status !== "running";
  const isSwarm = s.agent_snapshot?.kind === "orchestrator";
  const tags = deriveTags(s, s.status, multi, isSwarm);
  const projectPath = s.agent_snapshot?.cwd?.trim() || null;

  return {
    id: s.session_id,
    title: sessionTitle(s),
    isSwarm,
    agent: s.agent_snapshot?.name ?? "Ad-hoc",
    cli,
    model: pickModel(s),
    projectName: projectNameFromCwd(projectPath ?? undefined),
    projectPath,
    preview,
    who,
    relTime: formatRelative(nowMs - lastMs),
    relMin,
    lastActivityAt: lastIso,
    lastFinishedAt: last?.finished_at ?? null,
    status: s.status,
    turns: s.turns?.length ?? 0,
    unread: isUnread(s, last),
    pinned: Boolean(s.pinned),
    archived: Boolean(s.archived),
    snoozedUntil: s.snoozed_until ?? null,
    needsReply,
    tags,
    multi,
    adHoc: !s.agent_id,
  };
}

export function toInboxSessions(list: SessionMeta[], nowMs: number = Date.now()): InboxSession[] {
  const items = list
    .filter((s) => !isSnoozed(s, nowMs))
    .map((s) => toInboxSession(s, nowMs));
  items.sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return b.lastActivityAt.localeCompare(a.lastActivityAt);
  });
  return items;
}

export type FolderKey =
  | "all"
  | "needs-reply"
  | "live"
  | "failing"
  | "pinned"
  | "ad-hoc"
  | "from-agent"
  | "archived";

export const FOLDER_LABELS: Record<FolderKey, string> = {
  all: "All chats",
  "needs-reply": "Needs reply",
  live: "Live",
  failing: "Failing",
  pinned: "Pinned",
  "ad-hoc": "Ad-hoc",
  "from-agent": "From agent",
  archived: "Archived",
};

export function matchesFolder(s: InboxSession, folder: FolderKey): boolean {
  if (folder === "archived") return s.archived;
  if (s.archived) return false;
  switch (folder) {
    case "all":
      return true;
    case "needs-reply":
      return s.needsReply;
    case "live":
      return s.status === "running";
    case "failing":
      return s.status === "failed";
    case "pinned":
      return s.pinned;
    case "ad-hoc":
      return s.adHoc;
    case "from-agent":
      return !s.adHoc;
    default:
      return true;
  }
}

export function folderCounts(list: InboxSession[]): Record<FolderKey, number> {
  const keys = Object.keys(FOLDER_LABELS) as FolderKey[];
  const out = Object.fromEntries(keys.map((k) => [k, 0])) as Record<FolderKey, number>;
  for (const s of list) {
    for (const k of keys) {
      if (matchesFolder(s, k)) out[k] += 1;
    }
  }
  return out;
}

/**
 * Group sessions by age buckets, matching the design's time buckets.
 * `nowMs` is taken so both SSR and tests can pin time.
 */
export function bucketInboxSessions(items: InboxSession[], nowMs: number = Date.now()): InboxBucket[] {
  const startOfDay = new Date(nowMs);
  startOfDay.setHours(0, 0, 0, 0);
  const todayMs = startOfDay.getTime();
  const yesterdayMs = todayMs - 24 * 60 * 60 * 1000;
  const weekMs = todayMs - 6 * 24 * 60 * 60 * 1000;

  const buckets: Record<string, InboxSession[]> = {
    "Today · last hour": [],
    "Today": [],
    "Yesterday": [],
    "This week": [],
    "Older": [],
  };

  for (const s of items) {
    const ts = new Date(s.lastActivityAt).getTime();
    if (!Number.isFinite(ts)) {
      buckets["Older"].push(s);
      continue;
    }
    const diff = nowMs - ts;
    if (diff < 60 * 60 * 1000) buckets["Today · last hour"].push(s);
    else if (ts >= todayMs) buckets["Today"].push(s);
    else if (ts >= yesterdayMs) buckets["Yesterday"].push(s);
    else if (ts >= weekMs) buckets["This week"].push(s);
    else buckets["Older"].push(s);
  }

  return Object.entries(buckets)
    .filter(([, v]) => v.length > 0)
    .map(([label, v]) => ({ label, items: v }));
}
