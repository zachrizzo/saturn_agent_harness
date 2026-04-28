"use client";

import Link from "next/link";
import { useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import type { Job, RunMeta } from "@/lib/runs";
import { JobSettingsModal } from "@/app/components/JobSettingsModal";
import { Button, Card, Chip } from "@/app/components/ui";
import { statusVariant } from "@/lib/job-helpers";
import { toClaudeAlias } from "@/lib/claude-models";
import { formatReasoningEffort } from "@/lib/models";
import { CLI_LABELS, DEFAULT_CLI, normalizeCli } from "@/lib/clis";

type SortField = "started_at" | "duration_ms" | "total_tokens" | "num_turns";
type SortDirection = "asc" | "desc";

type FormattedRun = RunMeta & {
  formattedStarted: string;
  formattedFinished: string;
  formattedDuration: string;
  formattedTokens: string;
  finalOutput: string;
};

type JobDetailClientProps = {
  job: Job;
  runs: FormattedRun[];
  nextFire: string;
  avgDuration: string;
  avgTokens: string;
};

export function JobDetailClient({ job, runs, nextFire, avgDuration, avgTokens }: JobDetailClientProps) {
  const [sortField, setSortField] = useState<SortField>("started_at");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [statusFilter, setStatusFilter] = useState<"all" | "success" | "failed" | "running">("all");
  const [page, setPage] = useState(0);
  const [promptExpanded, setPromptExpanded] = useState(false);
  const [expandedOutputs, setExpandedOutputs] = useState<Set<string>>(new Set());
  const pageSize = 20;

  const toggleOutput = (slug: string) => {
    setExpandedOutputs((prev) => {
      const s = new Set(prev);
      if (s.has(slug)) s.delete(slug);
      else s.add(slug);
      return s;
    });
  };

  const successCount = runs.filter((r) => r.status === "success").length;
  const failedCount = runs.filter((r) => r.status === "failed").length;
  const runningCount = runs.filter((r) => r.status === "running").length;
  const successRate = runs.length > 0 ? (successCount / runs.length) * 100 : 0;

  const last7Days = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const runsLast7Days = runs.filter((r) => new Date(r.started_at).getTime() > last7Days).length;

  const filteredRuns = useMemo(() => {
    if (statusFilter === "all") return runs;
    return runs.filter((r) => r.status === statusFilter);
  }, [runs, statusFilter]);

  const sortedRuns = useMemo(() => {
    const dir = sortDirection === "asc" ? 1 : -1;
    return [...filteredRuns].sort((a, b) => {
      const aVal = sortField === "started_at" ? a.started_at : a[sortField] ?? 0;
      const bVal = sortField === "started_at" ? b.started_at : b[sortField] ?? 0;
      if (aVal < bVal) return -1 * dir;
      if (aVal > bVal) return 1 * dir;
      return 0;
    });
  }, [filteredRuns, sortField, sortDirection]);

  const paginatedRuns = sortedRuns.slice(page * pageSize, (page + 1) * pageSize);
  const totalPages = Math.ceil(sortedRuns.length / pageSize);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDirection("desc");
    }
    setPage(0);
  };

  const getSortIcon = (field: SortField) => {
    if (sortField !== field) return <span className="text-subtle ml-0.5">↕</span>;
    return <span className="ml-0.5">{sortDirection === "asc" ? "↑" : "↓"}</span>;
  };

  const maxDuration = Math.max(...runs.map((run) => run.duration_ms ?? 0));

  function getRateTone(): "success" | "warn" | "fail" | "default" {
    if (runs.length === 0) return "default";
    if (successRate >= 80) return "success";
    if (successRate >= 50) return "warn";
    return "fail";
  }
  const rateTone = getRateTone();

  const modelDisplay = job.model ? (toClaudeAlias(job.model) ?? job.model) : "default";
  const effortDisplay = formatReasoningEffort(job.reasoningEffort);
  const cliDisplay = CLI_LABELS[normalizeCli(job.cli ?? DEFAULT_CLI)];

  return (
    <div className="space-y-[18px]">
      <nav className="text-[12px]">
        <Link href="/jobs" className="text-muted hover:text-fg transition">
          ← all jobs
        </Link>
      </nav>

      <header className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="eyebrow">Job</div>
          <h1 className="text-[22px] font-semibold tracking-tight mt-1">{job.name}</h1>
          {job.description ? (
            <p className="text-[13px] text-muted mt-2 max-w-3xl leading-relaxed">{job.description}</p>
          ) : null}
        </div>
        <JobSettingsModal
          jobName={job.name}
          currentModel={job.model}
          currentCli={job.cli}
          currentReasoningEffort={job.reasoningEffort}
        />
      </header>

      {/* Summary KPIs */}
      <section>
        <div className="sect-head">
          <h2>Summary</h2>
          <span className="right">
            {runs.length} total {runs.length === 1 ? "run" : "runs"}
          </span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-[10px]">
          <Kpi
            label="Success rate"
            value={runs.length ? `${Math.round(successRate)}%` : "—"}
            tone={rateTone}
            delta={`${successCount} ok · ${failedCount} failed`}
          />
          <Kpi label="Avg duration" value={avgDuration} />
          <Kpi label="Avg tokens" value={avgTokens} />
          <Kpi label="Last 7 days" value={String(runsLast7Days)} delta={`${runsLast7Days === 1 ? "run" : "runs"}`} />
        </div>
      </section>

      {/* Job Config — always visible, key info at a glance */}
      <section>
        <div className="sect-head">
          <h2>Configuration</h2>
        </div>
        <Card>
          <div className="p-4 space-y-4 text-sm">
            {/* Always-visible key facts */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Stat label="cron" value={<span className="mono text-xs">{job.cron}</span>} />
              <Stat label="next fire" value={<span className="text-xs">{nextFire}</span>} />
              <Stat label="model" value={<span className="text-xs">{modelDisplay}</span>} />
              <Stat label="effort" value={<span className="text-xs">{effortDisplay}</span>} />
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-3 border-t border-border">
              <Stat label="timeout" value={<span className="text-xs">{job.timeout_seconds ? `${job.timeout_seconds}s` : "1800s"}</span>} />
              <Stat label="cli" value={<span className="text-xs">{cliDisplay}</span>} />
              {job.cwd && (
                <div className="col-span-2">
                  <Stat label="working dir" value={<span className="mono text-xs text-muted break-all">{job.cwd}</span>} />
                </div>
              )}
            </div>

            {job.allowedTools && job.allowedTools.length > 0 && (
              <div className="pt-3 border-t border-border">
                <div className="label mb-2">allowed tools ({job.allowedTools.length})</div>
                <div className="flex flex-wrap gap-1.5">
                  {job.allowedTools.map((t) => (
                    <Chip key={t} className="mono text-[10px]">
                      {t.replace(/^mcp__/, "")}
                    </Chip>
                  ))}
                </div>
              </div>
            )}

            <div className="pt-3 border-t border-border">
              <button
                onClick={() => setPromptExpanded(!promptExpanded)}
                className="label hover:text-fg transition flex items-center gap-1"
              >
                prompt {promptExpanded ? "↑" : "↓"}
              </button>
              {promptExpanded && (
                <pre className="whitespace-pre-wrap text-xs mt-3 text-muted leading-relaxed mono bg-bg-subtle rounded p-3 border border-border">
                  {job.prompt}
                </pre>
              )}
            </div>
          </div>
        </Card>
      </section>

      {/* Run History */}
      <section>
        <div className="sect-head">
          <h2>
            Run history <span className="text-subtle font-normal">({sortedRuns.length})</span>
          </h2>
          <div className="right flex gap-1.5 flex-wrap">
            <FilterPill active={statusFilter === "all"} onClick={() => { setStatusFilter("all"); setPage(0); }}>
              All ({runs.length})
            </FilterPill>
            <FilterPill active={statusFilter === "success"} onClick={() => { setStatusFilter("success"); setPage(0); }} tone="success">
              Success ({successCount})
            </FilterPill>
            <FilterPill active={statusFilter === "failed"} onClick={() => { setStatusFilter("failed"); setPage(0); }} tone="fail">
              Failed ({failedCount})
            </FilterPill>
            {runningCount > 0 && (
              <FilterPill active={statusFilter === "running"} onClick={() => { setStatusFilter("running"); setPage(0); }} tone="warn">
                Running ({runningCount})
              </FilterPill>
            )}
          </div>
        </div>

        <Card className="overflow-hidden">
          {/* Header row */}
          <div className="hidden md:grid grid-cols-[minmax(140px,1fr)_80px_140px_60px_80px_80px_48px] text-left text-subtle text-[10px] uppercase tracking-wider border-b border-border bg-bg-subtle">
            <button className="px-4 py-2.5 text-left hover:text-fg transition font-medium flex items-center gap-0.5" onClick={() => handleSort("started_at")}>
              Started{getSortIcon("started_at")}
            </button>
            <div className="px-3 py-2.5 font-medium">Status</div>
            <button className="px-3 py-2.5 text-left hover:text-fg transition font-medium flex items-center gap-0.5" onClick={() => handleSort("duration_ms")}>
              Duration{getSortIcon("duration_ms")}
            </button>
            <button className="px-3 py-2.5 text-left hover:text-fg transition font-medium flex items-center gap-0.5" onClick={() => handleSort("num_turns")}>
              Turns{getSortIcon("num_turns")}
            </button>
            <button className="px-3 py-2.5 text-left hover:text-fg transition font-medium flex items-center gap-0.5" onClick={() => handleSort("total_tokens")}>
              Tokens{getSortIcon("total_tokens")}
            </button>
            <div className="px-3 py-2.5 font-medium">Output</div>
            <div className="px-3 py-2.5" />
          </div>

          {paginatedRuns.length === 0 ? (
            <div className="px-4 py-10 text-center text-muted text-sm">
              {statusFilter === "all" ? "No runs yet." : `No ${statusFilter} runs.`}
            </div>
          ) : null}

          {paginatedRuns.map((r) => {
            const durationPercent = maxDuration > 0 ? ((r.duration_ms ?? 0) / maxDuration) * 100 : 0;
            const variant = statusVariant(r.status);
            const isExpanded = expandedOutputs.has(r.slug);
            const hasOutput = !!r.finalOutput.trim();
            return (
              <div key={r.slug} className="border-t border-border">
                {/* Desktop row */}
                <div className="hidden md:grid grid-cols-[minmax(140px,1fr)_80px_140px_60px_80px_80px_48px] items-center hover:bg-bg-hover transition">
                  <div className="px-4 py-3 text-muted text-xs tabular-nums">{r.formattedStarted}</div>
                  <div className="px-3 py-3">
                    <Chip variant={variant} dot className={r.status === "running" ? "animate-pulse" : ""}>
                      {r.status}
                    </Chip>
                  </div>
                  <div className="px-3 py-3">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 bg-bg-hover rounded-full overflow-hidden w-[50px] shrink-0">
                        <div className="h-full bg-accent rounded-full" style={{ width: `${durationPercent}%` }} />
                      </div>
                      <span className="tabular-nums text-xs text-muted">{r.formattedDuration}</span>
                    </div>
                  </div>
                  <div className="px-3 py-3 tabular-nums text-xs text-muted">{r.num_turns ?? "—"}</div>
                  <div className="px-3 py-3 tabular-nums text-xs text-muted">{r.formattedTokens}</div>
                  <div className="px-3 py-3">
                    {hasOutput ? (
                      <button
                        onClick={() => toggleOutput(r.slug)}
                        className="text-xs text-accent hover:underline"
                      >
                        {isExpanded ? "hide ↑" : "show ↓"}
                      </button>
                    ) : (
                      <span className="text-xs text-subtle">—</span>
                    )}
                  </div>
                  <div className="px-3 py-3 text-right">
                    <Link href={`/runs/${r.name}/${r.slug}`} className="text-accent hover:underline text-xs">
                      open →
                    </Link>
                  </div>
                </div>

                {/* Mobile row */}
                <div className="md:hidden px-4 py-3 flex items-start justify-between gap-3 hover:bg-bg-hover transition">
                  <div className="flex flex-col gap-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Chip variant={variant} dot className={r.status === "running" ? "animate-pulse" : ""}>
                        {r.status}
                      </Chip>
                      <span className="text-xs text-muted tabular-nums">{r.formattedStarted}</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-subtle">
                      <span>{r.formattedDuration}</span>
                      {r.num_turns != null && <span>{r.num_turns} turns</span>}
                      <span>{r.formattedTokens}</span>
                    </div>
                  </div>
                  <Link href={`/runs/${r.name}/${r.slug}`} className="text-accent hover:underline text-xs shrink-0 mt-1">
                    open →
                  </Link>
                </div>

                {isExpanded && hasOutput && (
                  <div className="px-4 pb-4 border-t border-border bg-bg-subtle">
                    <article className="prose-dashboard text-sm leading-relaxed pt-4 max-h-[500px] overflow-y-auto">
                      <ReactMarkdown>{r.finalOutput}</ReactMarkdown>
                    </article>
                  </div>
                )}
              </div>
            );
          })}
        </Card>

        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 mt-4">
            <Button size="sm" onClick={() => setPage(Math.max(0, page - 1))} disabled={page === 0}>
              Previous
            </Button>
            <span className="text-sm text-muted">
              Page {page + 1} of {totalPages}
              <span className="text-subtle ml-1">({sortedRuns.length} runs)</span>
            </span>
            <Button size="sm" onClick={() => setPage(Math.min(totalPages - 1, page + 1))} disabled={page >= totalPages - 1}>
              Next
            </Button>
          </div>
        )}
      </section>
    </div>
  );
}

