import type { Agent, Job, SessionMeta } from "./runs";
import type { Task } from "./tasks";

export type CommandItemKind = "job" | "agent" | "chat" | "task" | "action";

export type CommandItem = {
  id: string;
  title: string;
  subtitle?: string;
  meta?: string;
  kind: CommandItemKind;
  href: string;
  keywords?: string[];
  /** Optional non-navigation handler (e.g. toggle theme). */
  action?: string;
};

function compact(value?: string | null, max = 180): string {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function firstUserMessage(s: SessionMeta): string {
  for (const turn of s.turns ?? []) {
    const msg = compact(turn.user_message, 140);
    if (msg) return msg;
  }
  const name = s.agent_snapshot?.name;
  return name && name !== "Ad-hoc chat" ? name : "New chat";
}

function lastPreview(s: SessionMeta): string {
  const turns = s.turns ?? [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const finalText = compact(turns[i]?.final_text, 180);
    if (finalText) return finalText;
    const userText = compact(turns[i]?.user_message, 180);
    if (userText) return userText;
  }
  return "";
}

function sessionSearchText(s: SessionMeta): string[] {
  const out: string[] = [
    s.session_id,
    s.agent_snapshot?.name ?? "",
    s.agent_snapshot?.cli ?? "",
    s.status,
    ...(s.tags ?? []),
  ];
  for (const turn of s.turns ?? []) {
    out.push(turn.user_message, turn.final_text ?? "", turn.model ?? "");
  }
  return out.filter(Boolean);
}

function formatDateLabel(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Build a flat, searchable command list from the loaded data. */
export function buildIndex(
  jobs: Job[],
  agents: Agent[],
  sessions: SessionMeta[],
  tasks: Task[] = []
): CommandItem[] {
  const items: CommandItem[] = [];

  // Built-in actions ------------------------------------------------------
  items.push({
    id: "action:home",
    title: "Home",
    subtitle: "Open the control plane",
    kind: "action",
    href: "/",
    keywords: ["home", "dashboard", "control", "plane"],
  });
  items.push({
    id: "action:new-chat",
    title: "New chat",
    subtitle: "Start an ad-hoc conversation",
    kind: "action",
    href: "/chats/new",
    keywords: ["new", "chat", "conversation", "compose", "start"],
  });
  items.push({
    id: "action:new-agent",
    title: "New agent",
    subtitle: "Create a new saved agent",
    kind: "action",
    href: "/agents/new",
    keywords: ["new", "agent", "create"],
  });
  items.push({
    id: "action:toggle-theme",
    title: "Theme: toggle",
    subtitle: "Cycle light / dark / system",
    kind: "action",
    href: "#",
    action: "toggle-theme",
    keywords: ["theme", "dark", "light", "appearance", "toggle"],
  });
  items.push({
    id: "action:all-chats",
    title: "All chats",
    subtitle: "Open the chat inbox",
    kind: "action",
    href: "/chats",
    keywords: ["all", "chats", "history", "inbox", "sessions"],
  });
  items.push({
    id: "action:tasks",
    title: "Tasks",
    subtitle: "Open task queue",
    kind: "action",
    href: "/tasks",
    keywords: ["tasks", "queue", "todo", "work"],
  });
  items.push({
    id: "action:new-task",
    title: "New task",
    subtitle: "Create a shared task",
    kind: "action",
    href: "/tasks?new=1",
    keywords: ["new", "task", "create", "ticket", "todo", "work"],
  });
  items.push({
    id: "action:settings",
    title: "Settings",
    subtitle: "Defaults, models, effort, MCP, and local config",
    kind: "action",
    href: "/settings",
    keywords: ["settings", "preferences", "defaults", "model", "models", "effort", "reasoning", "mcp", "config", "working directory"],
  });

  // Jobs ------------------------------------------------------------------
  for (const j of jobs) {
    items.push({
      id: `job:${j.name}`,
      title: j.name,
      subtitle: j.description ?? j.cron,
      meta: j.cron,
      kind: "job",
      href: `/jobs/${encodeURIComponent(j.name)}`,
      keywords: ["job", "cron", j.cron, j.cli ?? "", j.cwd ?? "", j.prompt ?? ""].filter(Boolean),
    });
  }

  // Agents ----------------------------------------------------------------
  for (const a of agents) {
    items.push({
      id: `agent:${a.id}`,
      title: a.name,
      subtitle: a.description ?? `${a.cli}${a.model ? " · " + a.model : ""}`,
      meta: a.kind === "orchestrator" ? "swarm" : a.defaultCli ?? a.cli,
      kind: "agent",
      href: `/agents/${encodeURIComponent(a.id)}/edit`,
      keywords: [
        "agent",
        a.id,
        a.prompt,
        a.cwd ?? "",
        a.defaultCli ?? "",
        ...(a.supportedClis ?? []),
        ...(a.cli ? [a.cli] : []),
        ...(a.tags ?? []),
      ].filter(Boolean),
    });
  }

  // Chats / sessions ------------------------------------------------------
  for (const s of sessions) {
    const turns = s.turns ?? [];
    if (turns.length === 0) continue;
    const title = firstUserMessage(s);
    const agentName = s.agent_snapshot?.name ?? "Ad-hoc chat";
    const lastTurn = turns[turns.length - 1];
    const updated = lastTurn?.finished_at ?? lastTurn?.started_at ?? s.started_at;
    items.push({
      id: `chat:${s.session_id}`,
      title,
      subtitle: lastPreview(s),
      meta: `${agentName.replace("Ad-hoc chat", "Ad-hoc")} · ${s.status}${formatDateLabel(updated) ? ` · ${formatDateLabel(updated)}` : ""}`,
      kind: "chat",
      href: `/chats/${s.session_id}`,
      keywords: ["chat", "session", ...sessionSearchText(s)].filter(Boolean),
    });
  }

  // Tasks -----------------------------------------------------------------
  for (const t of tasks) {
    items.push({
      id: `task:${t.id}`,
      title: t.title,
      subtitle: compact(t.description || t.notes, 180),
      meta: `${t.status} · ${t.priority}${formatDateLabel(t.updated_at) ? ` · ${formatDateLabel(t.updated_at)}` : ""}`,
      kind: "task",
      href: `/tasks/${t.id}`,
      keywords: [
        "task",
        t.id,
        t.status,
        t.priority,
        t.created_by,
        t.linked_job_name ?? "",
        t.linked_session_id ?? "",
        t.description,
        t.notes,
        ...(t.tags ?? []),
      ].filter(Boolean),
    });
  }

  return items;
}

/** Simple case-insensitive substring scorer across title + subtitle + keywords. */
export function scoreItem(item: CommandItem, query: string): number {
  if (!query) return 1;
  const q = query.trim().toLowerCase();
  if (!q) return 1;

  const title = item.title.toLowerCase();
  const subtitle = (item.subtitle ?? "").toLowerCase();
  const meta = (item.meta ?? "").toLowerCase();
  const kws = (item.keywords ?? []).join(" ").toLowerCase();
  const haystack = `${title} ${subtitle} ${meta} ${kws}`;

  const words = q.split(/\s+/).filter(Boolean);
  let score = 0;
  for (const w of words) {
    const tIdx = title.indexOf(w);
    const sIdx = subtitle.indexOf(w);
    const mIdx = meta.indexOf(w);
    const kIdx = kws.indexOf(w);
    if (tIdx === -1 && sIdx === -1 && mIdx === -1 && kIdx === -1) return 0;
    if (title === q) score += 300;
    if (title.startsWith(w)) score += 120;
    if (tIdx !== -1) score += 100 - Math.min(tIdx, 80);
    if (sIdx !== -1) score += 25 - Math.min(sIdx, 25);
    if (mIdx !== -1) score += 20 - Math.min(mIdx, 20);
    if (kIdx !== -1) score += 10;
  }
  if (haystack.includes(q)) score += 35;
  if (item.kind === "chat") score += 5;
  return score;
}

export function searchIndex(items: CommandItem[], query: string, limit = 30): CommandItem[] {
  const scored = items.map((i) => ({ i, s: scoreItem(i, query) })).filter((x) => x.s > 0);
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, limit).map((x) => x.i);
}
