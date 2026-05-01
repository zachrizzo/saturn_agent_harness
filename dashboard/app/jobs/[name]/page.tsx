import { notFound } from "next/navigation";
import { getJob, listRuns, readFinalMarkdown } from "@/lib/runs";
import { formatDuration, formatTimestamp, formatTokens, nextFireTime } from "@/lib/format";
import { JobDetailClient } from "./JobDetailClient";

export const revalidate = 0;
export const dynamic = "force-dynamic";

export default async function JobPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const job = await getJob(name);
  if (!job) notFound();
  const runs = await listRuns(name);

  // Read final.md for the most recent 10 runs (avoid reading all of them)
  const runsWithOutput = await Promise.all(
    runs.slice(0, 10).map(async (r) => ({
      ...r,
      formattedStarted: formatTimestamp(r.started_at),
      formattedFinished: formatTimestamp(r.finished_at),
      formattedDuration: formatDuration(r.duration_ms),
      formattedTokens: formatTokens(r.total_tokens),
      finalOutput: await readFinalMarkdown(r.name, r.slug),
    }))
  );
  // Older runs without output
  const olderRuns = runs.slice(10).map((r) => ({
    ...r,
    formattedStarted: formatTimestamp(r.started_at),
    formattedFinished: formatTimestamp(r.finished_at),
    formattedDuration: formatDuration(r.duration_ms),
    formattedTokens: formatTokens(r.total_tokens),
    finalOutput: "",
  }));

  return (
    <JobDetailClient
      job={job}
      runs={[...runsWithOutput, ...olderRuns]}
      nextFire={nextFireTime(job.cron)}
      avgDuration={formatDuration(runs.length > 0 ? runs.reduce((acc, r) => acc + (r.duration_ms ?? 0), 0) / runs.length : 0)}
      avgTokens={formatTokens(runs.length > 0 ? runs.reduce((acc, r) => acc + (r.total_tokens ?? 0), 0) / runs.length : 0)}
    />
  );
}
