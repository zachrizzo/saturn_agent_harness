"use client";

import Link from "next/link";
import { useState, useEffect, useRef } from "react";
import { toEvents } from "@/lib/events";
import type { Job, RunMeta, CLI } from "@/lib/runs";
import { Card, Chip } from "@/app/components/ui";
import { PlayButton } from "@/app/components/PlayButton";
import { JobSettingsModal } from "@/app/components/JobSettingsModal";
import { GeneratedOutputView } from "@/app/components/generated-ui/GeneratedOutputView";
import { RunSparkline } from "./RunSparkline";
import { formatDuration, formatTokens, nextFireTime } from "@/lib/format";
import {
  successRate,
  statusVariant,
  rateToneClass,
  relativeTime,
} from "@/lib/job-helpers";

type Props = {
  job: Job;
  runs: RunMeta[];
  latestOutput: string;
};

const OUTPUT_PREVIEW_LINES = 6;

export function JobCard({ job, runs, latestOutput }: Props): JSX.Element {
  const [collapsed, setCollapsed] = useState(false);
  const [outputExpanded, setOutputExpanded] = useState(false);

  const lastRun = runs[0];

  // Live output streaming for active runs
  const [liveOutput, setLiveOutput] = useState(latestOutput);
  const [liveStatus, setLiveStatus] = useState<RunMeta["status"] | undefined>(lastRun?.status);
  const seenRef = useRef(new Set<string>());

  useEffect(() => {
    setLiveOutput(latestOutput);
    setLiveStatus(lastRun?.status);
    seenRef.current.clear();
  }, [latestOutput, lastRun?.status, lastRun?.slug]);

  useEffect(() => {
    if (!lastRun || lastRun.status !== "running") return;
    const url = `/api/runs/${encodeURIComponent(lastRun.name)}/${encodeURIComponent(lastRun.slug)}/stream`;
    const es = new EventSource(url);

    es.onmessage = (e) => {
      let obj: Record<string, unknown>;
      try { obj = JSON.parse(e.data); } catch { return; }

      if (obj.type === "_meta") {
        const m = obj.meta as RunMeta;
        setLiveStatus(m.status);
        es.close();
        return;
      }

      const key = JSON.stringify(obj);
      if (seenRef.current.has(key)) return;
      seenRef.current.add(key);

      const evs = toEvents(obj);
      for (let i = evs.length - 1; i >= 0; i--) {
        const ev = evs[i];
        if (ev.kind === "assistant_text") {
          setLiveOutput(ev.text);
          break;
        }
      }
    };

    es.onerror = () => es.close();
    return () => es.close();
  }, [lastRun?.slug, lastRun?.status]);

  const effectiveStatus = liveStatus ?? lastRun?.status;
  const rate = successRate(runs);
  const chipVariant = statusVariant(effectiveStatus);
  const rateTone = rateToneClass(rate, runs.length > 0);

  const trimmedOutput = liveOutput.trim();
  const outputLines = trimmedOutput.split("\n");
  const outputPreview = outputLines.slice(0, OUTPUT_PREVIEW_LINES).join("\n");
  const hasMoreOutput = outputLines.length > OUTPUT_PREVIEW_LINES;

  return (
    <Card className="flex flex-col gap-0 overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-3">
        <button
          onClick={() => setCollapsed((v) => !v)}
          className="flex items-center gap-2 min-w-0 flex-1 text-left group"
          title={collapsed ? "Expand" : "Collapse"}
        >
          <ChevronIcon collapsed={collapsed} />
          <span className="text-[15px] font-semibold text-fg group-hover:text-accent transition-colors truncate">
            {job.name}
          </span>
          <Chip
            variant={chipVariant}
            dot={!!lastRun}
            className={`shrink-0 ${effectiveStatus === "running" ? "animate-pulse" : ""}`}
          >
            {effectiveStatus ?? "idle"}
          </Chip>
          {effectiveStatus === "running" && (
            <svg className="w-3 h-3 shrink-0 text-[var(--warn)] animate-spin" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          )}
        </button>
        <div className="flex items-center gap-1.5 shrink-0">
          <JobSettingsModal
            jobName={job.name}
            currentCron={job.cron}
            currentModel={job.model}
            currentCli={job.cli as CLI | undefined}
            currentReasoningEffort={job.reasoningEffort}
            currentCatchUpMissedRuns={job.catchUpMissedRuns}
          />
          <PlayButton jobName={job.name} />
        </div>
      </div>

      {collapsed && (
        <div className="px-4 pb-3 border-t border-border pt-2 flex items-center justify-between gap-3">
          <span className="text-[12px] text-muted truncate min-w-0">
            {job.description ?? <span className="text-subtle italic">No description</span>}
          </span>
          <div className="flex items-center gap-3 shrink-0 text-[11px] text-subtle">
            {lastRun && (
              <span className={effectiveStatus === "success" ? "text-[var(--success)]" : effectiveStatus === "failed" ? "text-[var(--fail)]" : ""}>
                {relativeTime(lastRun.finished_at ?? lastRun.started_at)}
              </span>
            )}
            <span className="mono">{job.cron}</span>
          </div>
        </div>
      )}

      {!collapsed && (
        <>
          {job.description && (
            <div className="px-4 pb-2 -mt-1">
              <p className="text-[12px] text-muted line-clamp-2 leading-relaxed">{job.description}</p>
            </div>
          )}

          <div className="grid grid-cols-4 border-t border-b border-border divide-x divide-border">
            <Stat label="Success" value={runs.length ? `${rate}%` : "—"} valueClass={rateTone} />
            <Stat label="Last run" value={lastRun ? relativeTime(lastRun.finished_at ?? lastRun.started_at) : "never"} />
            <Stat label="Duration" value={formatDuration(lastRun?.duration_ms)} />
            <Stat label="Tokens" value={formatTokens(lastRun?.total_tokens)} />
          </div>

          <div className="flex items-center justify-between px-4 py-2.5 gap-4 border-t border-border">
            <div className="flex items-center gap-3 min-w-0">
              <RunSparkline runs={runs} slots={24} width={100} height={16} />
              <span className="mono text-[10px] text-subtle truncate">{job.cron}</span>
            </div>
            <div className="text-[11px] text-right shrink-0">
              <span className="text-subtle">next </span>
              <span className="text-muted">{nextFireTime(job.cron)}</span>
            </div>
          </div>

          <OutputSection
            trimmedOutput={trimmedOutput}
            outputPreview={outputPreview}
            hasMoreOutput={hasMoreOutput}
            expanded={outputExpanded}
            onToggle={() => setOutputExpanded((v) => !v)}
            onExpand={() => setOutputExpanded(true)}
          />

          <div className="border-t border-border px-4 py-2 flex justify-end">
            <Link
              href={`/jobs/${encodeURIComponent(job.name)}`}
              className="text-[11px] text-accent hover:underline"
            >
              view all runs &rarr;
            </Link>
          </div>
        </>
      )}
    </Card>
  );
}

