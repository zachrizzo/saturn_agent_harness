"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Slice, SliceMutationTier, SliceCostTier, SliceScope, SliceOutputKind, SliceInteractivity, SliceSandboxMode, SliceSandboxNet } from "@/lib/slices";
import type { CLI } from "@/lib/runs";
import type { Model } from "@/lib/models";
import { formatModelOption } from "@/lib/models";
import { CLI_LABELS, CLI_VALUES, normalizeCli } from "@/lib/clis";
import { Button, Card, Input, Select, Textarea } from "@/app/components/ui";

const ALL_CLIS: CLI[] = [...CLI_VALUES];
const SCOPE_OPTIONS: SliceScope[] = ["single-file", "directory", "repo", "multi-repo", "internet"];
const MUTATION_OPTIONS: SliceMutationTier[] = ["read-only", "writes-scratch", "writes-source", "executes-side-effects"];
const COST_OPTIONS: SliceCostTier[] = ["free", "cheap", "premium"];
const OUTPUT_KIND_OPTIONS: SliceOutputKind[] = ["structured", "markdown", "code-patch", "no-output"];
const INTERACTIVITY_OPTIONS: SliceInteractivity[] = ["one-shot", "multi-turn"];
const SANDBOX_MODE_OPTIONS: SliceSandboxMode[] = ["none", "tmpfs", "worktree"];
const SANDBOX_NET_OPTIONS: SliceSandboxNet[] = ["allow", "deny"];

