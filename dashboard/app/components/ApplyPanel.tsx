"use client";

import { useEffect, useState } from "react";
import { Button, Chip } from "./ui";
import { DiffView } from "./DiffView";

type Props = {
  sessionId: string;
  runId: string;
  onApplied?: () => void;
};

type DiffData = {
  diff: string;
  status: string;
  sandbox_path: string;
  applied: boolean;
};

export function ApplyPanel({ sessionId, runId, onApplied }: Props) {
  const [data, setData] = useState<DiffData | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/slices/${encodeURIComponent(runId)}/apply`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`load failed: ${r.status}`);
        return r.json();
      })
      .then((d: DiffData) => setData(d))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [sessionId, runId]);

  const handleApply = async () => {
    setApplying(true);
    setError(null);
    setConflicts(null);
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/slices/${encodeURIComponent(runId)}/apply`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ confirmed: true }),
        },
      );
      const body = await res.json().catch(() => ({}));
      if (res.status === 409 && body?.conflicts) {
        setConflicts(String(body.conflicts));
      } else if (!res.ok) {
        setError(body?.error ?? `HTTP ${res.status}`);
      } else {
        setData((d) => (d ? { ...d, applied: true } : d));
        onApplied?.();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setApplying(false);
    }
  };

  if (loading) return <p className="text-[12px] text-muted italic">Loading diff…</p>;
  if (error && !data) return <p className="text-[12px] text-red-400">{error}</p>;
  if (!data) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted mono">{data.sandbox_path}</span>
        {data.applied ? (
          <Chip variant="success">applied</Chip>
        ) : (
          <Button size="sm" onClick={handleApply} disabled={applying}>
            {applying ? "Applying…" : "Apply changes"}
          </Button>
        )}
      </div>
      {conflicts && (
        <div className="text-[12px] text-amber-300 whitespace-pre-wrap p-2 border border-amber-500/30 rounded bg-amber-500/10">
          <div className="font-semibold mb-1">Patch does not apply cleanly:</div>
          {conflicts}
        </div>
      )}
      {error && !conflicts && (
        <p className="text-[12px] text-red-400">{error}</p>
      )}
      <DiffView diff={data.diff} />
    </div>
  );
}
