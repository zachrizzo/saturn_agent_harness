import Link from "next/link";
import { notFound } from "next/navigation";
import { getTask, type TaskStatus } from "@/lib/tasks";

export const revalidate = 0;
export const dynamic = "force-dynamic";

const STATUS_CHIP: Record<TaskStatus, string> = {
  open: "chip text-[var(--accent)]",
  in_progress: "chip text-[var(--warn)]",
  done: "chip text-[var(--success)]",
  cancelled: "chip text-subtle",
};

const STATUS_LABELS: Record<TaskStatus, string> = {
  open: "Open",
  in_progress: "In Progress",
  done: "Done",
  cancelled: "Cancelled",
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
    second: "2-digit",
  }).format(new Date(iso));
}

export default async function TaskDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = await getTask(id).catch(() => null);
  if (!task) notFound();

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-2 text-[12px] text-muted">
        <Link href="/tasks" className="hover:text-fg transition-colors">Tasks</Link>
        <span>/</span>
        <span className="mono truncate max-w-[200px]">{task.id}</span>
      </div>

      <div className="card p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap mb-1">
              <span className={PRIORITY_CHIP[task.priority] ?? "priority priority-low"}>{task.priority}</span>
              <span className={STATUS_CHIP[task.status]}>{STATUS_LABELS[task.status]}</span>
            </div>
            <h1 className="text-[18px] font-semibold tracking-tight">{task.title}</h1>
          </div>
        </div>

        {task.description && (
          <p className="text-[13px] text-muted leading-relaxed">{task.description}</p>
        )}

        {task.notes && (
          <div className="rounded-lg border border-border bg-bg-subtle p-3">
            <div className="text-[11px] font-medium uppercase tracking-wider text-subtle mb-1">Notes</div>
            <p className="text-[13px] text-fg whitespace-pre-wrap">{task.notes}</p>
          </div>
        )}

        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-[12px]">
          <div>
            <div className="text-muted mb-0.5">Created by</div>
            <div className="mono truncate">{task.created_by}</div>
          </div>
          <div>
            <div className="text-muted mb-0.5">Created</div>
            <div>{formatDate(task.created_at)}</div>
          </div>
          <div>
            <div className="text-muted mb-0.5">Updated</div>
            <div>{formatDate(task.updated_at)}</div>
          </div>
          {task.linked_session_id && (
            <div>
              <div className="text-muted mb-0.5">Session</div>
              <Link href={`/chats/${task.linked_session_id}`} className="mono truncate text-accent hover:underline block">
                {task.linked_session_id.slice(0, 16)}…
              </Link>
            </div>
          )}
          {task.linked_job_name && (
            <div>
              <div className="text-muted mb-0.5">Job</div>
              <Link href={`/jobs/${encodeURIComponent(task.linked_job_name)}`} className="mono truncate text-accent hover:underline block">
                {task.linked_job_name}
              </Link>
            </div>
          )}
          {task.tags.length > 0 && (
            <div>
              <div className="text-muted mb-0.5">Tags</div>
              <div className="flex flex-wrap gap-1">
                {task.tags.map((tag) => (
                  <span key={tag} className="chip">{tag}</span>
                ))}
              </div>
            </div>
          )}
        </div>

        {task.claim && (
          <div className="rounded-lg border border-border bg-bg-subtle p-3 text-[12px]">
            <div className="text-[11px] font-medium uppercase tracking-wider text-subtle mb-1">Active claim</div>
            <div className="text-fg mono truncate">{task.claim.claimed_by}</div>
            <div className="text-muted mt-0.5">expires {formatDate(task.claim.expires_at)}</div>
          </div>
        )}
      </div>

      {task.activity.length > 0 && (
        <div className="card p-5 space-y-3">
          <div className="sect-head">
            <h2>Activity</h2>
            <span className="right">{task.activity.length}</span>
          </div>
          <div className="flex flex-col gap-2">
            {[...task.activity].reverse().map((entry, i) => (
              <div key={i} className="flex gap-3 text-[12px]">
                <span className="text-subtle shrink-0 w-[130px]">{formatDate(entry.ts)}</span>
                <span className="text-muted mono shrink-0">{entry.action}</span>
                <span className="text-fg truncate">{entry.detail}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