function parseVariables(template: string): string[] {
  const matches = template.match(/\{\{([^}]+)\}\}/g) ?? [];
  const names = matches.map((m) => m.slice(2, -2).trim());
  return [...new Set(names)];
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function SliceForm({ existing }: { existing?: Slice } = {}) {
  const router = useRouter();

  // Basics
  const [id, setId] = useState(existing?.id ?? "");
  const [idTouched, setIdTouched] = useState(!!existing);
  const [name, setName] = useState(existing?.name ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [tags, setTags] = useState((existing?.tags ?? []).join(", "));

  // Execution
  const [cli, setCli] = useState<CLI>(normalizeCli(existing?.cli));
  const [model, setModel] = useState(existing?.model ?? "");
  const [timeout, setTimeoutVal] = useState(existing?.budget?.timeout_seconds?.toString() ?? "");
  const [models, setModels] = useState<Model[]>([]);

  // Capability
  const [mutation, setMutation] = useState<SliceMutationTier>(existing?.capability?.mutation ?? "read-only");
  const [scope, setScope] = useState<SliceScope[]>(existing?.capability?.scope ?? ["repo"]);
  const [outputKind, setOutputKind] = useState<SliceOutputKind>(existing?.capability?.output?.kind ?? "markdown");
  const [interactivity, setInteractivity] = useState<SliceInteractivity>(existing?.capability?.interactivity ?? "one-shot");
  const [costTier, setCostTier] = useState<SliceCostTier>(existing?.capability?.cost_tier ?? "cheap");

  // Tools
  const [allowedTools, setAllowedTools] = useState((existing?.allowedTools ?? []).join(", "));

  // Prompt template
  const [systemPrompt, setSystemPrompt] = useState(existing?.prompt_template?.system ?? "");
  const [requiredVars, setRequiredVars] = useState<Set<string>>(
    new Set(existing?.prompt_template?.required ?? [])
  );
  const knownVarsRef = useRef(new Set(existing?.prompt_template?.variables ?? []));

  // Sandbox
  const [sandboxMode, setSandboxMode] = useState<SliceSandboxMode>(existing?.sandbox?.mode ?? "none");
  const [sandboxNet, setSandboxNet] = useState<SliceSandboxNet>(existing?.sandbox?.net ?? "deny");

  // I/O Schema
  const [ioSchema, setIoSchema] = useState(
    existing?.io_schema ? JSON.stringify(existing.io_schema, null, 2) : ""
  );
  const [ioSchemaError, setIoSchemaError] = useState<string | null>(null);

  // Budget
  const [maxTokens, setMaxTokens] = useState(existing?.budget?.max_tokens?.toString() ?? "");

  // Save state
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(!!existing);

  // Fetch models when cli changes
  useEffect(() => {
    fetch(`/api/models?cli=${cli}`)
      .then((r) => r.json())
      .then((data) => setModels(data.models ?? []))
      .catch(() => setModels([]));
  }, [cli]);

  // Auto-detect variables from prompt template
  const detectedVars = useMemo(() => parseVariables(systemPrompt), [systemPrompt]);
  const detectedVarsKey = detectedVars.join("\u0000");

  useEffect(() => {
    if (existing || idTouched) return;
    setId(slugify(name));
  }, [existing, idTouched, name]);

  useEffect(() => {
    setRequiredVars((prev) => {
      const detected = new Set(detectedVars);
      const next = new Set([...prev].filter((v) => detected.has(v)));
      let changed = next.size !== prev.size;

      for (const v of detectedVars) {
        if (!knownVarsRef.current.has(v)) {
          next.add(v);
          changed = true;
        }
      }

      knownVarsRef.current = detected;
      return changed ? next : prev;
    });
  }, [detectedVarsKey]);

  const toggleScope = (s: SliceScope) => {
    setScope((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]
    );
  };

  const toggleRequiredVar = (v: string) => {
    setRequiredVars((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  };

  const save = async () => {
    setIoSchemaError(null);
    if (!id.trim() || !name.trim() || !systemPrompt.trim()) {
      setError("Name, ID, and prompt are required");
      return;
    }

    // Validate io_schema JSON if provided
    let parsedIoSchema: { output?: unknown } | undefined;
    if (ioSchema.trim()) {
      try {
        parsedIoSchema = JSON.parse(ioSchema.trim());
      } catch {
        setIoSchemaError("Invalid JSON in I/O schema");
        return;
      }
    }

    setSaving(true);
    setError(null);

    try {
      const body: Partial<Slice> = {
        id: id.trim(),
        name: name.trim(),
        description: description.trim() || undefined,
        cli,
        model: model || undefined,
        allowedTools: allowedTools.split(",").map((s) => s.trim()).filter(Boolean),
        tags: tags.split(",").map((s) => s.trim()).filter(Boolean),
        capability: {
          mutation,
          scope: scope.length > 0 ? scope : ["repo"],
          output: { kind: outputKind },
          interactivity,
          cost_tier: costTier,
        },
        prompt_template: {
          system: systemPrompt,
          variables: detectedVars,
          required: detectedVars.filter((v) => requiredVars.has(v)),
        },
        sandbox: { mode: sandboxMode, net: sandboxNet },
        io_schema: parsedIoSchema,
        budget: {
          max_tokens: maxTokens ? parseInt(maxTokens, 10) : undefined,
          timeout_seconds: timeout ? parseInt(timeout, 10) : undefined,
        },
      };

      const url = existing
        ? `/api/slices/${encodeURIComponent(existing.id)}`
        : "/api/slices";
      const method = existing ? "PUT" : "POST";

      const res = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error ?? "failed");
      }

      router.push("/slices");
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
      setSaving(false);
    }
  };

  const showSandboxWarning =
    mutation === "writes-source" && sandboxMode === "none";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
      className="space-y-5 max-w-3xl"
    >
      {error && (
        <Card className="p-3 border-[color-mix(in_srgb,var(--fail)_30%,var(--border))] text-[var(--fail)] text-sm">
          {error}
        </Card>
      )}

      {/* ── Section 1: Basics ── */}
      <div className="rounded-xl border border-border bg-bg-subtle p-4 space-y-4">
        <div className="text-[12px] font-semibold text-fg">
          {existing ? "Basics" : "Essentials"}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              placeholder="Security Reviewer"
            />
          </Field>
          <Field label="ID">
            <Input
              value={id}
              onChange={(e) => {
                setIdTouched(true);
                setId(e.target.value);
              }}
              disabled={!!existing}
              required
              placeholder="security-reviewer"
            />
          </Field>
        </div>
        <Field label="Description">
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Short summary shown in the catalog"
          />
        </Field>
        {existing ? (
          <Field label="Tags (comma-separated)">
            <Input
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="security, code-review"
            />
          </Field>
        ) : (
          <>
            <Field label="Prompt">
              <Textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                className="min-h-[240px] mono text-[12px]"
                placeholder={
                  "You are a specialist. Focus: {{focus}}.\nReturn a concise markdown result with the most important details first."
                }
                required
              />
            </Field>
            {detectedVars.length > 0 && (
              <div className="space-y-2">
                <div className="text-[11px] text-muted font-medium">
                  Variables detected ({detectedVars.length})
                </div>
                <div className="space-y-1">
                  {detectedVars.map((v) => (
                    <label key={v} className="flex items-center gap-3 text-[12px] cursor-pointer">
                      <code className="text-[11px] bg-bg border border-border px-1.5 py-0.5 rounded mono flex-1">
                        {`{{${v}}}`}
                      </code>
                      <input
                        type="checkbox"
                        checked={requiredVars.has(v)}
                        onChange={() => toggleRequiredVar(v)}
                        className="w-3.5 h-3.5 accent-[var(--accent)]"
                      />
                      <span className="text-muted">required</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <details
        open={advancedOpen}
        onToggle={(e) => setAdvancedOpen(e.currentTarget.open)}
        className="space-y-4"
      >
        <summary className="cursor-pointer select-none text-[12px] font-medium text-muted hover:text-fg">
          {existing ? "Configuration" : "Advanced options"}
          {!existing && (
            <span className="ml-2 text-subtle font-normal">
              CLI, tools, sandbox, schema, budget
            </span>
          )}
        </summary>
        <div className="space-y-4">
          {!existing && (
            <div className="rounded-xl border border-border bg-bg-subtle p-4 space-y-3">
              <div className="text-[12px] font-semibold text-fg">Metadata</div>
              <Field label="Tags (comma-separated)">
                <Input
                  value={tags}
                  onChange={(e) => setTags(e.target.value)}
                  placeholder="security, code-review"
                />
              </Field>
            </div>
          )}

      {/* ── Section 2: Execution ── */}
      <div className="rounded-xl border border-border bg-bg-subtle p-4 space-y-4">
        <div className="text-[12px] font-semibold text-fg">Execution</div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <Field label="CLI">
            <Select value={cli} onChange={(e) => { setCli(e.target.value as CLI); setModel(""); }}>
              {ALL_CLIS.map((c) => (
                <option key={c} value={c}>{CLI_LABELS[c]}</option>
              ))}
            </Select>
          </Field>
          <Field label="Model">
            <Select value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">— CLI default —</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>{formatModelOption(m)}</option>
              ))}
            </Select>
          </Field>
          <Field label="Timeout (seconds)">
            <Input
              type="number"
              value={timeout}
              onChange={(e) => setTimeoutVal(e.target.value)}
              placeholder="180"
            />
          </Field>
        </div>
      </div>

      {/* ── Section 3: Capability ── */}
      <div className="rounded-xl border border-border bg-bg-subtle p-4 space-y-4">
        <div className="text-[12px] font-semibold text-fg">Capability</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Mutation tier">
            <Select value={mutation} onChange={(e) => setMutation(e.target.value as SliceMutationTier)}>
              {MUTATION_OPTIONS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </Select>
          </Field>
          <Field label="Cost tier">
            <Select value={costTier} onChange={(e) => setCostTier(e.target.value as SliceCostTier)}>
              {COST_OPTIONS.map((c) => (
                <option key={c} value={c}>{c}</option>
              ))}
            </Select>
          </Field>
          <Field label="Output kind">
            <Select value={outputKind} onChange={(e) => setOutputKind(e.target.value as SliceOutputKind)}>
              {OUTPUT_KIND_OPTIONS.map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </Select>
          </Field>
          <Field label="Interactivity">
            <Select value={interactivity} onChange={(e) => setInteractivity(e.target.value as SliceInteractivity)}>
              {INTERACTIVITY_OPTIONS.map((i) => (
                <option key={i} value={i}>{i}</option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Scope (select all that apply)">
          <div className="flex flex-wrap gap-3 mt-1">
            {SCOPE_OPTIONS.map((s) => (
              <label key={s} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={scope.includes(s)}
                  onChange={() => toggleScope(s)}
                  className="w-3.5 h-3.5 accent-[var(--accent)]"
                />
                <span className="text-[13px]">{s}</span>
              </label>
            ))}
          </div>
        </Field>
      </div>

      {/* ── Section 4: Tools ── */}
      <div className="rounded-xl border border-border bg-bg-subtle p-4 space-y-3">
        <div className="text-[12px] font-semibold text-fg">Tools</div>
        <Field label="Allowed tools (comma-separated)">
          <Input
            value={allowedTools}
            onChange={(e) => setAllowedTools(e.target.value)}
            placeholder="Read, Grep, Glob, Bash(git log:*)"
          />
        </Field>
      </div>

      {existing && (
        <div className="rounded-xl border border-border bg-bg-subtle p-4 space-y-3">
          <div className="text-[12px] font-semibold text-fg">Prompt template</div>
          <Field label="System prompt">
            <Textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              className="min-h-[200px] mono text-[12px]"
              placeholder={"You are a specialist. Focus: {{focus}}.\nReturn only a fenced ```findings.json``` block."}
              required
            />
          </Field>
          {detectedVars.length > 0 && (
            <div className="space-y-2">
              <div className="text-[11px] text-muted font-medium">
                Variables detected ({detectedVars.length})
              </div>
              <div className="space-y-1">
                {detectedVars.map((v) => (
                  <label key={v} className="flex items-center gap-3 text-[12px] cursor-pointer">
                    <code className="text-[11px] bg-bg border border-border px-1.5 py-0.5 rounded mono flex-1">
                      {`{{${v}}}`}
                    </code>
                    <input
                      type="checkbox"
                      checked={requiredVars.has(v)}
                      onChange={() => toggleRequiredVar(v)}
                      className="w-3.5 h-3.5 accent-[var(--accent)]"
                    />
                    <span className="text-muted">required</span>
                  </label>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Section 6: Sandbox ── */}
      <div className="rounded-xl border border-border bg-bg-subtle p-4 space-y-3">
        <div className="text-[12px] font-semibold text-fg">Sandbox</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Mode">
            <Select value={sandboxMode} onChange={(e) => setSandboxMode(e.target.value as SliceSandboxMode)}>
              {SANDBOX_MODE_OPTIONS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </Select>
          </Field>
          <Field label="Network">
            <Select value={sandboxNet} onChange={(e) => setSandboxNet(e.target.value as SliceSandboxNet)}>
              {SANDBOX_NET_OPTIONS.map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </Select>
          </Field>
        </div>
        {showSandboxWarning && (
          <div className="rounded-lg border border-[color-mix(in_srgb,var(--warn)_40%,var(--border))] bg-[color-mix(in_srgb,var(--warn)_8%,var(--bg))] px-3 py-2 text-[12px] text-[var(--warn)]">
            Warning: writes-source slices should use worktree sandbox to avoid modifying files directly.
          </div>
        )}
      </div>

      {/* ── Section 7: I/O Schema ── */}
      <div className="rounded-xl border border-border bg-bg-subtle p-4 space-y-3">
        <div className="text-[12px] font-semibold text-fg">I/O Schema</div>
        <Field label="Output schema (JSON, optional)">
          <Textarea
            value={ioSchema}
            onChange={(e) => { setIoSchema(e.target.value); setIoSchemaError(null); }}
            className="min-h-[120px] mono text-[12px]"
            placeholder={'{\n  "output": {\n    "type": "object",\n    "properties": {\n      "findings": { "type": "array" }\n    }\n  }\n}'}
          />
        </Field>
        {ioSchemaError && (
          <p className="text-[12px] text-[var(--fail)]">{ioSchemaError}</p>
        )}
      </div>

      {/* ── Section 8: Budget ── */}
      <div className="rounded-xl border border-border bg-bg-subtle p-4 space-y-3">
        <div className="text-[12px] font-semibold text-fg">Budget</div>
        <Field label="Max tokens (optional)">
          <Input
            type="number"
            value={maxTokens}
            onChange={(e) => setMaxTokens(e.target.value)}
            placeholder="8000"
          />
        </Field>
      </div>
        </div>
      </details>

      <div className="flex gap-2 justify-end pt-2">
        <Button type="button" variant="default" onClick={() => router.push("/slices")}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? "Saving…" : existing ? "Save changes" : "Create slice"}
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
