"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import parser from "cron-parser";
import type { Job, RunMeta, CLI } from "@/lib/runs";
import { formatDuration, formatTokens, nextFireTime } from "@/lib/format";
import { rateColorVar, statusVariant, successRate, relativeTime } from "@/lib/job-helpers";
import { JobSettingsModal } from "@/app/components/JobSettingsModal";
import { PlayButton } from "@/app/components/PlayButton";
import { RunSparkline } from "@/app/components/dashboard/RunSparkline";
import { Card, Chip, Input } from "@/app/components/ui";
import { toClaudeAlias } from "@/lib/claude-models";
import { CLI_SHORT_LABELS, DEFAULT_CLI, normalizeCli } from "@/lib/clis";

type Props = {
  jobs: Job[];
  runsByJob: Record<string, RunMeta[]>;
  allRuns: RunMeta[];
};

type Filter = "all" | "attention" | "running" | "idle";
type Sort = "priority" | "recent" | "success" | "name";
type Health = "running" | "attention" | "healthy" | "idle";

const DAY_MS = 24 * 60 * 60 * 1000;

function startMs(run?: RunMeta): number {
  if (!run?.started_at) return 0;
  const t = new Date(run.started_at).getTime();
  return Number.isFinite(t) ? t : 0;
}

function nextRunMs(cron: string): number {
  try {
    return parser.parseExpression(cron).next().toDate().getTime();
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function healthFor(runs: RunMeta[], rate: number): Health {
  const latest = runs[0];
  if (latest?.status === "running") return "running";
  if (!runs.length) return "idle";
  if (latest?.status === "failed" || rate < 80) return "attention";
  return "healthy";
}

function healthLabel(health: Health): string {
  if (health === "running") return "Running";
  if (health === "attention") return "Needs attention";
  if (health === "idle") return "No runs";
  return "Healthy";
}

function healthVariant(health: Health): "success" | "warn" | "fail" | "default" {
  if (health === "healthy") return "success";
  if (health === "running") return "warn";
  if (health === "attention") return "fail";
  return "default";
}

export function JobsWorkspace({ jobs, runsByJob, allRuns }: Props): JSX.Element {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("priority");

  const now = Date.now();
  const runs24h = allRuns.filter((r) => {
    const t = startMs(r);
    return t > 0 && now - t <= DAY_MS;
  });
  const runningNow = allRuns.filter((r) => r.status === "running");
  const failed24h = runs24h.filter((r) => r.status === "failed");
  const finished24h = runs24h.filter((r) => r.status !== "running");
  const success24h = finished24h.filter((r) => r.status === "success").length;
  const rate24h = finished24h.length ? Math.round((success24h / finished24h.length) * 100) : 0;

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return jobs
      .map((job) => {
        const runs = runsByJob[job.name] ?? [];
        const latest = runs[0];
        const rate = successRate(runs);
        const health = healthFor(runs, rate);
        const haystack = `${job.name} ${job.description ?? ""} ${job.cron} ${job.cli ?? ""} ${job.model ?? ""}`.toLowerCase();
        return { job, runs, latest, rate, health, haystack };
      })
      .filter((row) => {
        if (q && !row.haystack.includes(q)) return false;
        if (filter === "attention") return row.health === "attention";
        if (filter === "running") return row.health === "running";
        if (filter === "idle") return row.health === "idle";
        return true;
      })
      .sort((a, b) => {
        if (sort === "name") return a.job.name.localeCompare(b.job.name);
        if (sort === "success") return a.rate - b.rate;
        if (sort === "recent") return startMs(b.latest) - startMs(a.latest);
        const order: Record<Health, number> = { attention: 0, running: 1, idle: 2, healthy: 3 };
        return order[a.health] - order[b.health] || startMs(b.latest) - startMs(a.latest);
      });
  }, [filter, jobs, query, runsByJob, sort]);

  const attentionCount = jobs.filter((job) => {
    const runs = runsByJob[job.name] ?? [];
    return healthFor(runs, successRate(runs)) === "attention";
  }).length;
  const idleCount = jobs.filter((job) => (runsByJob[job.name] ?? []).length === 0).length;

  const nextJobs = [...jobs].sort((a, b) => nextRunMs(a.cron) - nextRunMs(b.cron)).slice(0, 5);
  const recentFailures = failed24h.slice(0, 5);

  return (
    <div className="jobs-workspace">
      <header className="jobs-hero">
        <div>
          <h1>Jobs</h1>
          <p>Watch scheduled automations, spot failures, and run the right job without digging.</p>
        </div>
        <div className="jobs-hero-meta">
          <Metric label="Scheduled" value={String(jobs.length)} />
          <Metric label="Running" value={String(runningNow.length)} tone={runningNow.length ? "warn" : undefined} />
          <Metric label="24h success" value={finished24h.length ? `${rate24h}%` : "—"} tone={rate24h >= 80 ? "success" : finished24h.length ? "fail" : undefined} />
        </div>
      </header>

      <div className="jobs-command">
        <div className="jobs-search">
          <SearchIcon />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by name, description, cron, CLI, or model"
            aria-label="Search jobs"
          />
        </div>
        <div className="jobs-controls" aria-label="Job filters">
          <FilterButton active={filter === "all"} onClick={() => setFilter("all")}>
            All {jobs.length}
          </FilterButton>
          <FilterButton active={filter === "attention"} tone="fail" onClick={() => setFilter("attention")}>
            Attention {attentionCount}
          </FilterButton>
          <FilterButton active={filter === "running"} tone="warn" onClick={() => setFilter("running")}>
            Running {runningNow.length}
          </FilterButton>
          <FilterButton active={filter === "idle"} onClick={() => setFilter("idle")}>
            No runs {idleCount}
          </FilterButton>
        </div>
      </div>

      <div className="jobs-layout">
        <section className="jobs-main">
          <div className="jobs-section-head">
            <div>
              <h2>Job queue</h2>
              <span>{rows.length} visible</span>
            </div>
            <label>
              <span>Sort</span>
              <select value={sort} onChange={(event) => setSort(event.target.value as Sort)}>
                <option value="priority">Priority</option>
                <option value="recent">Most recent</option>
                <option value="success">Lowest success</option>
                <option value="name">Name</option>
              </select>
            </label>
          </div>

          {jobs.length === 0 ? (
            <Card className="jobs-empty">
              <div>No scheduled jobs.</div>
              <p>
                Add one in <code className="chip">jobs/jobs.json</code> and run{" "}
                <code className="chip">bin/register-job.sh</code>.
              </p>
            </Card>
          ) : rows.length === 0 ? (
            <Card className="jobs-empty">
              <div>No jobs match this view.</div>
              <p>Clear the search or switch filters.</p>
            </Card>
          ) : (
            <Card className="jobs-table-card">
              <div className="jobs-table-head">
                <div>Job</div>
                <div>Health</div>
                <div>Recent runs</div>
                <div>Last run</div>
                <div>Next</div>
                <div>Actions</div>
              </div>
              <div className="jobs-table-body">
                {rows.map(({ job, runs, latest, rate, health }) => (
                  <JobRow
                    key={job.name}
                    job={job}
                    runs={runs}
                    latest={latest}
                    rate={rate}
                    health={health}
                  />
                ))}
              </div>
            </Card>
          )}
        </section>

        <aside className="jobs-side">
          <Card className="jobs-side-card">
            <div className="jobs-side-title">
              <h2>Next up</h2>
              <span>Scheduled order</span>
            </div>
            <div className="jobs-side-list">
              {nextJobs.length ? (
                nextJobs.map((job) => (
                  <Link key={job.name} href={`/jobs/${encodeURIComponent(job.name)}`} className="jobs-side-item">
                    <span>{job.name}</span>
                    <small>{nextFireTime(job.cron)}</small>
                  </Link>
                ))
              ) : (
                <div className="jobs-side-empty">No schedules configured.</div>
              )}
            </div>
          </Card>

          <Card className="jobs-side-card">
            <div className="jobs-side-title">
              <h2>Recent failures</h2>
              <span>Last 24h</span>
            </div>
            <div className="jobs-side-list">
              {recentFailures.length ? (
                recentFailures.map((run) => (
                  <Link key={`${run.name}-${run.slug}`} href={`/jobs/${encodeURIComponent(run.name)}`} className="jobs-side-item fail">
                    <span>{run.name}</span>
                    <small>{relativeTime(run.started_at)}</small>
                  </Link>
                ))
              ) : (
                <div className="jobs-side-empty">No failed runs in the last 24h.</div>
              )}
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}

type JobRowProps = {
  job: Job;
  runs: RunMeta[];
  latest?: RunMeta;
  rate: number;
  health: Health;
};

function JobRow({ job, runs, latest, rate, health }: JobRowProps): JSX.Element {
  const hasRuns = runs.length > 0;
  const lastTime = latest?.finished_at ?? latest?.started_at;
  const cli = normalizeCli(job.cli ?? DEFAULT_CLI);
  const modelLabel = [CLI_SHORT_LABELS[cli], job.model ? (toClaudeAlias(job.model) ?? job.model) : null].filter(Boolean).join(" · ");

  return (
    <div className="jobs-row">
      <div className="jobs-row-primary">
        <Link href={`/jobs/${encodeURIComponent(job.name)}`} className="jobs-row-name">
          {job.name}
        </Link>
        <p>{job.description || "No description"}</p>
        <div className="jobs-row-meta">
          <span className="mono">{job.cron}</span>
          <span>{modelLabel}</span>
          {job.timeout_seconds ? <span>{job.timeout_seconds}s timeout</span> : null}
        </div>
      </div>

      <div className="jobs-row-health">
        <Chip variant={healthVariant(health)} dot={health === "running"}>
          {healthLabel(health)}
        </Chip>
        <span style={{ color: hasRuns ? rateColorVar(rate) : "var(--text-subtle)" }}>
          {hasRuns ? `${rate}% success` : "waiting for first run"}
        </span>
      </div>

      <div className="jobs-row-spark">
        <RunSparkline runs={runs.slice(0, 24)} slots={24} width={116} height={18} />
        <span>{runs.length} total</span>
      </div>

      <div className="jobs-row-last">
        {latest ? (
          <>
            <Chip variant={statusVariant(latest.status)}>{latest.status}</Chip>
            <span>{relativeTime(lastTime)}</span>
            <small>
              {formatDuration(latest.duration_ms)} · {formatTokens(latest.total_tokens)}
            </small>
          </>
        ) : (
          <span className="text-subtle">Never run</span>
        )}
      </div>

      <div className="jobs-row-next">
        <span>{nextFireTime(job.cron)}</span>
      </div>

      <div className="jobs-row-actions">
        <JobSettingsModal
          jobName={job.name}
          currentModel={job.model}
          currentCli={job.cli as CLI | undefined}
          currentReasoningEffort={job.reasoningEffort}
        />
        <PlayButton jobName={job.name} />
      </div>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "success" | "warn" | "fail" }): JSX.Element {
  return (
    <div className={`jobs-metric ${tone ? `jobs-metric-${tone}` : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function FilterButton({
  active,
  tone,
  children,
  onClick,
}: {
  active: boolean;
  tone?: "warn" | "fail";
  children: ReactNode;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className={`jobs-filter ${active ? "active" : ""} ${tone ? `jobs-filter-${tone}` : ""}`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function SearchIcon(): JSX.Element {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="none">
      <path
        d="m14.5 14.5 3 3M8.75 15.5a6.75 6.75 0 1 1 0-13.5 6.75 6.75 0 0 1 0 13.5Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}
