"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import type { CLI } from "@/lib/runs";
import type { Model } from "@/lib/models";
import { formatModelOption, reasoningEffortOptionsForCli, type ModelReasoningEffort } from "@/lib/models";
import { DirPicker } from "@/app/components/DirPicker";
import { DEFAULT_CLAUDE_ALIAS, toBedrockId } from "@/lib/claude-models";
import { CLI_LABELS, CLI_VALUES, DEFAULT_CLI } from "@/lib/clis";

export function AdHocChatForm() {
  const router = useRouter();
  const [cli, setCli] = useState<CLI>(DEFAULT_CLI);
  const [model, setModel] = useState(toBedrockId(DEFAULT_CLAUDE_ALIAS) ?? DEFAULT_CLAUDE_ALIAS);
  const [reasoningEffort, setReasoningEffort] = useState<ModelReasoningEffort | "">("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [message, setMessage] = useState("");
  const [cwd, setCwd] = useState("");
  const [models, setModels] = useState<Model[]>([]);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/models?cli=${cli}`).then((r) => r.json()).then((data) => {
      if (cancelled) return;
      const list: Model[] = data.models ?? [];
      setModels(list);
      if (list.length > 0 && (!model || !list.find((m) => m.id === model))) {
        setModel(list[0].id);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [cli]);

  const start = async () => {
    if (!message.trim()) return;
    setStarting(true);
    setError(null);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: message.trim(),
          adhoc_config: {
            cli,
            model: model || undefined,
            reasoningEffort: reasoningEffort || undefined,
            prompt: systemPrompt.trim() || undefined,
            cwd: cwd.trim() || undefined,
          },
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null) as { error?: string } | null;
        throw new Error(data?.error ?? `Request failed (${res.status})`);
      }
      const { session_id } = await res.json();
      router.push(`/chat/${session_id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
      setStarting(false);
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); start(); }} className="space-y-4">
      {error && (
        <div className="p-3 rounded bg-red-500/10 border border-red-500/20 text-red-400 text-sm">{error}</div>
      )}

      <div className="flex gap-2">
        {CLI_VALUES.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setCli(c)}
            className={`flex-1 py-2 rounded border text-sm transition-colors ${
              cli === c
                ? "bg-[var(--accent)]/20 border-[var(--accent)] text-[var(--accent)]"
                : "bg-[var(--bg-secondary)] border-[var(--border)] hover:bg-[var(--bg-hover)]"
            }`}
          >
            {CLI_LABELS[c]}
          </button>
        ))}
      </div>

      <label className="block">
        <span className="block text-xs font-medium text-[var(--text-muted)] mb-1">Model</span>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="w-full px-3 py-2 rounded bg-[var(--bg-secondary)] border border-[var(--border)] text-white text-sm"
        >
          {models.map((m) => <option key={m.id} value={m.id}>{formatModelOption(m)}</option>)}
        </select>
      </label>

      <label className="block">
        <span className="block text-xs font-medium text-[var(--text-muted)] mb-1">Reasoning effort</span>
        <select
          value={reasoningEffort}
          onChange={(e) => setReasoningEffort(e.target.value as ModelReasoningEffort | "")}
          className="w-full px-3 py-2 rounded bg-[var(--bg-secondary)] border border-[var(--border)] text-white text-sm"
        >
          <option value="">Default</option>
          {reasoningEffortOptionsForCli(cli, models.find((m) => m.id === model)).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="block text-xs font-medium text-[var(--text-muted)] mb-1">System prompt (optional)</span>
        <textarea
          value={systemPrompt}
          onChange={(e) => setSystemPrompt(e.target.value)}
          placeholder="You are helpful…"
          className="w-full min-h-[80px] resize-y px-3 py-2 rounded bg-[var(--bg-secondary)] border border-[var(--border)] text-white text-sm font-mono"
        />
      </label>

      <label className="block">
        <span className="block text-xs font-medium text-[var(--text-muted)] mb-1">Working directory (optional)</span>
        <DirPicker value={cwd} onChange={setCwd} />
      </label>

      <label className="block">
        <span className="block text-xs font-medium text-[var(--text-muted)] mb-1">First message</span>
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          required
          placeholder="Say hi…"
          className="w-full min-h-[100px] resize-y px-3 py-2 rounded bg-[var(--bg-secondary)] border border-[var(--border)] text-white text-sm"
        />
      </label>

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={!message.trim() || starting}
          className="px-4 py-2 rounded bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-sm disabled:opacity-40"
        >
          {starting ? "Starting…" : "Start chat"}
        </button>
      </div>
    </form>
  );
}
