"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import type { Model } from "@/lib/models";
import { formatModelOption, reasoningEffortOptionsForCli, type ModelReasoningEffort } from "@/lib/models";
import { Portal } from "./Portal";
import { Button, Card, Select } from "./ui";
import type { CLI } from "@/lib/runs";
import { CLI_LABELS, CLI_VALUES, DEFAULT_CLI, normalizeCli } from "@/lib/clis";

function saveLabel(saving: boolean, saved: boolean): string {
  if (saving) return "Saving…";
  if (saved) return "Saved";
  return "Save";
}

type Props = {
  jobName: string;
  currentModel?: string;
  currentCli?: CLI;
  currentReasoningEffort?: ModelReasoningEffort;
};

export function JobSettingsModal({ jobName, currentModel, currentCli = DEFAULT_CLI, currentReasoningEffort }: Props) {
  const [isOpen, setIsOpen] = useState(false);
  const [cli, setCli] = useState<CLI>(normalizeCli(currentCli));
  const [model, setModel] = useState(currentModel ?? "");
  const [reasoningEffort, setReasoningEffort] = useState<ModelReasoningEffort | "">(currentReasoningEffort ?? "");
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const router = useRouter();

  const fetchIdRef = useRef(0);

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

  const handleOpen = () => {
    setCli(normalizeCli(currentCli));
    setModel(currentModel ?? "");
    setReasoningEffort(currentReasoningEffort ?? "");
    setSaved(false);
    setError(null);
    setIsOpen(true);
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(jobName)}/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: model || null, cli, reasoningEffort: reasoningEffort || null }),
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
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      </Button>

      {isOpen && (
        <Portal>
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
            onClick={() => !saving && setIsOpen(false)}
          >
            <Card className="w-full max-w-lg shadow-lg" onClick={(e) => e.stopPropagation()}>
              <div className="p-5 border-b border-border">
                <h2 className="text-base font-semibold">Job settings</h2>
                <div className="text-xs text-muted mt-0.5 mono">{jobName}</div>
              </div>

              <div className="p-5 space-y-5">
                {error && (
                  <div className="p-3 rounded border border-[color-mix(in_srgb,var(--fail)_30%,var(--border))] bg-[color-mix(in_srgb,var(--fail)_8%,transparent)] text-[var(--fail)] text-sm">
                    {error}
                  </div>
                )}

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
