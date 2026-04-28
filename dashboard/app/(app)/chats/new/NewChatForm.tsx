"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { CLI, Agent } from "@/lib/runs";
import type { ModelReasoningEffort } from "@/lib/models";
import { Composer, type ComposerHandle } from "@/app/components/chat/Composer";
import { DirPicker } from "@/app/components/DirPicker";
import { Input, Textarea } from "@/app/components/ui";
import { DEFAULT_CLAUDE_ALIAS, toBedrockId } from "@/lib/claude-models";
import type { AppSettings } from "@/lib/settings";
import { DEFAULT_CLI, isBedrockCli, normalizeCli } from "@/lib/clis";

export function NewChatForm() {
  const router = useRouter();
  const composerRef = useRef<ComposerHandle>(null);
  const [cwd, setCwd] = useState("");
  const [cwdTouched, setCwdTouched] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);

  // Agent selector
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>("");

  // Per-session overrides (orchestrator only)
  const [showOverrides, setShowOverrides] = useState(false);
  const [overrideModel, setOverrideModel] = useState("");
  const [overridePrompt, setOverridePrompt] = useState("");
  const [overrideMaxTokens, setOverrideMaxTokens] = useState("");
  const [overrideMaxCalls, setOverrideMaxCalls] = useState("");

  useEffect(() => {
    fetch("/api/agents")
      .then((r) => r.json())
      .then((data) => setAgents(data.agents ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => setSettings(data.settings ?? null))
      .catch(() => {});
  }, []);

  const selectedAgent = agents.find((a) => a.id === selectedAgentId) ?? null;
  const isOrchestrator = selectedAgent?.kind === "orchestrator";

  // Always show the cwd picker for ad-hoc chats so it's obvious
  const showCwdPicker = !selectedAgent;
  const defaultCli = normalizeCli(selectedAgent?.defaultCli ?? selectedAgent?.cli ?? settings?.defaultCli ?? DEFAULT_CLI);
  const defaultModel = selectedAgent
    ? selectedAgent.models?.[defaultCli] ?? selectedAgent.model ?? (isBedrockCli(defaultCli) ? toBedrockId(DEFAULT_CLAUDE_ALIAS) : undefined)
    : settings?.defaultModels?.[defaultCli] ?? (isBedrockCli(defaultCli) ? toBedrockId(DEFAULT_CLAUDE_ALIAS) : undefined);
  const defaultReasoningEffort = selectedAgent
    ? selectedAgent.reasoningEfforts?.[defaultCli] ?? selectedAgent.reasoningEffort
    : settings?.defaultReasoningEfforts?.[defaultCli];

  useEffect(() => {
    if (selectedAgent || cwdTouched || cwd.trim() || !settings?.defaultCwd) return;
    setCwd(settings.defaultCwd);
  }, [cwd, cwdTouched, selectedAgent, settings?.defaultCwd]);

  const start = async (
    message: string,
    cli: CLI,
    model?: string,
    mcpTools?: boolean,
    reasoningEffort?: ModelReasoningEffort,
  ) => {
    setStarting(true);
    setError(null);
    try {
      let body: Record<string, unknown>;

      if (selectedAgent) {
        const overrides: Record<string, unknown> = {};
        if (isOrchestrator) {
          if (overrideModel) overrides.model = overrideModel;
          if (overridePrompt) overrides.strategy_prompt = overridePrompt;
          const budget: Record<string, number> = {};
          if (overrideMaxTokens) budget.max_total_tokens = parseInt(overrideMaxTokens, 10);
          if (overrideMaxCalls) budget.max_slice_calls = parseInt(overrideMaxCalls, 10);
          if (Object.keys(budget).length > 0) overrides.budget = budget;
        }

        body = {
          agent_id: selectedAgent.id,
          message,
          cli,
          model: model || undefined,
          mcpTools,
          reasoningEffort,
          ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
        };
      } else {
        body = {
          message,
          mcpTools,
          adhoc_config: {
            cli,
            model: model || undefined,
            reasoningEffort,
            cwd: cwd.trim() || undefined,
          },
        };
      }

      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "failed");
      const { session_id } = await res.json();

      // Upload any files that were held locally in the Composer before the session existed
      const pendingFiles = composerRef.current?.getPendingFiles() ?? [];
      let finalMessage = message;
      if (pendingFiles.length > 0) {
        composerRef.current?.clearPendingFiles();
        const form = new FormData();
        pendingFiles.forEach((f) => form.append("files", f));
        const upRes = await fetch(`/api/sessions/${encodeURIComponent(session_id)}/uploads`, {
          method: "POST",
          body: form,
        });
        if (upRes.ok) {
          const data = await upRes.json();
          const saved: { name: string; path: string }[] = data.files ?? [];
          if (saved.length > 0) {
            const lines = saved.map((f) => `- ${f.path}  (${f.name})`);
            finalMessage = `${message}\n\n[Attached files — read them with the Read tool]\n${lines.join("\n")}`;
          }
        }
      }

      router.push(`/chats/${session_id}?m=${encodeURIComponent(finalMessage)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
      setStarting(false);
    }
  };

  return (
    <div className="w-[90%] mx-auto space-y-3">
      {error && (
        <div
          className="px-4 py-3 rounded-lg text-[13px]"
          style={{
            background: "color-mix(in srgb, var(--fail) 10%, transparent)",
            border: "1px solid color-mix(in srgb, var(--fail) 30%, var(--border))",
            color: "var(--fail)",
          }}
        >
          {error}
        </div>
      )}

      {/* Agent selector */}
      {agents.length > 0 && (
        <div className="rounded-xl border border-border bg-bg-subtle px-4 py-3 space-y-2">
          <label className="text-[11px] text-muted uppercase tracking-wider">
            Agent (optional)
          </label>
          <select
            value={selectedAgentId}
            onChange={(e) => {
              setSelectedAgentId(e.target.value);
              setShowOverrides(false);
              setOverrideModel("");
              setOverridePrompt("");
              setOverrideMaxTokens("");
              setOverrideMaxCalls("");
            }}
            className="w-full bg-transparent text-[13px] text-fg focus:outline-none py-1"
          >
            <option value="">— Ad-hoc chat (no agent) —</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.kind === "orchestrator" ? " [orchestrator]" : ""}
              </option>
            ))}
          </select>

          {/* Orchestrator overrides */}
          {isOrchestrator && (
            <div className="mt-1">
              <button
                type="button"
                onClick={() => setShowOverrides((v) => !v)}
                className="text-[12px] text-muted hover:text-fg flex items-center gap-1"
              >
                <span>{showOverrides ? "▼" : "▶"}</span> Override for this run
              </button>
              {showOverrides && (
                <div className="mt-2 rounded-xl border border-border bg-bg p-4 space-y-3">
                  <div className="space-y-1">
                    <label className="text-[11px] text-muted uppercase tracking-wider">
                      Model override
                    </label>
                    <Input
                      value={overrideModel}
                      onChange={(e) => setOverrideModel(e.target.value)}
                      placeholder={DEFAULT_CLAUDE_ALIAS}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-muted uppercase tracking-wider">
                      Strategy prompt override
                    </label>
                    <Textarea
                      value={overridePrompt}
                      onChange={(e) => setOverridePrompt(e.target.value)}
                      className="min-h-[80px] mono text-[12px]"
                      placeholder="Leave blank to use agent default"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="text-[11px] text-muted uppercase tracking-wider">
                        Max total tokens
                      </label>
                      <Input
                        type="number"
                        value={overrideMaxTokens}
                        onChange={(e) => setOverrideMaxTokens(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[11px] text-muted uppercase tracking-wider">
                        Max slice calls
                      </label>
                      <Input
                        type="number"
                        value={overrideMaxCalls}
                        onChange={(e) => setOverrideMaxCalls(e.target.value)}
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {showCwdPicker && (
        <div className="rounded-xl border border-border bg-bg-subtle px-4 py-3 space-y-1.5">
          <label className="flex items-center gap-1.5 text-[11px] text-muted uppercase tracking-wider">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
            </svg>
            Working directory
          </label>
          <DirPicker
            value={cwd}
            onChange={(value) => {
              setCwdTouched(true);
              setCwd(value);
            }}
            className="w-full"
          />
        </div>
      )}

      <Composer
        ref={composerRef}
        variant="inline"
        currentCli={defaultCli}
        currentModel={defaultModel}
        currentReasoningEffort={defaultReasoningEffort}
        currentMcpTools={!selectedAgent ? settings?.defaultMcpTools : undefined}
        availableClis={selectedAgent?.supportedClis}
        agentCliModels={selectedAgent?.models}
        agentCliReasoningEfforts={selectedAgent?.reasoningEfforts}
        cwd={showCwdPicker ? cwd : selectedAgent?.cwd}
        disabled={starting}
        onSend={start}
        placeholder="What do you want to work on?"
        sendLabel={starting ? "Starting…" : "Start chat →"}
      />
    </div>
  );
}