type KpiTone = "default" | "success" | "warn" | "fail";
const KPI_TONE: Record<KpiTone, string> = {
  default: "",
  success: "kpi-success",
  warn: "kpi-warn",
  fail: "kpi-fail",
};
function Kpi({ label, value, tone = "default", delta }: { label: string; value: string; tone?: KpiTone; delta?: string }) {
  return (
    <div className={`kpi ${KPI_TONE[tone]}`}>
      <span className="accent-line" />
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {delta ? <div className="kpi-delta">{delta}</div> : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="label">{label}</span>
      <span>{value}</span>
    </div>
  );
}

function FilterPill({
  active,
  onClick,
  tone,
  children,
}: {
  active: boolean;
  onClick: () => void;
  tone?: "success" | "fail" | "warn";
  children: React.ReactNode;
}) {
  let cls = "px-2.5 py-1 rounded text-xs border transition-colors ";
  if (active) {
    if (tone === "success") cls += "bg-[color-mix(in_srgb,var(--success)_10%,transparent)] border-[color-mix(in_srgb,var(--success)_25%,transparent)] text-[var(--success)]";
    else if (tone === "fail") cls += "bg-[color-mix(in_srgb,var(--fail)_10%,transparent)] border-[color-mix(in_srgb,var(--fail)_25%,transparent)] text-[var(--fail)]";
    else if (tone === "warn") cls += "bg-[color-mix(in_srgb,var(--warn)_10%,transparent)] border-[color-mix(in_srgb,var(--warn)_25%,transparent)] text-[var(--warn)]";
    else cls += "bg-accent-soft border-[color-mix(in_srgb,var(--accent)_30%,transparent)] text-accent";
  } else {
    cls += "bg-bg-elev border-border text-muted hover:text-fg hover:bg-bg-hover";
  }
  return (
    <button type="button" onClick={onClick} className={cls}>
      {children}
    </button>
  );
}
