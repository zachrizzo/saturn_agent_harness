import Link from "next/link";
import type { Job, RunMeta, SessionMeta } from "@/lib/runs";
import { nextFireTime } from "@/lib/format";

type Props = {
  runningRuns: RunMeta[];
  runningSessions: SessionMeta[];
  jobs: Job[];
};

function elapsed(startedAt: string): string {
  const ms = Date.now() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}m ${r}s`;
}

function lastPromptForSession(s: SessionMeta): string {
  const turns = s.turns ?? [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t?.user_message) return t.user_message.replace(/\s+/g, " ").trim();
  }
  return "(no prompt)";
}

/**
 * Live "what's running now" strip. Shows each currently-running job run and
 * interactive session, with an elapsed counter. Falls back to a quiet idle
 * line listing the next scheduled fire when nothing is active.
 */
export function NowStrip({ runningRuns, runningSessions, jobs }: Props) {
  const runs = runningRuns.map((r) => ({
    id: `run-${r.name}-${r.slug}`,
    agent: r.name,
    msg: "scheduled run",
    elapsed: elapsed(r.started_at),
    href: `/runs/${encodeURIComponent(r.name)}/${r.slug}`,
  }));
  const sessions = runningSessions.map((s) => ({
    id: `sess-${s.session_id}`,
    agent: s.agent_snapshot?.name ?? "Ad-hoc",
    msg: lastPromptForSession(s),
    elapsed: elapsed(s.started_at),
    href: `/chats/${s.session_id}`,
  }));
  const all = [...runs, ...sessions];

  if (all.length === 0) {
    // Find next job-by-cron to show a helpful idle state
    const upcoming = jobs
      .map((j) => {
        try {
          return { job: j, nextAt: new Date(nextFireTime(j.cron)).getTime() };
        } catch {
          return { job: j, nextAt: Number.POSITIVE_INFINITY };
        }
      })
      .filter((x) => Number.isFinite(x.nextAt))
      .sort((a, b) => a.nextAt - b.nextAt)[0];

    return (
      <div className="now-strip now-strip-quiet">
        <span
          className="inline-block w-2 h-2 rounded-full shrink-0"
          style={{ background: "var(--text-subtle)" }}
        />
        <span className="text-[12.5px] text-muted">
          No agents running.{" "}
          {upcoming ? (
            <>
              Next fire:{" "}
              <span className="mono">{upcoming.job.name}</span>{" "}
              <span className="text-subtle">
                · {nextFireTime(upcoming.job.cron)}
              </span>
            </>
          ) : (
            <>No scheduled jobs.</>
          )}
        </span>
      </div>
    );
  }

  return (
    <div className="now-strip">
      <span className="live-dot animate-pulse" />
      <span
        className="text-[12px] font-semibold text-muted shrink-0"
        style={{ letterSpacing: "0.04em", textTransform: "uppercase" }}
      >
        {all.length} running
      </span>
      <div className="live-runs">
        {all.map((r) => (
          <Link key={r.id} href={r.href} prefetch={false} className="live-pill" title={r.msg}>
            <span className="meter" />
            <span className="agent">{r.agent}</span>
            <span className="msg">{r.msg}</span>
            <span
              className="mono shrink-0"
              style={{ fontSize: 11, color: "var(--text-subtle)" }}
            >
              {r.elapsed}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
