"use client";

import { useState } from "react";
import { Button, Textarea } from "@/app/components/ui";

type Props = {
  endpoint: string;
  filename: string;
  label?: string;
};

function safeFilename(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "saturn-share";
}

export function ShareExportButton({ endpoint, filename, label = "Share" }: Props) {
  const [json, setJson] = useState("");
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const copy = async (value = json) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setStatus("Copied");
    } catch {
      setStatus("Copy failed. Select the JSON below.");
    }
  };

  const loadBundle = async () => {
    setLoading(true);
    setStatus(null);
    try {
      const res = await fetch(endpoint);
      const body = await res.text();
      if (!res.ok) {
        let message = body || `Export failed (${res.status})`;
        try {
          message = JSON.parse(body).error ?? message;
        } catch {
          // keep raw message
        }
        throw new Error(message);
      }
      const formatted = JSON.stringify(JSON.parse(body), null, 2);
      setJson(formatted);
      setOpen(true);
      await copy(formatted);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Export failed");
      setOpen(true);
    } finally {
      setLoading(false);
    }
  };

  const download = () => {
    if (!json) return;
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${safeFilename(filename)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatus("Downloaded");
  };

  return (
    <>
      <Button type="button" variant="default" size="sm" onClick={loadBundle} disabled={loading}>
        {loading ? "Sharing..." : label}
      </Button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-2xl rounded-lg border border-border bg-bg p-4 shadow-xl">
            <div className="mb-3 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold text-fg">Share JSON</div>
                {status && <div className="mt-0.5 text-[12px] text-muted">{status}</div>}
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Close
              </Button>
            </div>
            <Textarea value={json} readOnly className="min-h-[260px] mono text-[12px]" />
            <div className="mt-3 flex justify-end gap-2">
              <Button type="button" variant="default" size="sm" onClick={() => copy()}>
                Copy JSON
              </Button>
              <Button type="button" variant="primary" size="sm" onClick={download} disabled={!json}>
                Download
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
