import Link from "next/link";
import { Card, Chip } from "@/app/components/ui";
import type { Task } from "@/lib/tasks";

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const PRIORITY_CLASS: Record<string, string> = {
  critical: "priority priority-critical",
  high: "priority priority-high",
  medium: "priority priority-medium",
  low: "priority priority-low",
};

type Props = { tasks: Task[] };

function statusLabel(s: Task["status"]): string {
  if (s === "in_progress") return "in progress";
  return s;
}

export function TasksWidget({ tasks }: Props) {
  const open = tasks.filter((t) => t.status !== "done" && t.status !== "cancelled");
  const openTotal = open.length;
  const top = open
    .slice()
    .sort(
      (a, b) => (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9),
    )
    .slice(0, 5);

  if (openTotal === 0) {
    return (
      <Card className="p-4">
        <div className="flex items-baseline justify-between mb-1">
          <div className="flex items-center gap-2">
            <h2 className="text-[15px] font-semibold tracking-tight">Open tasks</h2>
            <Chip>0</Chip>
          </div>
          <Link href="/tasks" className="text-[11.5px] text-muted hover:text-fg">
            View all →
          </Link>
        </div>
        <div className="text-[12px] text-subtle">No open tasks.</div>
      </Card>
    );
  }

  return (
    <Card className="p-0 overflow-hidden">
      <div className="flex items-center justify-between px-[14px] py-[10px] border-b border-border">
        <div className="flex items-center gap-2">
          <h2 className="text-[15px] font-semibold tracking-tight">Open tasks</h2>
          <Chip>{openTotal}</Chip>
        </div>
        <Link href="/tasks" className="text-[11.5px] text-muted hover:text-fg">
          View all →
        </Link>
      </div>
      <div>
        {top.map((t) => (
          <Link key={t.id} href={`/tasks/${t.id}`} className="task-row">
            <span className={PRIORITY_CLASS[t.priority] ?? "priority priority-low"}>
              {t.priority}
            </span>
            <span className="title">{t.title}</span>
            <span
              className="mono text-[11px] truncate"
              style={{ color: "var(--text-muted)" }}
            >
              {t.linked_job_name ?? t.created_by}
            </span>
            <span
              className="text-[11px] text-right"
              style={{ color: "var(--text-subtle)" }}
            >
              {statusLabel(t.status)}
            </span>
          </Link>
        ))}
      </div>
    </Card>
  );
}
