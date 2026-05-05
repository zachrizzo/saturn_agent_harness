"use client";

import { useState, useEffect, useMemo, useRef, useId } from "react";
import { useRouter } from "next/navigation";
import parser from "cron-parser";
import type { Model } from "@/lib/models";
import { formatModelOption, reasoningEffortOptionsForCli, type ModelReasoningEffort } from "@/lib/models";
import { Portal } from "./Portal";
import { Button, Card, Input, Select } from "./ui";
import type { CLI } from "@/lib/runs";
import { CLI_LABELS, CLI_VALUES, DEFAULT_CLI, normalizeCli } from "@/lib/clis";
import { IconSettings } from "@/app/components/shell/icons";

function saveLabel(saving: boolean, saved: boolean): string {
  if (saving) return "Saving…";
  if (saved) return "Saved";
  return "Save";
}

const CRON_PRESETS = [
  { label: "Hourly", value: "0 * * * *" },
  { label: "Every 6h", value: "0 */6 * * *" },
  { label: "Daily 9am", value: "0 9 * * *" },
  { label: "Weekdays 9am", value: "0 9 * * 1-5" },
  { label: "Weekly", value: "0 9 * * 1" },
];

type Props = {
  jobName: string;
  currentCron: string;
  currentModel?: string;
  currentCli?: CLI;
  currentReasoningEffort?: ModelReasoningEffort;
  currentCatchUpMissedRuns?: boolean;
};

