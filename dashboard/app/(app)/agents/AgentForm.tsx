"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  Agent,
  AgentKind,
  CLI,
  MutationTier,
  OrchestratorBudget,
  OnBudgetExceeded,
  OnSliceFailure,
  SliceGraph,
} from "@/lib/runs";
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
  const [sliceGraph, setSliceGraph] = useState<SliceGraph>(
    existing?.slice_graph ?? { nodes: [], edges: [] }
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

  const selectedSliceIdsForSave = useMemo(() => {
    return Array.from(new Set([...selectedSlices, ...sliceGraph.nodes.map((node) => node.slice_id)]));
  }, [selectedSlices, sliceGraph.nodes]);

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
          slices_available: slicesAll ? "*" : selectedSliceIdsForSave,
          slice_graph: sliceGraph,
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
    <form onSubmit={(e) => { e.preventDefault(); save(); }} className="agent-form space-y-5">
      {error && (
        <Card className="p-3 border-[color-mix(in_srgb,var(--fail)_30%,var(--border))] text-[var(--fail)] text-sm">
          {error}
        </Card>
      )}

      <div className="agent-form-layout">
        <aside className="agent-form-rail" aria-label="Agent setup flow">
          <div className="agent-form-rail-title">Agent setup</div>
          <a href="#agent-basics">1. Basics</a>
          <a href="#agent-model">2. Model</a>
          <a href="#agent-prompt">3. Prompt</a>
          {kind === "orchestrator" && <a href="#agent-slices">4. Slices</a>}
          {kind === "orchestrator" && <a href="#agent-limits">5. Limits</a>}
          <a href="#agent-runtime">{kind === "orchestrator" ? "6" : "4"}. Runtime</a>
          <div className="agent-form-rail-summary">
            <span>{kind === "orchestrator" ? "Orchestrator" : "Chat agent"}</span>
            <strong>{name.trim() || id.trim() || "Untitled agent"}</strong>
          </div>
        </aside>

        <div className="agent-form-content">
          <section id="agent-basics" className="agent-form-card">
            <SectionIntro
              eyebrow="Step 1"
              title="Basics"
              description="Name the agent and choose whether it runs as a direct chat agent or an orchestrator."
            />

            <div className="flex gap-2 items-center">
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

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
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
          </section>

          <section id="agent-model" className="agent-form-card">
            <SectionIntro
              eyebrow="Step 2"
              title="Model and CLI"
              description="Pick the CLIs this agent can run on and set model defaults."
            />

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
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_12rem] gap-3">
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
          </section>

          <section id="agent-prompt" className="agent-form-card">
            <SectionIntro
              eyebrow="Step 3"
              title={kind === "orchestrator" ? "Strategy prompt" : "System prompt"}
              description={kind === "orchestrator"
                ? "Describe how this orchestrator should delegate, synthesize, and decide when it is done."
                : "Define the behavior and standards this agent should follow."}
            />
            <Field label={kind === "orchestrator" ? "Strategy prompt" : "System prompt"}>
              <Textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                required
                className="min-h-[260px] mono"
                placeholder={
                  kind === "orchestrator"
                    ? "You are an orchestrator. Dispatch slices to analyze the codebase…"
                    : "You are a careful code reviewer…"
                }
              />
            </Field>
          </section>

      {kind === "orchestrator" && (
        <>
          {/* ── Slices section ── */}
          <section id="agent-slices" className="agent-form-card space-y-3">
            <SectionIntro
              eyebrow="Step 4"
              title="Slices"
              description="Choose the specialist slices this orchestrator can call, then arrange an optional workflow."
            />

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

            {!slicesAll && (
              <SliceWorkflowGraph
                slices={allSlices}
                graph={sliceGraph}
                onGraphChange={setSliceGraph}
                selectedSlices={selectedSlices}
                onSelectedSlicesChange={setSelectedSlices}
              />
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
          </section>

          {/* ── Budget section ── */}
          <section id="agent-limits" className="agent-form-card">
            <SectionIntro
              eyebrow="Step 5"
              title="Limits and failure policy"
              description="Set guardrails for orchestrated runs so the agent stays predictable."
            />
            <div className="rounded-lg border border-border bg-bg-subtle p-4 space-y-3">
            <div className="text-[12px] font-semibold text-fg">Budget</div>
            <div className="grid grid-cols-1 lg:grid-cols-4 gap-3">
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
          <div className="rounded-lg border border-border bg-bg-subtle p-4 space-y-3">
            <div className="text-[12px] font-semibold text-fg">Failure policy</div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
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
          </section>
        </>
      )}

          <section id="agent-runtime" className="agent-form-card">
            <SectionIntro
              eyebrow={kind === "orchestrator" ? "Step 6" : "Step 4"}
              title="Runtime"
              description="Optional working directory, tool allowlist, tags, and schedule settings."
            />

            <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_14rem] gap-3">
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
          </section>

          <div className="agent-form-actions">
            <Button type="button" variant="default" onClick={() => router.push("/agents")}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? "Saving…" : existing ? "Save changes" : "Create agent"}
            </Button>
          </div>
        </div>
      </div>
    </form>
  );
}

