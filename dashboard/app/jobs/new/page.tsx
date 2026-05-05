"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import type { CLI } from "@/lib/runs";
import type { Model, ModelReasoningEffort } from "@/lib/models";
import { formatModelOption, formatReasoningEffort, reasoningEffortOptionsForCli } from "@/lib/models";
import { CLI_SHORT_LABELS, CLI_VALUES, normalizeCli } from "@/lib/clis";

const CRON_PRESETS = [
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every 6 hours", value: "0 */6 * * *" },
  { label: "Daily at 9am", value: "0 9 * * *" },
  { label: "Daily at midnight", value: "0 0 * * *" },
  { label: "Weekdays at 9am", value: "0 9 * * 1-5" },
  { label: "Weekly (Mon 9am)", value: "0 9 * * 1" },
];

export default function NewJobPage() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [cron, setCron] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [cwd, setCwd] = useState("");
  const [cli, setCli] = useState<CLI>(normalizeCli("claude-bedrock"));
  const [model, setModel] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<ModelReasoningEffort | "">("");
  const [timeoutSeconds, setTimeoutSeconds] = useState("");
  const [catchUpMissedRuns, setCatchUpMissedRuns] = useState(false);
  const [models, setModels] = useState<Model[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setModel("");
    fetch(`/api/models?cli=${encodeURIComponent(cli)}`)
      .then((r) => r.json())
      .then((d: { models: Model[] }) => setModels(d.models ?? []))
      .catch(() => setModels([]));
  }, [cli]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const res = await fetch("/api/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          cron: cron.trim(),
          prompt: prompt.trim(),
          description: description.trim() || undefined,
          cwd: cwd.trim() || undefined,
          cli,
          model: model || undefined,
          reasoningEffort: reasoningEffort || undefined,
          timeout_seconds: timeoutSeconds ? Number(timeoutSeconds) : undefined,
          catchUpMissedRuns,
        }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) { setError(data.error ?? "Failed to create job"); return; }
      router.push("/jobs");
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-2xl space-y-6">
      <header>
        <div className="flex items-center gap-2 text-[12px] text-muted mb-3">
          <button type="button" onClick={() => router.push("/jobs")} className="hover:text-fg transition-colors">
            Jobs
          </button>
          <span>/</span>
          <span>New</span>
        </div>
        <h1 className="text-[22px] font-semibold tracking-tight">New scheduled job</h1>
        <p className="text-[13px] text-muted mt-1">
          Jobs run on a cron schedule and send a prompt to an agent CLI. Saving this form syncs the schedule to cron.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="space-y-5">
        {/* Name */}
        <div className="card p-5 space-y-4">
          <h2 className="text-[13px] font-semibold">Identity</h2>
          <div className="space-y-1">
            <label className="text-[12px] text-muted" htmlFor="job-name">
              Name <span className="text-[var(--fail)]">*</span>
            </label>
            <input
              id="job-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
              placeholder="daily-report"
              required
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] text-fg placeholder:text-subtle focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <p className="text-[11px] text-subtle">Lowercase letters, numbers, and hyphens only.</p>
          </div>
          <div className="space-y-1">
            <label className="text-[12px] text-muted" htmlFor="job-desc">Description</label>
            <input
              id="job-desc"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Summarise overnight activity and post to Slack"
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] text-fg placeholder:text-subtle focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
        </div>

        {/* Schedule */}
        <div className="card p-5 space-y-4">
          <h2 className="text-[13px] font-semibold">Schedule</h2>
          <div className="space-y-2">
            <label className="text-[12px] text-muted" htmlFor="job-cron">
              Cron expression <span className="text-[var(--fail)]">*</span>
            </label>
            <input
              id="job-cron"
              type="text"
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              placeholder="0 9 * * *"
              required
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] mono text-fg placeholder:text-subtle focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <div className="flex flex-wrap gap-1.5">
              {CRON_PRESETS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => setCron(p.value)}
                  className={[
                    "px-2.5 py-1 rounded-md text-[11px] border transition-colors",
                    cron === p.value
                      ? "border-accent bg-accent/10 text-accent"
                      : "border-border text-muted hover:border-accent/40 hover:text-fg",
                  ].join(" ")}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-start gap-3 rounded-lg border border-border bg-bg-subtle p-3 text-sm">
            <input
              type="checkbox"
              checked={catchUpMissedRuns}
              onChange={(e) => setCatchUpMissedRuns(e.target.checked)}
              className="mt-1 h-4 w-4 accent-[var(--accent)]"
            />
            <span>
              <span className="block font-medium text-fg">Run missed schedule</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-muted">
                If this Mac is asleep or offline, start one catch-up run when Saturn next opens, as long as the missed fire was within 25 hours.
              </span>
            </span>
          </label>
        </div>

        {/* Prompt */}
        <div className="card p-5 space-y-4">
          <h2 className="text-[13px] font-semibold">Prompt</h2>
          <div className="space-y-1">
            <label className="text-[12px] text-muted" htmlFor="job-prompt">
              Agent instruction <span className="text-[var(--fail)]">*</span>
            </label>
            <textarea
              id="job-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Summarise the last 24 hours of activity across all repositories and write a brief report to ~/reports/daily.md"
              required
              rows={6}
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] text-fg placeholder:text-subtle focus:outline-none focus:ring-1 focus:ring-accent resize-y"
            />
          </div>
          <div className="space-y-1">
            <label className="text-[12px] text-muted" htmlFor="job-cwd">Working directory</label>
            <input
              id="job-cwd"
              type="text"
              value={cwd}
              onChange={(e) => setCwd(e.target.value)}
              placeholder="/Users/you/projects/myrepo"
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] mono text-fg placeholder:text-subtle focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
        </div>

        {/* Model / CLI */}
        <div className="card p-5 space-y-4">
          <h2 className="text-[13px] font-semibold">Model & runtime</h2>
          <div className="space-y-1.5">
            <span className="text-[12px] text-muted">CLI</span>
            <div className="flex flex-wrap gap-1.5">
              {CLI_VALUES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCli(c)}
                  className={[
                    "px-3 py-1.5 rounded-md text-[12px] font-medium transition-all",
                    cli === c ? "bg-accent text-white" : "border border-border text-muted hover:text-fg hover:border-accent/40",
                  ].join(" ")}
                >
                  {CLI_SHORT_LABELS[c]}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-[12px] text-muted" htmlFor="job-model">Model</label>
              <select
                id="job-model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] text-fg focus:outline-none focus:ring-1 focus:ring-accent"
              >
                <option value="">Default</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>{formatModelOption(m)}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-[12px] text-muted" htmlFor="job-effort">Reasoning effort</label>
              <select
                id="job-effort"
                value={reasoningEffort}
                onChange={(e) => setReasoningEffort(e.target.value as ModelReasoningEffort | "")}
                className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] text-fg focus:outline-none focus:ring-1 focus:ring-accent"
              >
                <option value="">Default</option>
                {reasoningEffortOptionsForCli(cli, models.find((m) => m.id === model)).map((o) => (
                  <option key={o.value} value={o.value}>{formatReasoningEffort(o.value)}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="space-y-1 max-w-[200px]">
            <label className="text-[12px] text-muted" htmlFor="job-timeout">Timeout (seconds)</label>
            <input
              id="job-timeout"
              type="number"
              min={60}
              max={86400}
              value={timeoutSeconds}
              onChange={(e) => setTimeoutSeconds(e.target.value)}
              placeholder="1800"
              className="w-full rounded-lg border border-border bg-bg px-3 py-2 text-[13px] text-fg placeholder:text-subtle focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
        </div>

        {error && (
          <div className="rounded-lg border border-[var(--fail)]/30 bg-[var(--fail)]/10 px-4 py-3 text-[13px] text-[var(--fail)]">
            {error}
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={saving}
            className="btn btn-primary"
          >
            {saving ? "Creating…" : "Create and schedule job"}
          </button>
          <button
            type="button"
            onClick={() => router.push("/jobs")}
            className="btn"
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
