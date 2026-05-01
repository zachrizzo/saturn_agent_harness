"use client";

import { useEffect, useState, use } from "react";
import type { Slice } from "@/lib/slices";
import type { SliceExecuteResult } from "@/lib/slice-executor";
import { Button } from "@/app/components/ui";
import { Chip } from "@/app/components/ui";
import { Textarea } from "@/app/components/ui";

// Duplicate of renderTemplate from slice-executor — pure client-side, no Node deps.
function renderTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_\-.]+)\s*\}\}/g, (_, name: string) => {
    const v = vars[name];
    if (v === undefined || v === null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  });
}

function statusVariant(status: string): "success" | "fail" | "warn" | "default" {
  if (status === "success") return "success";
  if (status === "failed" || status === "timeout") return "fail";
  if (status === "output_validation_error") return "warn";
  if (status === "budget_exceeded") return "warn";
  return "default";
}

export default function SliceTestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);

  const [slice, setSlice] = useState<Slice | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [inputsStr, setInputsStr] = useState("{}");
  const [inputsError, setInputsError] = useState<string | null>(null);

  const [result, setResult] = useState<SliceExecuteResult | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const [showRaw, setShowRaw] = useState(false);
  const [showPromptPreview, setShowPromptPreview] = useState(false);

  // Fetch slice on mount
  useEffect(() => {
    fetch(`/api/slices/${id}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.slice) {
          setSlice(data.slice);
          // Seed inputs with required variable keys
          const vars = data.slice.prompt_template?.required ?? data.slice.prompt_template?.variables ?? [];
          if (vars.length > 0) {
            const seed: Record<string, string> = {};
            for (const v of vars) seed[v] = "";
            setInputsStr(JSON.stringify(seed, null, 2));
          }
        } else {
          setLoadError(data.error ?? "slice not found");
        }
      })
      .catch((e) => setLoadError(String(e)));
  }, [id]);

  // Parse inputs JSON for preview
  let parsedInputs: Record<string, unknown> = {};
  try {
    parsedInputs = JSON.parse(inputsStr);
    if (inputsError) setInputsError(null);
  } catch (e) {
    // Don't setInputsError here — do it on run attempt
  }

  const promptPreview =
    slice && showPromptPreview
      ? renderTemplate(slice.prompt_template.system, parsedInputs)
      : null;

  async function handleRun() {
    let inputs: Record<string, unknown>;
    try {
      inputs = JSON.parse(inputsStr);
    } catch (e) {
      setInputsError(`Invalid JSON: ${(e as Error).message}`);
      return;
    }
    setInputsError(null);
    setRunError(null);
    setRunning(true);
    setResult(null);
    try {
      const res = await fetch(`/api/slices/${id}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputs }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRunError(data.error ?? `HTTP ${res.status}`);
      } else {
        setResult(data as SliceExecuteResult);
      }
    } catch (e) {
      setRunError(String(e));
    } finally {
      setRunning(false);
    }
  }

  if (loadError) {
    return (
      <div className="px-6 py-8 text-red-400 text-[13px]">
        Failed to load slice: {loadError}
      </div>
    );
  }

  if (!slice) {
    return (
      <div className="px-6 py-8 text-[13px] text-white/40">Loading slice…</div>
    );
  }

  return (
    <div className="px-6 py-8 max-w-5xl mx-auto">
      <div className="mb-5">
        <h1 className="text-[15px] font-semibold">
          Test: {slice.name}
        </h1>
        <p className="text-[12px] text-white/50 mt-0.5">
          {slice.description ?? ""}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-6">
        {/* Left panel — inputs + prompt preview + run */}
        <div className="flex flex-col gap-4">
          <div>
            <label className="text-[12px] font-medium text-white/70 mb-1 block">
              Inputs (JSON)
            </label>
            <Textarea
              value={inputsStr}
              onChange={(e) => setInputsStr(e.target.value)}
              rows={10}
              className="font-mono text-[12px] w-full"
              placeholder="{}"
            />
            {inputsError && (
              <p className="text-red-400 text-[11px] mt-1">{inputsError}</p>
            )}
          </div>

          <div>
            <button
              className="text-[12px] text-white/50 hover:text-white/80 underline-offset-2 hover:underline"
              onClick={() => setShowPromptPreview((v) => !v)}
            >
              {showPromptPreview ? "Hide" : "Show"} prompt preview
            </button>
            {showPromptPreview && (
              <pre className="mt-2 bg-white/5 rounded-md p-3 text-[11px] text-white/70 whitespace-pre-wrap overflow-auto max-h-64 border border-white/10">
                {promptPreview}
              </pre>
            )}
          </div>

          <div className="flex gap-2 items-center">
            <Button
              onClick={handleRun}
              disabled={running}
            >
              {running ? "Running…" : "Run"}
            </Button>
            <Button
              variant="ghost"
              onClick={async () => {
                const name = window.prompt("Fixture name (a-z, 0-9, _, -)");
                if (!name) return;
                let inputs: Record<string, unknown>;
                try {
                  inputs = JSON.parse(inputsStr);
                } catch (e) {
                  alert(`Invalid JSON: ${(e as Error).message}`);
                  return;
                }
                const assertions = result?.status
                  ? [{ kind: "status_equals" as const, status: result.status }]
                  : [];
                const res = await fetch(`/api/slices/${id}/fixtures`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ name, inputs, assertions }),
                });
                if (!res.ok) alert(`Save failed: ${res.status}`);
                else alert(`Saved fixture "${name}"`);
              }}
              disabled={running}
            >
              Save as fixture
            </Button>
            {slice.prompt_template.required && slice.prompt_template.required.length > 0 && (
              <span className="text-[11px] text-white/40">
                Required: {slice.prompt_template.required.join(", ")}
              </span>
            )}
          </div>

          {runError && (
            <p className="text-red-400 text-[12px]">Error: {runError}</p>
          )}
        </div>

        {/* Right panel — result */}
        <div className="flex flex-col gap-4">
          <div>
            <label className="text-[12px] font-medium text-white/70 mb-2 block">
              Result
            </label>
            {!result && !running && (
              <div className="text-[12px] text-white/30 italic">
                Run the slice to see output here.
              </div>
            )}
            {running && (
              <div className="text-[12px] text-white/50 italic">Running…</div>
            )}
            {result && (
              <div className="flex flex-col gap-3">
                {/* Status + metrics row */}
                <div className="flex items-center gap-3 flex-wrap">
                  <Chip variant={statusVariant(result.status)}>
                    {result.status}
                  </Chip>
                  <span className="text-[11px] text-white/50">
                    {result.duration_ms}ms
                  </span>
                  <span className="text-[11px] text-white/50">
                    {result.tokens.total.toLocaleString()} tokens
                    {result.tokens.input > 0 && (
                      <> ({result.tokens.input.toLocaleString()} in / {result.tokens.output.toLocaleString()} out)</>
                    )}
                  </span>
                </div>

                {result.error && (
                  <p className="text-red-400 text-[12px]">
                    {result.error}
                  </p>
                )}

                {/* Structured output */}
                {result.output !== null && (
                  <div>
                    <p className="text-[11px] text-white/50 mb-1">Output</p>
                    <pre className="bg-white/5 rounded-md p-3 text-[11px] text-white/80 whitespace-pre-wrap overflow-auto max-h-80 border border-white/10">
                      {JSON.stringify(result.output, null, 2)}
                    </pre>
                  </div>
                )}

                {/* Raw output (collapsible) */}
                <div>
                  <button
                    className="text-[12px] text-white/50 hover:text-white/80 underline-offset-2 hover:underline"
                    onClick={() => setShowRaw((v) => !v)}
                  >
                    {showRaw ? "Hide" : "Show"} raw output
                  </button>
                  {showRaw && (
                    <pre className="mt-2 bg-white/5 rounded-md p-3 text-[11px] text-white/60 whitespace-pre-wrap overflow-auto max-h-96 border border-white/10">
                      {result.raw_output || "(empty)"}
                    </pre>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
