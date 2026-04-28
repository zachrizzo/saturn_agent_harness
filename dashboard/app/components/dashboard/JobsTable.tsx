import Link from "next/link";
import type { Job, RunMeta } from "@/lib/runs";
import { Card, Chip } from "@/app/components/ui";
import { nextFireTime } from "@/lib/format";
import { successRate, statusVariant, rateColorVar } from "@/lib/job-helpers";
import { PlayButton } from "@/app/components/PlayButton";
import { RunSparkline } from "./RunSparkline";

type Props = {
  jobs: Job[];
  runsByJob: Record<string, RunMeta[]>;
};

export function JobsTable({ jobs, runsByJob }: Props) {
  if (jobs.length === 0) {
    return (
      <Card className="p-8 text-center">
        <div className="text-muted mb-1">No scheduled jobs.</div>
        <div className="text-xs text-subtle">
          Add one in <code className="chip">jobs/jobs.json</code> and run{" "}
          <code className="chip">bin/register-job.sh</code>.
        </div>
      </Card>
    );
  }

  return (
    <Card className="jobs-grid p-0">
      <div className="thead">
        <div>Name</div>
        <div>Last 24</div>
        <div className="col-rate">Success</div>
        <div>Next fire</div>
        <div>Status</div>
        <div />
      </div>
      <div>
        {jobs.map((job) => {
          const runs = runsByJob[job.name] ?? [];
          const last = runs[0];
          const rate = successRate(runs);
          return (
            <div key={job.name} className="job-row">
              <div className="min-w-0">
                <Link href={`/jobs/${encodeURIComponent(job.name)}`} className="name">
                  {job.name}
                </Link>
                {job.description ? (
                  <div className="desc">{job.description}</div>
                ) : null}
              </div>
              <div className="flex items-center">
                <RunSparkline runs={runs} />
              </div>
              <div className="col-rate" style={{ color: runs.length ? rateColorVar(rate) : "var(--text-subtle)" }}>
                {runs.length ? `${rate}%` : "—"}
              </div>
              <div className="col-next">
                <span className="cron">{job.cron}</span>
                <span className="truncate">· {nextFireTime(job.cron)}</span>
              </div>
              <div>
                {last ? (
                  <Chip variant={statusVariant(last.status)} dot>
                    {last.status}
                  </Chip>
                ) : (
                  <Chip>idle</Chip>
                )}
              </div>
              <div className="flex justify-end">
                <PlayButton jobName={job.name} />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
