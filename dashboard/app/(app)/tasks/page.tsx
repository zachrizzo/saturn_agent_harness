import Link from "next/link";
import { listTasks, type Task, type TaskStatus } from "@/lib/tasks";
import { CreateTaskButton } from "./CreateTaskButton";

export const revalidate = 0;
export const dynamic = "force-dynamic";

const STATUS_ORDER: TaskStatus[] = ["open", "in_progress", "done", "cancelled"];

const STATUS_LABELS: Record<TaskStatus, string> = {
  open: "Open",
  in_progress: "In Progress",
  done: "Done",
  cancelled: "Cancelled",
};

const STATUS_CHIP: Record<TaskStatus, string> = {
  open: "chip text-[var(--accent)]",
  in_progress: "chip text-[var(--warn)]",
  done: "chip text-[var(--success)]",
  cancelled: "chip text-subtle",
};

const PRIORITY_CHIP: Record<string, string> = {
  critical: "priority priority-critical",
  high: "priority priority-high",
  medium: "priority priority-medium",
  low: "priority priority-low",
};

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export default async function TasksPage() {
  const tasks = await listTasks().catch(() => [] as Task[]);

  const byStatus = Object.fromEntries(
    STATUS_ORDER.map((s) => [s, tasks.filter((t) => t.status === s)]),
  ) as Record<TaskStatus, Task[]>;

  const open = byStatus.open.length + byStatus.in_progress.length;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Tasks</h1>
          <p className="text-[13px] text-muted mt-1">
            {open > 0 ? `${open} open task${open !== 1 ? "s" : ""}` : "No open tasks"}
            {tasks.length > open ? ` · ${tasks.length - open} completed/cancelled` : ""}
          </p>
        </div>
        <CreateTaskButton />
      </header>

      {tasks.length === 0 ? (
        <div className="card p-8 text-center text-[13px] text-muted">
          No tasks yet. Create one here or let agents add tasks during runs.
        </div>
      ) : (
        <div className="space-y-6">
          {STATUS_ORDER.filter((s) => byStatus[s].length > 0).map((status) => (
            <section key={status}>
              <div className="sect-head mb-3">
                <h2>{STATUS_LABELS[status]}</h2>
                <span className="right">{byStatus[status].length}</span>
              </div>
              <div className="flex flex-col gap-2">
                {byStatus[status].map((task) => (
                  <Link
                    key={task.id}
                    href={`/tasks/${task.id}`}
                    className="card p-4 hover:border-accent/40 transition-colors"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={PRIORITY_CHIP[task.priority] ?? "priority priority-low"}>
                            {task.priority}
                          </span>
                          <span className="text-[13px] font-medium text-fg truncate">{task.title}</span>
                        </div>
                        {task.description && (
                          <p className="text-[12px] text-muted mt-1 line-clamp-2">{task.description}</p>
                        )}
                        <div className="flex flex-wrap gap-3 mt-2 text-[11px] text-subtle">
                          {task.linked_session_id && (
                            <span>session: <span className="mono">{task.linked_session_id.slice(0, 8)}</span></span>
                          )}
                          {task.linked_job_name && (
                            <span>job: <span className="mono">{task.linked_job_name}</span></span>
                          )}
                          <span>by <span className="mono">{task.created_by.slice(0, 8)}</span></span>
                          <span>{formatDate(task.updated_at)}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <span className={STATUS_CHIP[task.status]}>{STATUS_LABELS[task.status]}</span>
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
