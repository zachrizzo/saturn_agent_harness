import { listJobs, listRuns, type RunMeta } from "@/lib/runs";
import { runMissedJobCatchUps } from "@/lib/missed-job-catchup";
import { JobsWorkspace } from "./JobsWorkspace";

export const revalidate = 0;
export const dynamic = "force-dynamic";

export default async function JobsPage(): Promise<JSX.Element> {
  await runMissedJobCatchUps().catch((err) => {
    console.error("missed job catch-up failed", err);
  });

  const [jobs, allRuns] = await Promise.all([listJobs(), listRuns()]);

  const runsByJob: Record<string, RunMeta[]> = {};
  for (const run of allRuns) {
    (runsByJob[run.name] ??= []).push(run);
  }

  return <JobsWorkspace jobs={jobs} runsByJob={runsByJob} allRuns={allRuns} />;
}
