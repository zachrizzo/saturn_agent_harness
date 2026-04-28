import Link from "next/link";
import type { Job, RunMeta } from "@/lib/runs";
import { nextFireTime } from "@/lib/format";

type Props = {
  stale: Job[];
  failing: Array<{ job: Job; lastRun: RunMeta }>;
};

export function IssuesCallout({ stale, failing }: Props) {
  if (stale.length === 0 && failing.length === 0) return null;

  const failingSlice = failing.slice(0, 3);
  const staleSlice = stale.slice(0, 2);

  return (
    <section>
      <div className="sect-head">
        <h2>Needs attention</h2>
        <span className="right">
          {failing.length > 0 && `${failing.length} failing`}
          {failing.length > 0 && stale.length > 0 && " · "}
          {stale.length > 0 && `${stale.length} stale`}
        </span>
      </div>

      <div className="grid gap-[10px] grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
        {failingSlice.map(({ job, lastRun }) => (
          <Link
            key={`fail-${job.name}`}
            href={`/runs/${encodeURIComponent(job.name)}/${lastRun.slug}`}
            className="callout callout-fail"
          >
            <div className="flex items-center justify-between">
              <span className="eyebrow" style={{ color: "var(--fail)" }}>
                Failing
              </span>
              <span className="subtle text-[10.5px]" style={{ color: "var(--text-subtle)" }}>
                last run failed
              </span>
            </div>
            <div className="callout-name">{job.name}</div>
            <div className="callout-desc">
              {job.description ??
                `Exit ${lastRun.exit_code ?? "—"} · ${new Date(
                  lastRun.started_at,
                ).toLocaleString()}`}
            </div>
          </Link>
        ))}
        {staleSlice.map((job) => (
          <Link
            key={`stale-${job.name}`}
            href={`/jobs/${encodeURIComponent(job.name)}`}
            className="callout callout-warn"
          >
            <div className="flex items-center justify-between">
              <span className="eyebrow" style={{ color: "var(--warn)" }}>
                Stale
              </span>
              <span className="subtle text-[10.5px]" style={{ color: "var(--text-subtle)" }}>
                no recent success
              </span>
            </div>
            <div className="callout-name">{job.name}</div>
            <div className="callout-desc">Next fire: {nextFireTime(job.cron)}</div>
          </Link>
        ))}
      </div>
    </section>
  );
}
