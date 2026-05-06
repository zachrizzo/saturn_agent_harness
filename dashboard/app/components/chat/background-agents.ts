import type { StreamEvent } from "@/lib/events";
import type { SessionMeta } from "@/lib/runs";

export type BackgroundSubAgent = {
  id: string;
  title: string;
  startedAt?: string;
};

export type BackgroundAgentStatus = "run" | "ok" | "err" | "stop";

export type BackgroundSubAgentRow = BackgroundSubAgent & {
  status: BackgroundAgentStatus;
  activityOrder: number;
  updatedAt?: string;
};

export type BackgroundRunSnapshot = {
  status: SessionMeta["status"];
  finished_at?: string;
  latestTurnStatus?: SessionMeta["turns"][number]["status"];
};

export type BackgroundActivityRow = {
  id: string;
  title: string;
  status: BackgroundAgentStatus;
  kind: "session" | "agent";
  startedAt?: string;
  updatedAt?: string;
  activityOrder?: number;
};

export function backgroundStatusLabel(status: BackgroundAgentStatus): string {
  if (status === "run") return "running";
  if (status === "ok") return "done";
  if (status === "stop") return "stopped";
  return "failed";
}

export function backgroundActivityDismissKey(row: Pick<BackgroundActivityRow, "id" | "kind">): string {
  return `${row.kind}:${row.id}`;
}

function backgroundActivityTime(row: Pick<BackgroundActivityRow, "startedAt" | "updatedAt">): number {
  const value = row.updatedAt ?? row.startedAt;
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

export function sortBackgroundActivityRows<T extends BackgroundActivityRow>(rows: T[]): T[] {
  const statusRank: Record<BackgroundAgentStatus, number> = {
    run: 0,
    err: 1,
    stop: 2,
    ok: 3,
  };

  return [...rows].sort((a, b) => {
    const statusDelta = statusRank[a.status] - statusRank[b.status];
    if (statusDelta !== 0) return statusDelta;

    const timeDelta = backgroundActivityTime(b) - backgroundActivityTime(a);
    if (timeDelta !== 0) return timeDelta;

    const orderDelta = (b.activityOrder ?? Number.NEGATIVE_INFINITY)
      - (a.activityOrder ?? Number.NEGATIVE_INFINITY);
    if (orderDelta !== 0) return orderDelta;

    return a.title.localeCompare(b.title);
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function subAgentTitleFromInput(input: unknown): string {
  const record = asRecord(input);
  const description = typeof record.description === "string" ? record.description.trim() : "";
  if (description) return description;
  const subagentType = typeof record.subagent_type === "string" ? record.subagent_type.trim() : "";
  if (subagentType) return subagentType;
  return "Sub-agent";
}

function isBackgroundAgentToolUse(event: Extract<StreamEvent, { kind: "tool_use" }>): boolean {
  if (event.name !== "Agent") return false;
  const input = asRecord(event.input);
  const raw = asRecord(event.raw);
  return input.background === true
    || (raw.type === "system" && raw.subtype === "task_started" && raw.task_type === "local_agent");
}

function backgroundAgentStatus(
  result: Extract<StreamEvent, { kind: "tool_result" }> | undefined,
): BackgroundAgentStatus {
  if (!result) return "run";
  const content = asRecord(result.content);
  const status = typeof content.status === "string" ? content.status : "";
  if (status === "canceled" || status === "cancelled" || status === "stopped") return "stop";
  return result.isError ? "err" : "ok";
}

export function backgroundRunStatus(
  status: SessionMeta["status"] | undefined,
  latestTurnStatus?: SessionMeta["turns"][number]["status"],
): BackgroundAgentStatus {
  if (latestTurnStatus === "aborted") return "stop";
  if (status === "success" || status === "idle") return "ok";
  if (status === "failed") return "err";
  return "run";
}

export function backgroundSubAgentRows(
  agents: Record<string, BackgroundSubAgent>,
  events: StreamEvent[],
): BackgroundSubAgentRow[] {
  const rowsById = new Map<string, BackgroundSubAgent>();
  const toolUses = new Map<string, Extract<StreamEvent, { kind: "tool_use" }>>();
  const results = new Map<string, Extract<StreamEvent, { kind: "tool_result" }>>();
  const activityOrderById = new Map<string, number>();

  for (const agent of Object.values(agents)) {
    rowsById.set(agent.id, agent);
  }
  events.forEach((event, index) => {
    if (event.kind === "tool_use" && event.name === "Agent") {
      toolUses.set(event.id, event);
      activityOrderById.set(event.id, index);
      if (isBackgroundAgentToolUse(event) && !rowsById.has(event.id)) {
        rowsById.set(event.id, { id: event.id, title: subAgentTitleFromInput(event.input) });
      }
    }
    if (event.kind === "tool_result") {
      activityOrderById.set(event.toolUseId, index);
      if (!(event as { parentToolUseId?: string }).parentToolUseId) {
        results.set(event.toolUseId, event);
      }
    }
  });

  return Array.from(rowsById.values()).map((agent) => {
    const toolUse = toolUses.get(agent.id);
    const result = results.get(agent.id);
    return {
      ...agent,
      title: toolUse ? subAgentTitleFromInput(toolUse.input) : agent.title,
      status: backgroundAgentStatus(result),
      activityOrder: activityOrderById.get(agent.id) ?? Number.NEGATIVE_INFINITY,
      updatedAt: agent.startedAt,
    };
  });
}