export function JobSettingsModal({
  jobName,
  currentCron,
  currentModel,
  currentCli = DEFAULT_CLI,
  currentReasoningEffort,
  currentCatchUpMissedRuns = false,
}: Props) {
  const cronInputId = `job-cron-${jobName}`;
  const modalTitleId = useId();
  const cronInputRef = useRef<HTMLInputElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [cron, setCron] = useState(currentCron);
  const [cli, setCli] = useState<CLI>(normalizeCli(currentCli));
  const [model, setModel] = useState(currentModel ?? "");
  const [reasoningEffort, setReasoningEffort] = useState<ModelReasoningEffort | "">(currentReasoningEffort ?? "");
  const [catchUpMissedRuns, setCatchUpMissedRuns] = useState(currentCatchUpMissedRuns);
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const router = useRouter();

  const fetchIdRef = useRef(0);

  useEffect(() => {
    if (!isOpen) return;
    const previousActive = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) setIsOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    window.setTimeout(() => cronInputRef.current?.focus(), 0);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousActive?.focus();
    };
  }, [isOpen, saving]);

  useEffect(() => {
    if (!isOpen) return;
    const myId = ++fetchIdRef.current;
    setModels([]);
    setLoading(true);
    setError(null);
    fetch(`/api/models?cli=${cli}`)
      .then((r) => r.json())
      .then((data) => {
        if (myId !== fetchIdRef.current) return;
        const list: Model[] = data.models ?? [];
        setModels(list);
        if (model && !list.find((m) => m.id === model)) {
          setModel("");
        }
      })
      .catch(() => { if (myId === fetchIdRef.current) setError("Failed to load models"); })
      .finally(() => { if (myId === fetchIdRef.current) setLoading(false); });
  }, [cli, isOpen]);

  const cronPreview = useMemo(() => {
    const value = cron.trim();
    if (!value) return "";
    try {
      return `Next fire: ${parser.parseExpression(value).next().toDate().toLocaleString()}`;
    } catch {
      return "Invalid cron expression";
    }
  }, [cron]);

  const handleOpen = () => {
    setCron(currentCron);
    setCli(normalizeCli(currentCli));
    setModel(currentModel ?? "");
    setReasoningEffort(currentReasoningEffort ?? "");
    setCatchUpMissedRuns(currentCatchUpMissedRuns);
    setSaved(false);
    setError(null);
    setIsOpen(true);
  };

  const handleSave = async () => {
    const normalizedCron = cron.trim();
    if (!normalizedCron) {
      setError("Cron schedule is required");
      return;
    }
    try {
      parser.parseExpression(normalizedCron);
    } catch {
      setError("Invalid cron expression");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobName)}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cron: normalizedCron,
          model: model || null,
          cli,
          reasoningEffort: reasoningEffort || null,
          catchUpMissedRuns,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Failed");
      setSaved(true);
      setTimeout(() => { setIsOpen(false); router.refresh(); }, 800);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button
        variant="default"
        size="icon"
        onClick={handleOpen}
        title="Job settings"
        aria-label="Job settings"
      >
        <IconSettings />
      </Button>

      {isOpen && (
        <Portal>
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
            onClick={() => !saving && setIsOpen(false)}
          >
            <Card
              className="w-full max-w-lg shadow-lg"
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-labelledby={modalTitleId}
            >
              <div className="p-5 border-b border-border">
                <h2 id={modalTitleId} className="text-base font-semibold">Job settings</h2>
                <div className="text-xs text-muted mt-0.5 mono">{jobName}</div>
              </div>

              <div className="p-5 space-y-5">
                {error && (
                  <div className="p-3 rounded border border-[color-mix(in_srgb,var(--fail)_30%,var(--border))] bg-[color-mix(in_srgb,var(--fail)_8%,transparent)] text-[var(--fail)] text-sm">
                    {error}
                  </div>
                )}

                <div>
                  <label htmlFor={cronInputId} className="label block mb-2">Schedule</label>
                  <Input
                    id={cronInputId}
                    ref={cronInputRef}
                    value={cron}
                    onChange={(e) => {
                      setCron(e.target.value);
                      setSaved(false);
                    }}
                    disabled={saving}
                    className="mono"
                    placeholder="0 9 * * *"
                  />
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {CRON_PRESETS.map((preset) => (
                      <button
                        key={preset.value}
                        type="button"
                        onClick={() => {
                          setCron(preset.value);
                          setSaved(false);
                        }}
                        disabled={saving}
                        className={`px-2.5 py-1 rounded border text-[11px] transition-colors ${
                          cron.trim() === preset.value
                            ? "bg-accent-soft border-accent text-accent"
                            : "bg-bg-elev border-border text-muted hover:bg-bg-hover hover:text-fg"
                        }`}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                  {cronPreview ? (
                    <p className={`mt-1.5 text-[11px] ${cronPreview.startsWith("Invalid") ? "text-[var(--fail)]" : "text-subtle"}`}>
                      {cronPreview}
                    </p>
                  ) : null}
                </div>

                <div>
                  <span className="label block mb-2">CLI</span>
                  <div className="flex gap-2">
                    {CLI_VALUES.map((c) => (
                      <button
                        key={c}
                        type="button"
                        onClick={() => setCli(c)}
                        className={`flex-1 py-2 rounded border text-sm transition-colors ${
                          cli === c
                            ? "bg-accent-soft border-accent text-accent"
                            : "bg-bg-elev border-border text-fg hover:bg-bg-hover"
                        }`}
                      >
                        {CLI_LABELS[c]}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label htmlFor="model-select" className="label block mb-2">Model</label>
                  <Select
                    id="model-select"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    disabled={saving || loading}
                  >
                    {loading ? (
                      <option value="">Loading…</option>
                    ) : (
                      <>
                        <option value="">— Use default —</option>
                        {models.map((m) => (
                          <option key={m.id} value={m.id}>{formatModelOption(m)}</option>
                        ))}
                      </>
                    )}
                  </Select>
                  {model && <p className="mt-1.5 text-[10px] text-subtle mono break-all">{model}</p>}
                </div>

                <div>
                  <label htmlFor="effort-select" className="label block mb-2">Reasoning effort</label>
                  <Select
                    id="effort-select"
                    value={reasoningEffort}
                    onChange={(e) => setReasoningEffort(e.target.value as ModelReasoningEffort | "")}
                    disabled={saving || loading}
                  >
                    <option value="">Use default</option>
                    {reasoningEffortOptionsForCli(cli, models.find((m) => m.id === model)).map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </Select>
                </div>

                <label className="flex items-start gap-3 rounded border border-border bg-bg-subtle p-3 text-sm">
                  <input
                    type="checkbox"
                    checked={catchUpMissedRuns}
                    onChange={(e) => {
                      setCatchUpMissedRuns(e.target.checked);
                      setSaved(false);
                    }}
                    disabled={saving}
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

              <div className="p-5 pt-0 flex gap-2 justify-end">
                <Button variant="default" onClick={() => setIsOpen(false)} disabled={saving}>
                  Cancel
                </Button>
                <Button variant="primary" onClick={handleSave} disabled={saving || loading || saved}>
                  {saveLabel(saving, saved)}
                </Button>
              </div>
            </Card>
          </div>
        </Portal>
      )}
    </>
  );
}
