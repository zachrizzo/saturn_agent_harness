import {
  listJobs,
  listRuns,
  listRunTokenSummaries,
  listSessions,
  listSessionTokenSummaries,
  type RunMeta,
  type TokenUsageSummary,
} from "@/lib/runs";
import { listTasks } from "@/lib/tasks";
import { formatTokens } from "@/lib/format";
import { dailyTokenSeries, detectIssues } from "@/lib/analytics";
import { runMissedJobCatchUps } from "@/lib/missed-job-catchup";
import { AutoRefresh } from "./auto-refresh";
import { NowStrip } from "./components/dashboard/NowStrip";
import { KpiRow } from "./components/dashboard/KpiRow";
import { RecentChatsRail } from "./components/dashboard/RecentChatsRail";
import { IssuesCallout } from "./components/dashboard/IssuesCallout";
import { JobsTable } from "./components/dashboard/JobsTable";
import { TokensChart } from "./components/dashboard/TokensChart";
import { TasksWidget } from "./components/dashboard/TasksWidget";

export const revalidate = 0;
export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;

function usageStartMs(r: TokenUsageSummary): number {
  const t = r.started_at ? new Date(r.started_at).getTime() : 0;
  return Number.isFinite(t) && t > 0 ? t : 0;
}

function tokensDelta(records: TokenUsageSummary[]): string {
  const now = Date.now();
  let last24 = 0;
  let prev24 = 0;
  for (const r of records) {
    const t = usageStartMs(r);
    if (!t) continue;
    const tokens = r.total_tokens ?? 0;
    if (now - t <= DAY_MS) last24 += tokens;
    else if (now - t <= 2 * DAY_MS) prev24 += tokens;
  }
  if (prev24 === 0) return last24 > 0 ? "first 24h of data" : "—";
  const delta = ((last24 - prev24) / prev24) * 100;
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta.toFixed(0)}% vs yesterday`;
}

export default async function DashboardPage() {
  await runMissedJobCatchUps().catch((err) => {
    console.error("missed job catch-up failed", err);
  });

  const [jobs, allRuns, runTokenSummaries, sessions, sessionTokenSummaries, tasks] = await Promise.all([
    listJobs(),
    listRuns(),
    listRunTokenSummaries(),
    listSessions({ compactMeta: true }),
    listSessionTokenSummaries(),
    listTasks(),
  ]);

  // Index runs by job (already newest-first from listRuns).
  const runsByJob: Record<string, RunMeta[]> = {};
  for (const r of allRuns) {
    (runsByJob[r.name] ??= []).push(r);
  }

  // Restrict stats to the last 24h — dashboard is about recent health.
  const now = Date.now();
  const runs24h = allRuns.filter((r) => {
    const t = usageStartMs(r);
    return t > 0 && now - t <= DAY_MS;
  });
  const finished24h = runs24h.filter((r) => r.status !== "running");
  const successCount = finished24h.filter((r) => r.status === "success").length;
  const successRate = finished24h.length
    ? Math.round((successCount / finished24h.length) * 100)
    : 0;
  const tokenUsageRecords: TokenUsageSummary[] = [
    ...runTokenSummaries,
    ...sessionTokenSummaries,
  ];
  const tokenUsage24h = tokenUsageRecords.filter((r) => {
    const t = usageStartMs(r);
    return t > 0 && now - t <= DAY_MS;
  });
  const tokens24h = tokenUsage24h.reduce((acc, r) => acc + (r.total_tokens ?? 0), 0);

  // Live state
  const runningRuns = allRuns.filter((r) => r.status === "running");
  const runningSessions = sessions.filter((s) => s.status === "running");
  const runningNow = runningRuns.length + runningSessions.length;

  // Analytics
  const { data: tokenData, sources: tokenSources } = dailyTokenSeries(tokenUsageRecords, 30);
  const issues = detectIssues(jobs, runsByJob);

  // Limit runs per job for the table sparkline (last 24).
  const runsByJob24: Record<string, RunMeta[]> = {};
  for (const [name, list] of Object.entries(runsByJob)) {
    runsByJob24[name] = list.slice(0, 24);
  }

  const openTaskCount = tasks.filter(
    (t) => t.status !== "done" && t.status !== "cancelled",
  ).length;

  return (
    <div className="space-y-[18px]">
      <AutoRefresh intervalMs={10000} />

      <header>
        <h1 className="text-[22px] font-semibold tracking-tight">Control plane</h1>
        <p className="text-[13px] text-muted mt-1">
          {jobs.length} {jobs.length === 1 ? "agent" : "agents"} · {runningNow} running · {openTaskCount} open {openTaskCount === 1 ? "task" : "tasks"}
        </p>
      </header>

      <NowStrip
        runningRuns={runningRuns}
        runningSessions={runningSessions}
        jobs={jobs}
      />

      <KpiRow
        runningNow={runningNow}
        successRate={successRate}
        runs24h={runs24h.length}
        failingJobs={issues.failing.length}
        totalJobs={jobs.length}
        tokens={formatTokens(tokens24h)}
        tokensDelta={tokensDelta(tokenUsageRecords)}
      />

      <IssuesCallout stale={issues.stale} failing={issues.failing} />

      <section>
        <div className="sect-head">
          <h2>Recent chats</h2>
          <span className="right">Your agent conversations</span>
        </div>
        <RecentChatsRail sessions={sessions} />
      </section>

      <section>
        <div className="sect-head">
          <h2>Open tasks</h2>
          <span className="right">From all agents</span>
        </div>
        <TasksWidget tasks={tasks} />
      </section>

      <section>
        <div className="sect-head">
          <h2>Scheduled jobs</h2>
          <span className="right">{jobs.length} active</span>
        </div>
        <JobsTable jobs={jobs} runsByJob={runsByJob24} />
      </section>

      <section>
        <div className="sect-head">
          <h2>Tokens over time</h2>
          <span className="right">last 30 days</span>
        </div>
        <TokensChart data={tokenData} sources={tokenSources} />
      </section>
    </div>
  );
}