// -- Sub-components -----------------------------------------------------------

type OutputSectionProps = {
  trimmedOutput: string;
  outputPreview: string;
  hasMoreOutput: boolean;
  expanded: boolean;
  onToggle: () => void;
  onExpand: () => void;
};

function OutputSection({
  trimmedOutput,
  outputPreview,
  hasMoreOutput,
  expanded,
  onToggle,
  onExpand,
}: OutputSectionProps): JSX.Element {
  if (!trimmedOutput) {
    return (
      <div className="border-t border-border px-4 py-3 text-[12px] text-subtle italic">
        No output from latest run.
      </div>
    );
  }

  return (
    <div className="border-t border-border">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-4 py-2 text-[11px] text-subtle hover:text-fg transition-colors"
      >
        <span className="uppercase tracking-wider font-medium">Latest output</span>
        <span>{expanded ? "hide ↑" : "show ↓"}</span>
      </button>
      {expanded ? (
        <div className="px-4 pb-4">
          <div className="text-[12px] leading-relaxed max-h-[320px] overflow-y-auto">
            <GeneratedOutputView markdown={trimmedOutput} />
          </div>
        </div>
      ) : (
        <div className="px-4 pb-3">
          <div className="text-[12px] leading-relaxed text-muted line-clamp-3">
            <GeneratedOutputView markdown={outputPreview} />
          </div>
          {hasMoreOutput && (
            <button
              onClick={onExpand}
              className="text-[11px] text-accent hover:underline mt-1"
            >
              show more
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function ChevronIcon({ collapsed }: { collapsed: boolean }): JSX.Element {
  return (
    <svg
      className={`w-3.5 h-3.5 shrink-0 text-subtle transition-transform ${collapsed ? "-rotate-90" : ""}`}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

type StatProps = {
  label: string;
  value: string;
  valueClass?: string;
};

function Stat({ label, value, valueClass }: StatProps): JSX.Element {
  return (
    <div className="flex flex-col items-center py-2.5 px-2 gap-0.5">
      <span className="text-[10px] uppercase tracking-wider text-subtle">{label}</span>
      <span className={`text-[13px] font-semibold tabular-nums ${valueClass ?? "text-fg"}`}>{value}</span>
    </div>
  );
}
