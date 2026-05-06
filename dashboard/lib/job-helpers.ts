/**
 * Shared formatting/classification helpers for Job/Run UI.
 *
 * Multiple Jobs views (JobsTable, JobCard, JobDetailClient) used to each
 * define near-identical versions of these. Keep a single source of truth here.
 */

import type { RunMeta } from "./runs";

/**
 * Success percentage across completed runs (excludes in-flight runs so a long
 * currently-running job doesn't tank the rate). Returns 0 when there is
 * nothing to measure — callers decide how to render that.
 */
export function successRate(runs: RunMeta[]): number {
  if (!runs.length) return 0;
  const finished = runs.filter((r) => r.status !== "running");
  if (!finished.length) return 0;
  const ok = finished.filter((r) => r.status === "success").length;
  return Math.round((ok / finished.length) * 100);
}

export type StatusVariant = "success" | "warn" | "fail" | "default";
export type JobHealth = "running" | "attention" | "healthy" | "idle";

/** Map a run status (string or RunMeta) to a Chip / tone variant. */
export function statusVariant(
  input: RunMeta["status"] | RunMeta | string | undefined,
): StatusVariant {
  const status =
    typeof input === "string" || input === undefined
      ? input
      : input.status;
  if (status === "success") return "success";
  if (status === "failed") return "fail";
  if (status === "running") return "warn";
  return "default";
}

/** CSS var for the tone colour at a given success rate. */
export function rateColorVar(rate: number): string {
  if (rate >= 80) return "var(--success)";
  if (rate >= 50) return "var(--warn)";
  return "var(--fail)";
}

/** Tailwind text class for a success-rate tone. */
export function rateToneClass(rate: number, hasRuns: boolean): string {
  if (!hasRuns) return "text-muted";
  if (rate >= 80) return "text-[var(--success)]";
  if (rate >= 50) return "text-[var(--warn)]";
  return "text-[var(--fail)]";
}

export function rateVariant(rate: number, hasRuns: boolean): StatusVariant {
  if (!hasRuns) return "default";
  if (rate >= 80) return "success";
  if (rate >= 50) return "warn";
  return "fail";
}

export function jobHealthFor(runs: RunMeta[], rate = successRate(runs)): JobHealth {
  const latest = runs[0];
  if (latest?.status === "running") return "running";
  if (!runs.length) return "idle";
  if (latest?.status === "failed" || rate < 80) return "attention";
  return "healthy";
}

export function jobHealthLabel(health: JobHealth): string {
  if (health === "running") return "Running";
  if (health === "attention") return "Needs attention";
  if (health === "idle") return "No runs";
  return "Healthy";
}

export function jobHealthVariant(health: JobHealth): StatusVariant {
  if (health === "healthy") return "success";
  if (health === "running") return "warn";
  if (health === "attention") return "fail";
  return "default";
}

/** Coarse "N{unit} ago" string for a recent ISO timestamp. */
export function relativeTime(iso?: string): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
