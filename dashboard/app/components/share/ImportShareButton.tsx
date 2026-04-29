"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Select, Textarea } from "@/app/components/ui";

type ImportSummary = {
  agents?: { created?: string[]; updated?: string[]; skipped?: string[]; renamed?: Array<{ from: string; to: string }> };
  slices?: { created?: string[]; updated?: string[]; skipped?: string[]; renamed?: Array<{ from: string; to: string }> };
};

type Props = {
  onImported?: () => void;
};

function totalImported(summary?: ImportSummary | null): number {
  if (!summary) return 0;
  return [
    summary.agents?.created,
    summary.agents?.updated,
    summary.slices?.created,
    summary.slices?.updated,
  ].reduce((total, items) => total + (items?.length ?? 0), 0);
}

export function ImportShareButton({ onImported }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [json, setJson] = useState("");
  const [conflict, setConflict] = useState<"rename" | "skip" | "overwrite">("rename");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  const reset = () => {
    setError(null);
    setSummary(null);
  };

  const importJson = async () => {
    reset();
    setBusy(true);
    try {
      const bundle = JSON.parse(json);
      const res = await fetch("/api/share/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundle, conflict }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Import failed");
      setSummary(data.summary ?? null);
      onImported?.();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(false);
    }
  };

  const importedCount = totalImported(summary);

  return (
    <>
      <Button type="button" variant="default" size="sm" onClick={() => setOpen(true)}>
        Import JSON
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-2xl rounded-lg border border-border bg-bg p-4 shadow-xl">
            <div className="mb-3 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold text-fg">Import shared JSON</div>
                <div className="mt-0.5 text-[12px] text-muted">
                  Agent bundles import their referenced slices first.
                </div>
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Close
              </Button>
            </div>

            <div className="mb-3 max-w-xs">
              <label className="block">
                <span className="label block mb-1.5">Duplicate IDs</span>
                <Select value={conflict} onChange={(e) => setConflict(e.target.value as typeof conflict)}>
                  <option value="rename">Rename imported copy</option>
                  <option value="skip">Skip existing</option>
                  <option value="overwrite">Overwrite existing</option>
                </Select>
              </label>
            </div>

            <Textarea
              value={json}
              onChange={(e) => {
                setJson(e.target.value);
                reset();
              }}
              placeholder='Paste a Saturn share bundle JSON here'
              className="min-h-[260px] mono text-[12px]"
            />

            {error && (
              <div className="mt-2 rounded-md border border-[color-mix(in_srgb,var(--fail)_35%,var(--border))] px-3 py-2 text-[12px] text-[var(--fail)]">
                {error}
              </div>
            )}
            {summary && (
              <div className="mt-2 rounded-md border border-border bg-bg-subtle px-3 py-2 text-[12px] text-muted">
                Imported {importedCount} item{importedCount === 1 ? "" : "s"}.
                {(summary.agents?.renamed?.length ?? 0) + (summary.slices?.renamed?.length ?? 0) > 0 && " Some duplicate IDs were renamed."}
              </div>
            )}

            <div className="mt-3 flex justify-end gap-2">
              <Button type="button" variant="default" size="sm" onClick={() => setJson("")} disabled={busy || !json}>
                Clear
              </Button>
              <Button type="button" variant="primary" size="sm" onClick={importJson} disabled={busy || !json.trim()}>
                {busy ? "Importing..." : "Import"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
