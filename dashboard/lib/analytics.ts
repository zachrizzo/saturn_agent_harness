import parser from "cron-parser";
import type { Job, RunMeta, TokenUsageSummary } from "./runs";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

type DailyRow = { date: string } & Record<string, number>;

/**
 * Bucket token usage by UTC date (YYYY-MM-DD), emitting one entry per day for
 * the last `days` days. Each entry has a `date` key plus one numeric key per
 * source (scheduled job names plus aggregate sources like Chats).
 */
export function dailyTokenSeries(
  records: TokenUsageSummary[],
  days = 30
): {
  data: DailyRow[];
  sources: string[];
} {
  const sources = Array.from(
    new Set(records.filter((r) => (r.total_tokens ?? 0) > 0).map((r) => r.name)),
  ).sort();

  const now = new Date();
  const todayUtcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  const byDate = new Map<string, Record<string, number>>();
  for (let i = days - 1; i >= 0; i--) {
    const key = isoDate(new Date(todayUtcMs - i * MS_PER_DAY));
    const row: Record<string, number> = {};
    for (const source of sources) row[source] = 0;
    byDate.set(key, row);
  }

  for (const r of records) {
    if (!r.started_at) continue;
    const d = new Date(r.started_at);
    if (Number.isNaN(d.getTime())) continue;
    const row = byDate.get(isoDate(d));
    if (!row) continue;
    row[r.name] = (row[r.name] ?? 0) + (r.total_tokens ?? 0);
  }

  const data: DailyRow[] = Array.from(byDate, ([date, row]) => ({ date, ...row } as DailyRow));
  data.sort((a, b) => a.date.localeCompare(b.date));

  return { data, sources };
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Detect job health issues:
 *  - stale: a job with no successful run within 2× its cron interval.
 *  - failing: jobs whose most recent run (any status) within the last 24h was failed.
 */
export function detectIssues(
  jobs: Job[],
  runsByJob: Record<string, RunMeta[]>
): {
  stale: Job[];
  failing: Array<{ job: Job; lastRun: RunMeta }>;
} {
  const stale: Job[] = [];
  const failing: Array<{ job: Job; lastRun: RunMeta }> = [];
  const now = Date.now();

  for (const job of jobs) {
    const runs = runsByJob[job.name] ?? [];
    const lastSuccess = runs.find((r) => r.status === "success");
    const last = runs[0];

    try {
      const it = parser.parseExpression(job.cron);
      const a = it.next().toDate().getTime();
      const b = it.next().toDate().getTime();
      const threshold = 2 * Math.max(1, b - a);
      const lastSuccessAt = lastSuccess?.started_at
        ? new Date(lastSuccess.started_at).getTime()
        : 0;
      if (!lastSuccessAt || now - lastSuccessAt > threshold) {
        stale.push(job);
      }
    } catch {
      /* invalid cron — skip stale check */
    }

    if (last?.status === "failed" && last.started_at) {
      const at = new Date(last.started_at).getTime();
      if (!Number.isNaN(at) && now - at <= MS_PER_DAY) {
        failing.push({ job, lastRun: last });
      }
    }
  }

  return { stale, failing };
}
