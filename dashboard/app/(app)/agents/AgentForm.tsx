"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Agent, AgentKind, CLI, MutationTier, OrchestratorBudget, OnBudgetExceeded, OnSliceFailure } from "@/lib/runs";
import { agentDefaultCli, agentSupportedClis } from "@/lib/session-utils";
import type { Model } from "@/lib/models";
import {
  formatModelOption,
  reasoningEffortOptionsForCli,
  type ModelReasoningEffort,
} from "@/lib/models";
import type { Slice } from "@/lib/slices";
import { DirPicker } from "@/app/components/DirPicker";
import { Button, Card, Input, Select, Textarea } from "@/app/components/ui";
import { CLI_LABELS, CLI_VALUES, DEFAULT_CLI, normalizeCli } from "@/lib/clis";

const ALL_CLIS: CLI[] = [...CLI_VALUES];

export function AgentForm({ existing }: { existing?: Agent } = {}) {
  const router = useRouter();

  const [id, setId] = useState(existing?.id ?? "");
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [prompt, setPrompt] = useState(existing?.prompt ?? "");
  const [cwd, setCwd] = useState(existing?.cwd ?? "");
  const [tags, setTags] = useState((existing?.tags ?? []).join(", "));
  const [cron, setCron] = useState(existing?.cron ?? "");
  const [timeout, setTimeoutVal] = useState(existing?.timeout_seconds?.toString() ?? "1800");
  const [allowedTools, setAllowedTools] = useState((existing?.allowedTools ?? []).join(", "));

  // Orchestrator fields
  const [kind, setKind] = useState<AgentKind>(existing?.kind ?? "chat");
  const [allSlices, setAllSlices] = useState<Slice[]>([]);
  const [selectedSlices, setSelectedSlices] = useState<Set<string>>(
    new Set(Array.isArray(existing?.slices_available) ? existing.slices_available : [])
  );
  const [slicesAll, setSlicesAll] = useState(existing?.slices_available === "*");
  const [canCreateCustomSlices, setCanCreateCustomSlices] = useState(existing?.can_create_custom_slices ?? false);
  const [allowedMutations, setAllowedMutations] = useState<Set<MutationTier>>(
    new Set(existing?.allowed_mutations ?? ["read-only"])
  );
  const [budget, setBudget] = useState<OrchestratorBudget>(existing?.budget ?? {
    max_total_tokens: 200000,
    max_wallclock_seconds: 600,
    max_slice_calls: 15,
    max_recursion_depth: 3,
  });
  const [onBudgetExceeded, setOnBudgetExceeded] = useState<OnBudgetExceeded>(existing?.on_budget_exceeded ?? "report-partial");
  const [onSliceFailure, setOnSliceFailure] = useState<OnSliceFailure>(existing?.on_slice_failure ?? "continue");

  const emptyAgent: Agent = { id: "", name: "", prompt: "", cli: DEFAULT_CLI, created_at: "" };
  const [supportedClis, setSupportedClis] = useState<CLI[]>(agentSupportedClis(existing ?? emptyAgent));
  const [defaultCli, setDefaultCli] = useState<CLI>(agentDefaultCli(existing ?? emptyAgent));
  const [cliModels, setCliModels] = useState<Partial<Record<CLI, string>>>(
    existing?.models ?? (existing?.model ? { [normalizeCli(existing.cli)]: existing.model } : {})
  );
  const [cliReasoningEfforts, setCliReasoningEfforts] = useState<Partial<Record<CLI, ModelReasoningEffort>>>(
    existing?.reasoningEfforts ??
      (existing?.reasoningEffort ? { [normalizeCli(existing.cli)]: existing.reasoningEffort } : {})
  );
  const [modelsByCliCache, setModelsByCliCache] = useState<Partial<Record<CLI, Model[]>>>({});

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    for (const c of supportedClis) {
      if (modelsByCliCache[c]) continue;
      fetch(`/api/models?cli=${c}`).then((r) => r.json()).then((data) => {
        const list: Model[] = data.models ?? [];
        setModelsByCliCache((prev) => ({ ...prev, [c]: list }));
        if (list.length > 0) {
          setCliModels((prev) => {
            if (prev[c] && list.find((m) => m.id === prev[c])) return prev;
            return { ...prev, [c]: list[0].id };
          });
        }
      }).catch(() => {});
    }
  }, [supportedClis]);

  useEffect(() => {
    if (!supportedClis.includes(defaultCli)) {
      setDefaultCli(supportedClis[0] ?? DEFAULT_CLI);
    }
  }, [supportedClis, defaultCli]);

  useEffect(() => {
    if (kind === "orchestrator") {
      fetch("/api/slices")
        .then((r) => r.json())
        .then((data) => setAllSlices(data.slices ?? []))
        .catch(() => {});
    }
  }, [kind]);

  const toggleCli = (c: CLI) => {
    setSupportedClis((prev) => {
      if (prev.includes(c)) {
        if (prev.length === 1) return prev;
        return prev.filter((x) => x !== c);
      }
      return [...prev, c];
    });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const body: Partial<Agent> = {
        id: id.trim(),
        name: name.trim(),
        description: description.trim() || undefined,
        supportedClis,
        defaultCli,
        models: Object.keys(cliModels).length > 0 ? cliModels : undefined,
        reasoningEfforts: Object.keys(cliReasoningEfforts).length > 0 ? cliReasoningEfforts : undefined,
        prompt,
        cwd: cwd.trim() || undefined,
        allowedTools: allowedTools.split(",").map((s) => s.trim()).filter(Boolean),
        tags: tags.split(",").map((s) => s.trim()).filter(Boolean),
        cron: cron.trim() || null,
        timeout_seconds: parseInt(timeout, 10) || 1800,
        kind,
        ...(kind === "orchestrator" ? {
          slices_available: slicesAll ? "*" : Array.from(selectedSlices),
          can_create_custom_slices: canCreateCustomSlices,
          allowed_mutations: Array.from(allowedMutations),
          budget,
          on_budget_exceeded: onBudgetExceeded,
          on_slice_failure: onSliceFailure,
        } : {}),
      };

      const url = existing ? `/api/agents/${encodeURIComponent(existing.id)}` : "/api/agents";
      const method = existing ? "PUT" : "POST";
      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "failed");

      if (body.cron && body.id) {
        await fetch(`/api/agents/${encodeURIComponent(body.id as string)}/schedule`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ cron: body.cron }),
        });
      }

      router.push("/agents");
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(e) => { e.preventDefault(); save(); }} className="space-y-5 max-w-3xl">
      {error && (
        <Card className="p-3 border-[color-mix(in_srgb,var(--fail)_30%,var(--border))] text-[var(--fail)] text-sm">
          {error}
        </Card>
      )}

      <div className="flex gap-2 items-center mb-2">
        <span className="label">Agent type</span>
        {(["chat", "orchestrator"] as AgentKind[]).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setKind(k)}
            className={`px-3 py-1.5 rounded text-[12px] border transition-colors ${
              kind === k
                ? "bg-accent-soft border-accent text-accent"
                : "border-border text-muted hover:bg-bg-hover"
            }`}
          >
            {k === "chat" ? "Chat agent" : "Orchestrator"}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="ID (unique, no spaces)">
          <Input
            value={id}
            onChange={(e) => setId(e.target.value)}
            disabled={!!existing}
            required
            placeholder="code-reviewer"
          />
        </Field>
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            placeholder="Code Reviewer"
          />
        </Field>
      </div>

      <Field label="Description">
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Short summary shown on the agent card"
        />
      </Field>

      <div className="rounded-xl border border-border bg-bg-subtle p-4 space-y-4">
        <div className="text-[12px] font-semibold text-fg">CLI Configuration</div>

        <Field label="Supported CLIs">
          <div className="flex gap-3">
            {ALL_CLIS.map((c) => (
              <label key={c} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={supportedClis.includes(c)}
                  onChange={() => toggleCli(c)}
                  className="w-3.5 h-3.5 accent-[var(--accent)]"
                />
                <span className="text-[13px]">{CLI_LABELS[c]}</span>
              </label>
            ))}
          </div>
        </Field>

        {supportedClis.length > 1 && (
          <Field label="Default CLI">
            <div className="flex gap-2">
              {supportedClis.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setDefaultCli(c)}
                  className={`px-3 py-1.5 rounded text-[12px] border transition-colors ${
                    defaultCli === c
                      ? "bg-accent-soft border-accent text-accent"
                      : "border-border text-muted hover:bg-bg-hover"
                  }`}
                >
                  {CLI_LABELS[c]}
                </button>
              ))}
            </div>
          </Field>
        )}

        {supportedClis.length > 1 ? (
          <div className="space-y-2">
            <div className="text-[11px] text-muted">Per-CLI model overrides (optional)</div>
            {supportedClis.map((c) => (
              <div key={c} className="grid grid-cols-[6rem_minmax(0,1fr)_9rem] items-center gap-3">
                <span className="text-[12px] text-muted w-24">{CLI_LABELS[c]}</span>
                <Select
                  value={cliModels[c] ?? ""}
                  onChange={(e) => setCliModels((prev) => ({ ...prev, [c]: e.target.value || undefined }))}
                  className="flex-1"
                >
                  {(modelsByCliCache[c] ?? []).map((m) => (
                    <option key={m.id} value={m.id}>{formatModelOption(m)}</option>
                  ))}
                </Select>
                <Select
                  value={cliReasoningEfforts[c] ?? ""}
                  onChange={(e) => setCliReasoningEfforts((prev) => ({
                    ...prev,
                    [c]: (e.target.value || undefined) as ModelReasoningEffort | undefined,
                  }))}
                >
                  <option value="">Default effort</option>
                  {reasoningEffortOptionsForCli(c, (modelsByCliCache[c] ?? []).find((m) => m.id === cliModels[c])).map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </Select>
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)_9rem] gap-3">
            <Field label={`Model (${CLI_LABELS[supportedClis[0] ?? DEFAULT_CLI]})`}>
              <Select
                value={cliModels[supportedClis[0] ?? DEFAULT_CLI] ?? ""}
                onChange={(e) => setCliModels({ [supportedClis[0] ?? DEFAULT_CLI]: e.target.value || undefined })}
              >
                {(modelsByCliCache[supportedClis[0]] ?? []).map((m) => (
                  <option key={m.id} value={m.id}>{formatModelOption(m)}</option>
                ))}
              </Select>
            </Field>
            <Field label="Effort">
              <Select
                value={cliReasoningEfforts[supportedClis[0] ?? DEFAULT_CLI] ?? ""}
                onChange={(e) => setCliReasoningEfforts({
                  [supportedClis[0] ?? DEFAULT_CLI]: (e.target.value || undefined) as ModelReasoningEffort | undefined,
                })}
              >
                <option value="">Default</option>
                {reasoningEffortOptionsForCli(
                  supportedClis[0] ?? DEFAULT_CLI,
                  (modelsByCliCache[supportedClis[0] ?? DEFAULT_CLI] ?? []).find((m) => m.id === cliModels[supportedClis[0] ?? DEFAULT_CLI]),
                ).map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </Select>
            </Field>
          </div>
        )}
      </div>

      <Field label={kind === "orchestrator" ? "Strategy prompt" : "System prompt"}>
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          required
          className="min-h-[160px] mono"
          placeholder={
            kind === "orchestrator"
              ? "You are an orchestrator. Dispatch slices to analyze the codebase…"
              : "You are a careful code reviewer…"
          }
        />
      </Field>

      {kind === "orchestrator" && (
        <>
          {/* ── Slices section ── */}
          <div className="rounded-xl border border-border bg-bg-subtle p-4 space-y-3">
            <div className="text-[12px] font-semibold text-fg">Slices</div>

            <label className="flex items-center gap-2 cursor-pointer text-[13px]">
              <input
                type="checkbox"
                checked={slicesAll}
                onChange={(e) => setSlicesAll(e.target.checked)}
                className="w-3.5 h-3.5 accent-[var(--accent)]"
              />
              <span>All slices (wildcard *)</span>
            </label>

            {!slicesAll && (
              <div className="space-y-1 max-h-56 overflow-y-auto border border-border rounded-lg p-2">
                {allSlices.length === 0 && (
                  <div className="text-[12px] text-muted px-1">No slices in catalog yet.</div>
                )}
                {allSlices.length > 0 && (
                  <label className="flex items-center gap-2 cursor-pointer text-[12px] pb-1 border-b border-border mb-1">
                    <input
                      type="checkbox"
                      checked={selectedSlices.size === allSlices.length}
                      onChange={(e) => {
                        if (e.target.checked) setSelectedSlices(new Set(allSlices.map((s) => s.id)));
                        else setSelectedSlices(new Set());
                      }}
                      className="w-3.5 h-3.5 accent-[var(--accent)]"
                    />
                    <span className="font-medium">Select all</span>
                  </label>
                )}
                {allSlices.map((s) => (
                  <label key={s.id} className="flex items-center gap-2 cursor-pointer text-[12px] py-0.5">
                    <input
                      type="checkbox"
                      checked={selectedSlices.has(s.id)}
                      onChange={(e) => {
                        setSelectedSlices((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(s.id);
                          else next.delete(s.id);
                          return next;
                        });
                      }}
                      className="w-3.5 h-3.5 accent-[var(--accent)]"
                    />
                    <span className="flex-1">{s.name}</span>
                    <span className="text-[10px] text-muted">{s.capability?.mutation}</span>
                  </label>
                ))}
              </div>
            )}

            <label className="flex items-center gap-2 cursor-pointer text-[13px]">
              <input
                type="checkbox"
                checked={canCreateCustomSlices}
                onChange={(e) => setCanCreateCustomSlices(e.target.checked)}
                className="w-3.5 h-3.5 accent-[var(--accent)]"
              />
              <span>Allow ad-hoc custom slices</span>
            </label>

            <div>
              <div className="label mb-1.5">Permitted mutation tiers</div>
              <div className="flex flex-wrap gap-3">
                {(["read-only", "writes-scratch", "writes-source"] as MutationTier[]).map((m) => (
                  <label key={m} className="flex items-center gap-2 cursor-pointer text-[13px]">
                    <input
                      type="checkbox"
                      checked={allowedMutations.has(m)}
                      onChange={(e) => {
                        setAllowedMutations((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(m);
                          else next.delete(m);
                          return next;
                        });
                      }}
                      className="w-3.5 h-3.5 accent-[var(--accent)]"
                    />
                    <span>{m}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          {/* ── Budget section ── */}
          <div className="rounded-xl border border-border bg-bg-subtle p-4 space-y-3">
            <div className="text-[12px] font-semibold text-fg">Budget</div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Max total tokens">
                <Input
                  type="number"
                  value={budget.max_total_tokens?.toString() ?? ""}
                  onChange={(e) => setBudget((b) => ({ ...b, max_total_tokens: e.target.value ? parseInt(e.target.value, 10) : undefined }))}
                  placeholder="200000"
                />
              </Field>
              <Field label="Max wallclock (seconds)">
                <Input
                  type="number"
                  value={budget.max_wallclock_seconds?.toString() ?? ""}
                  onChange={(e) => setBudget((b) => ({ ...b, max_wallclock_seconds: e.target.value ? parseInt(e.target.value, 10) : undefined }))}
                  placeholder="600"
                />
              </Field>
              <Field label="Max slice calls">
                <Input
                  type="number"
                  value={budget.max_slice_calls?.toString() ?? ""}
                  onChange={(e) => setBudget((b) => ({ ...b, max_slice_calls: e.target.value ? parseInt(e.target.value, 10) : undefined }))}
                  placeholder="15"
                />
              </Field>
              <Field label="Max recursion depth">
                <Input
                  type="number"
                  value={budget.max_recursion_depth?.toString() ?? ""}
                  onChange={(e) => setBudget((b) => ({ ...b, max_recursion_depth: e.target.value ? parseInt(e.target.value, 10) : undefined }))}
                  placeholder="3"
                />
              </Field>
            </div>
          </div>

          {/* ── Failure policy section ── */}
          <div className="rounded-xl border border-border bg-bg-subtle p-4 space-y-3">
            <div className="text-[12px] font-semibold text-fg">Failure policy</div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="On budget exceeded">
                <Select
                  value={onBudgetExceeded}
                  onChange={(e) => setOnBudgetExceeded(e.target.value as OnBudgetExceeded)}
                >
                  <option value="report-partial">Report partial results</option>
                  <option value="stop-hard">Stop immediately</option>
                </Select>
              </Field>
              <Field label="On slice failure">
                <Select
                  value={onSliceFailure}
                  onChange={(e) => setOnSliceFailure(e.target.value as OnSliceFailure)}
                >
                  <option value="continue">Continue (skip failed slice)</option>
                  <option value="retry-once">Retry once</option>
                  <option value="abort">Abort swarm</option>
                </Select>
              </Field>
            </div>
          </div>
        </>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Field label="Working directory (optional)">
          <DirPicker value={cwd} onChange={setCwd} />
        </Field>
        <Field label="Timeout seconds">
          <Input
            type="number"
            value={timeout}
            onChange={(e) => setTimeoutVal(e.target.value)}
          />
        </Field>
      </div>

      <Field label="Allowed tools (comma-separated, Claude only)">
        <Input
          value={allowedTools}
          onChange={(e) => setAllowedTools(e.target.value)}
          placeholder="Read, Grep, Bash, mcp__gitlab__*"
        />
      </Field>

      <Field label="Tags (comma-separated)">
        <Input
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="code, review"
        />
      </Field>

      <Field label="Cron schedule (optional — leave blank for on-demand only)">
        <Input
          value={cron}
          onChange={(e) => setCron(e.target.value)}
          placeholder="0 9 * * *"
          className="mono"
        />
      </Field>

      <div className="flex gap-2 justify-end pt-2">
        <Button type="button" variant="default" onClick={() => router.push("/agents")}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? "Saving…" : existing ? "Save changes" : "Create agent"}
        </Button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="label block mb-1.5">{label}</span>
      {children}
    </label>
  );
}