function SectionIntro({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="agent-form-section-intro">
      <span>{eyebrow}</span>
      <div>
        <h2>{title}</h2>
        <p>{description}</p>
      </div>
    </div>
  );
}

const NODE_WIDTH = 220;
const NODE_HEIGHT = 128;
const NODE_PORT_Y = NODE_HEIGHT / 2;

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function connectionPath(x1: number, y1: number, x2: number, y2: number): string {
  const distance = Math.abs(x2 - x1);
  const handle = Math.max(74, Math.min(180, distance * 0.46));
  return `M ${x1} ${y1} C ${x1 + handle} ${y1}, ${x2 - handle} ${y2}, ${x2} ${y2}`;
}

function SliceWorkflowGraph({
  slices,
  graph,
  onGraphChange,
  selectedSlices,
  onSelectedSlicesChange,
}: {
  slices: Slice[];
  graph: SliceGraph;
  onGraphChange: React.Dispatch<React.SetStateAction<SliceGraph>>;
  selectedSlices: Set<string>;
  onSelectedSlicesChange: React.Dispatch<React.SetStateAction<Set<string>>>;
}) {
  const canvasRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<{ nodeId: string; offsetX: number; offsetY: number } | null>(null);
  const [connectionDrag, setConnectionDrag] = useState<{ fromNodeId: string; x: number; y: number } | null>(null);
  const [connectionTarget, setConnectionTarget] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(graph.nodes[0]?.id ?? null);
  const [fullscreen, setFullscreen] = useState(false);

  const sliceById = useMemo(() => new Map(slices.map((slice) => [slice.id, slice])), [slices]);
  const placedSliceIds = useMemo(() => new Set(graph.nodes.map((node) => node.slice_id)), [graph.nodes]);
  const selectedNode = useMemo(
    () => graph.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [graph.nodes, selectedNodeId],
  );

  useEffect(() => {
    if (selectedNodeId && graph.nodes.some((node) => node.id === selectedNodeId)) return;
    setSelectedNodeId(graph.nodes[0]?.id ?? null);
  }, [graph.nodes, selectedNodeId]);

  useEffect(() => {
    if (!fullscreen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [fullscreen]);

  const addNode = (sliceId: string, x?: number, y?: number) => {
    const slice = sliceById.get(sliceId);
    if (!slice) return;
    const fallbackX = 48 + (graph.nodes.length % 3) * 284;
    const fallbackY = 48 + Math.floor(graph.nodes.length / 3) * 164;
    const node = {
      id: `node-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      slice_id: slice.id,
      x: clamp(x ?? fallbackX, 12, 540),
      y: clamp(y ?? fallbackY, 12, 300),
      label: slice.name,
    };
    onGraphChange((current) => ({ ...current, nodes: [...current.nodes, node] }));
    setSelectedNodeId(node.id);
    onSelectedSlicesChange((current) => {
      const next = new Set(current);
      next.add(slice.id);
      return next;
    });
  };

  const removeNode = (nodeId: string) => {
    onGraphChange((current) => ({
      nodes: current.nodes.filter((node) => node.id !== nodeId),
      edges: current.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
    }));
    setConnectionDrag((current) => (current?.fromNodeId === nodeId ? null : current));
    setConnectionTarget((current) => (current === nodeId ? null : current));
    setSelectedNodeId((current) => (current === nodeId ? null : current));
  };

  const updateNode = (nodeId: string, patch: Partial<SliceGraph["nodes"][number]>) => {
    onGraphChange((current) => ({
      ...current,
      nodes: current.nodes.map((node) => (
        node.id === nodeId ? { ...node, ...patch } : node
      )),
    }));
  };

  const addEdge = (fromNodeId: string, toNodeId: string) => {
    if (fromNodeId === toNodeId) return;
    onGraphChange((current) => {
      const exists = current.edges.some((edge) => edge.from === fromNodeId && edge.to === toNodeId);
      if (exists) return current;
      return {
        ...current,
        edges: [...current.edges, { id: `edge-${fromNodeId}-${toNodeId}`, from: fromNodeId, to: toNodeId }],
      };
    });
  };

  const canvasPoint = (clientX: number, clientY: number) => {
    if (!canvasRef.current) return null;
    const rect = canvasRef.current.getBoundingClientRect();
    return {
      x: clamp(clientX - rect.left, 0, rect.width),
      y: clamp(clientY - rect.top, 0, rect.height),
    };
  };

  const findConnectionTargetAt = (fromNodeId: string, clientX: number, clientY: number) => {
    const point = canvasPoint(clientX, clientY);
    if (!point) return null;
    const candidates = graph.nodes
      .filter((node) => node.id !== fromNodeId)
      .map((node) => {
        const portX = node.x;
        const portY = node.y + NODE_PORT_Y;
        return {
          node,
          portDistance: Math.hypot(point.x - portX, point.y - portY),
          containsPoint:
            point.x >= node.x &&
            point.x <= node.x + NODE_WIDTH &&
            point.y >= node.y &&
            point.y <= node.y + NODE_HEIGHT,
        };
      })
      .sort((a, b) => a.portDistance - b.portDistance);
    const nearestPort = candidates.find((candidate) => candidate.portDistance <= 42);
    if (nearestPort) return nearestPort.node.id;
    return candidates.find((candidate) => candidate.containsPoint)?.node.id ?? null;
  };

  const startConnectionDrag = (nodeId: string, e: React.PointerEvent<HTMLButtonElement>) => {
    const point = canvasPoint(e.clientX, e.clientY);
    if (!point) return;
    e.preventDefault();
    e.stopPropagation();
    setSelectedNodeId(nodeId);
    setDragging(null);
    setConnectionDrag({ fromNodeId: nodeId, ...point });
    setConnectionTarget(null);
  };

  const finishConnectionDrag = (nodeId: string) => {
    if (!connectionDrag) return;
    addEdge(connectionDrag.fromNodeId, nodeId);
    setConnectionDrag(null);
    setConnectionTarget(null);
  };

  const removeEdge = (edgeId: string) => {
    onGraphChange((current) => ({
      ...current,
      edges: current.edges.filter((edge) => edge.id !== edgeId),
    }));
  };

  const arrangeGraph = () => {
    onGraphChange((current) => ({
      ...current,
      nodes: current.nodes.map((node, i) => ({
        ...node,
        x: 28 + (i % 3) * 284,
        y: 32 + Math.floor(i / 3) * 164,
      })),
    }));
  };

  const clearGraph = () => {
    onGraphChange({ nodes: [], edges: [] });
    setConnectionDrag(null);
    setConnectionTarget(null);
    setSelectedNodeId(null);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const sliceId = e.dataTransfer.getData("application/saturn-slice-id");
    if (!sliceId || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    addNode(
      sliceId,
      e.clientX - rect.left - NODE_WIDTH / 2,
      e.clientY - rect.top - NODE_HEIGHT / 2,
    );
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (connectionDrag) {
      const point = canvasPoint(e.clientX, e.clientY);
      if (point) setConnectionDrag((current) => current ? { ...current, ...point } : current);
      return;
    }
    if (!dragging || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const maxX = Math.max(12, rect.width - NODE_WIDTH - 12);
    const maxY = Math.max(12, rect.height - NODE_HEIGHT - 12);
    const x = clamp(e.clientX - rect.left - dragging.offsetX, 12, maxX);
    const y = clamp(e.clientY - rect.top - dragging.offsetY, 12, maxY);
    onGraphChange((current) => ({
      ...current,
      nodes: current.nodes.map((node) => (
        node.id === dragging.nodeId ? { ...node, x, y } : node
      )),
    }));
  };

  const handleCanvasPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (connectionDrag) {
      const targetId = connectionTarget ?? findConnectionTargetAt(connectionDrag.fromNodeId, e.clientX, e.clientY);
      if (targetId) addEdge(connectionDrag.fromNodeId, targetId);
    }
    setDragging(null);
    setConnectionDrag(null);
    setConnectionTarget(null);
  };

  const edgesWithNodes = graph.edges
    .map((edge) => {
      const from = graph.nodes.find((node) => node.id === edge.from);
      const to = graph.nodes.find((node) => node.id === edge.to);
      if (!from || !to) return null;
      return { edge, from, to };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);

  return (
    <div className={fullscreen ? "slice-workflow-builder fullscreen" : "slice-workflow-builder"}>
      <div className="slice-workflow-header">
        <div className="min-w-0">
          <div className="slice-workflow-title">Slice workflow</div>
          <div className="slice-workflow-subtitle">Drag slices onto the canvas, then connect the order of work.</div>
        </div>
        <div className="slice-workflow-actions">
          <button
            type="button"
            onClick={arrangeGraph}
            disabled={graph.nodes.length === 0}
            className="slice-workflow-action"
          >
            Arrange
          </button>
          <button
            type="button"
            onClick={clearGraph}
            disabled={graph.nodes.length === 0}
            className="slice-workflow-action"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => setFullscreen((value) => !value)}
            className="slice-workflow-action primary"
            aria-label={fullscreen ? "Exit full screen workflow" : "Open workflow full screen"}
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              {fullscreen ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M8 3v5H3M16 3v5h5M8 21v-5H3M16 21v-5h5" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
              )}
            </svg>
            {fullscreen ? "Exit full screen" : "Full screen"}
          </button>
        </div>
      </div>

      <div className="slice-workflow-grid">
        <div className="slice-workflow-palette">
          <div className="mb-2 text-[10px] uppercase tracking-wider text-subtle">Palette</div>
          <div className="slice-workflow-palette-list">
            {slices.length === 0 && (
              <div className="rounded-md border border-border bg-bg px-3 py-6 text-center text-[12px] text-subtle">
                No slices available
              </div>
            )}
            {slices.map((slice) => {
              const placed = placedSliceIds.has(slice.id);
              const selected = selectedSlices.has(slice.id) || placed;
              return (
                <div
                  key={slice.id}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("application/saturn-slice-id", slice.id);
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  className={[
                    "rounded-md border p-2 transition-colors cursor-grab active:cursor-grabbing",
                    selected
                      ? "border-accent bg-accent-soft/40"
                      : "border-border bg-bg hover:bg-bg-hover",
                  ].join(" ")}
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px] font-medium text-fg">{slice.name}</div>
                      <div className="truncate text-[10px] text-muted">{slice.id}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => addNode(slice.id)}
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-border text-muted hover:bg-bg-hover hover:text-fg"
                      title={`Add ${slice.name}`}
                      aria-label={`Add ${slice.name}`}
                    >
                      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.4} d="M12 5v14M5 12h14" />
                      </svg>
                    </button>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1">
                    <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-subtle">
                      {slice.capability?.mutation}
                    </span>
                    <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-subtle">
                      {slice.capability?.output.kind}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="slice-workflow-main">
          <div
            ref={canvasRef}
            className="slice-workflow-canvas"
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
            }}
            onDrop={handleDrop}
            onPointerMove={handlePointerMove}
            onPointerUp={handleCanvasPointerUp}
            onPointerCancel={handleCanvasPointerUp}
          >
            <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
              <defs>
                <marker id="slice-workflow-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
                </marker>
              </defs>
              {edgesWithNodes.map(({ edge, from, to }) => {
                const x1 = from.x + NODE_WIDTH;
                const y1 = from.y + NODE_PORT_Y;
                const x2 = to.x;
                const y2 = to.y + NODE_PORT_Y;
                return (
                  <path
                    key={edge.id}
                    d={connectionPath(x1, y1, x2, y2)}
                    className="slice-workflow-edge"
                    markerEnd="url(#slice-workflow-arrow)"
                  />
                );
              })}
              {connectionDrag && (() => {
                const from = graph.nodes.find((node) => node.id === connectionDrag.fromNodeId);
                if (!from) return null;
                const target = connectionTarget
                  ? graph.nodes.find((node) => node.id === connectionTarget)
                  : null;
                const x1 = from.x + NODE_WIDTH;
                const y1 = from.y + NODE_PORT_Y;
                const x2 = target ? target.x : connectionDrag.x;
                const y2 = target ? target.y + NODE_PORT_Y : connectionDrag.y;
                return (
                  <path
                    d={connectionPath(x1, y1, x2, y2)}
                    className="slice-workflow-edge preview"
                    markerEnd="url(#slice-workflow-arrow)"
                  />
                );
              })()}
            </svg>

            {graph.nodes.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center text-[12px] text-subtle">
                No slices placed
              </div>
            )}

            {graph.nodes.map((node) => {
              const slice = sliceById.get(node.slice_id);
              const isConnectionSource = connectionDrag?.fromNodeId === node.id;
              const isConnectionTarget = connectionTarget === node.id;
              return (
                <div
                  key={node.id}
                  className={[
                    "slice-workflow-node absolute select-none rounded-lg border bg-bg p-3 shadow-sm transition-shadow",
                    isConnectionSource || isConnectionTarget ? "border-accent shadow-lg" : "border-border",
                    dragging?.nodeId === node.id ? "cursor-grabbing" : "cursor-grab",
                  ].join(" ")}
                  style={{ left: node.x, top: node.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
                  onPointerEnter={() => {
                    if (connectionDrag && connectionDrag.fromNodeId !== node.id) {
                      setConnectionTarget(node.id);
                    }
                  }}
                  onPointerLeave={() => {
                    setConnectionTarget((current) => (current === node.id ? null : current));
                  }}
                  onPointerDown={(e) => {
                    if (!canvasRef.current) return;
                    const rect = canvasRef.current.getBoundingClientRect();
                    setSelectedNodeId(node.id);
                    setDragging({
                      nodeId: node.id,
                      offsetX: e.clientX - rect.left - node.x,
                      offsetY: e.clientY - rect.top - node.y,
                    });
                  }}
                  onPointerUp={(e) => {
                    if (connectionDrag && connectionDrag.fromNodeId !== node.id) {
                      e.stopPropagation();
                      finishConnectionDrag(node.id);
                    }
                  }}
                >
                  <button
                    type="button"
                    className={[
                      "slice-workflow-port input",
                      connectionDrag && connectionDrag.fromNodeId !== node.id ? "targetable" : "",
                      isConnectionTarget ? "active" : "",
                    ].filter(Boolean).join(" ")}
                    aria-label={`Connect into ${slice?.name ?? node.slice_id}`}
                    onPointerDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                    }}
                    onPointerUp={(e) => {
                      e.stopPropagation();
                      finishConnectionDrag(node.id);
                    }}
                    onPointerEnter={() => {
                      if (connectionDrag && connectionDrag.fromNodeId !== node.id) {
                        setConnectionTarget(node.id);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className={[
                      "slice-workflow-port output",
                      isConnectionSource ? "active" : "",
                    ].filter(Boolean).join(" ")}
                    aria-label={`Connect from ${slice?.name ?? node.slice_id}`}
                    onPointerDown={(e) => startConnectionDrag(node.id, e)}
                  />
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-semibold text-fg">{node.label || slice?.name || node.slice_id}</div>
                      <div className="truncate text-[10.5px] text-muted">{node.slice_id}</div>
                    </div>
                    <button
                      type="button"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => removeNode(node.id)}
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-subtle hover:bg-bg-hover hover:text-fg"
                      title="Remove node"
                      aria-label={`Remove ${slice?.name ?? node.slice_id}`}
                    >
                      <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-1.5">
                    <span className="slice-workflow-node-pill">
                      {slice?.capability?.mutation ?? "slice"}
                    </span>
                    <span className="slice-workflow-node-pill">
                      {slice?.capability?.output.kind ?? "output"}
                    </span>
                  </div>
                  {(node.instructions || node.prompt || node.config) && (
                    <div className="mt-2 truncate text-[10px] text-subtle">
                      {node.instructions || node.prompt || node.config}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {edgesWithNodes.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {edgesWithNodes.map(({ edge, from, to }) => {
                const fromSlice = sliceById.get(from.slice_id);
                const toSlice = sliceById.get(to.slice_id);
                return (
                  <div key={edge.id} className="flex items-center gap-1 rounded-md border border-border bg-bg px-2 py-1 text-[11px] text-muted">
                    <span className="max-w-[120px] truncate">{fromSlice?.name ?? from.slice_id}</span>
                    <span className="text-accent">-&gt;</span>
                    <span className="max-w-[120px] truncate">{toSlice?.name ?? to.slice_id}</span>
                    <button
                      type="button"
                      onClick={() => removeEdge(edge.id)}
                      className="ml-1 text-subtle hover:text-fg"
                      title="Remove connection"
                      aria-label="Remove connection"
                    >
                      <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {selectedNode && (
            <div className="slice-workflow-node-editor">
              <div className="mb-3 flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-[12px] font-semibold text-fg">Node editor</div>
                  <div className="truncate text-[10px] text-muted">{selectedNode.id}</div>
                </div>
                <button
                  type="button"
                  onClick={() => removeNode(selectedNode.id)}
                  className="rounded-md border border-border px-2 py-1 text-[11px] text-muted hover:bg-bg-hover hover:text-fg"
                >
                  Remove node
                </button>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <Field label="Node label">
                  <Input
                    value={selectedNode.label ?? ""}
                    onChange={(e) => updateNode(selectedNode.id, { label: e.target.value })}
                    placeholder={sliceById.get(selectedNode.slice_id)?.name ?? selectedNode.slice_id}
                  />
                </Field>
                <Field label="Slice">
                  <Select
                    value={selectedNode.slice_id}
                    onChange={(e) => {
                      const nextSlice = sliceById.get(e.target.value);
                      updateNode(selectedNode.id, {
                        slice_id: e.target.value,
                        label: selectedNode.label || nextSlice?.name || e.target.value,
                      });
                      onSelectedSlicesChange((current) => {
                        const next = new Set(current);
                        next.add(e.target.value);
                        return next;
                      });
                    }}
                  >
                    {!sliceById.has(selectedNode.slice_id) && (
                      <option value={selectedNode.slice_id}>Missing slice: {selectedNode.slice_id}</option>
                    )}
                    {slices.map((slice) => (
                      <option key={slice.id} value={slice.id}>{slice.name}</option>
                    ))}
                  </Select>
                </Field>
              </div>

              <div className="mt-3 grid gap-3 lg:grid-cols-3">
                <Field label="Instructions">
                  <Textarea
                    value={selectedNode.instructions ?? ""}
                    onChange={(e) => updateNode(selectedNode.id, { instructions: e.target.value })}
                    placeholder="What this node should accomplish"
                    className="min-h-[96px]"
                  />
                </Field>
                <Field label="Node prompt">
                  <Textarea
                    value={selectedNode.prompt ?? ""}
                    onChange={(e) => updateNode(selectedNode.id, { prompt: e.target.value })}
                    placeholder="Optional prompt override or extra context"
                    className="min-h-[96px] mono"
                  />
                </Field>
                <Field label="Config">
                  <Textarea
                    value={selectedNode.config ?? ""}
                    onChange={(e) => updateNode(selectedNode.id, { config: e.target.value })}
                    placeholder='Optional JSON or freeform config'
                    className="min-h-[96px] mono"
                  />
                </Field>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
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
