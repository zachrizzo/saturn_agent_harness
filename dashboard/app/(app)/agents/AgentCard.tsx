"use client";

import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Agent } from "@/lib/runs";
import { agentDefaultCli, agentSupportedClis } from "@/lib/session-utils";
import { toClaudeAlias } from "@/lib/claude-models";
import { CLI_LABELS, CLI_SHORT_LABELS } from "@/lib/clis";
import { Button, Chip, Input, Textarea } from "@/app/components/ui";
import { IconClock, IconEdit, IconFork } from "@/app/components/shell/icons";
import { ShareExportButton } from "@/app/components/share/ShareExportButton";

type Props = { agent: Agent };

export function AgentCard({ agent }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // Orchestrator-only overrides, collapsed by default.
  const [showOverrides, setShowOverrides] = useState(false);
  const [overrideModel, setOverrideModel] = useState("");
  const [overridePrompt, setOverridePrompt] = useState("");
  const [overrideMaxTokens, setOverrideMaxTokens] = useState("");
  const [overrideMaxCalls, setOverrideMaxCalls] = useState("");

  const isOrchestrator = agent.kind === "orchestrator";
  const supportedClis = agentSupportedClis(agent);
  const defaultCli = agentDefaultCli(agent);
  const defaultModel = agent.models?.[defaultCli] ?? agent.model;

  const positiveIntOverride = (value: string, label: string): number | undefined => {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`${label} must be a whole number greater than 0.`);
    }
    return parsed;
  };

  const startChat = async () => {
    if (!message.trim()) return;
    setStartError(null);

    let overrides: {
      model?: string;
      strategy_prompt?: string;
      budget?: {
        max_total_tokens?: number;
        max_slice_calls?: number;
      };
    } | undefined;

    try {
      if (isOrchestrator) {
        const maxTokens = positiveIntOverride(overrideMaxTokens, "Max tokens");
        const maxCalls = positiveIntOverride(overrideMaxCalls, "Max slice calls");
        overrides = {
          ...(overrideModel.trim() ? { model: overrideModel.trim() } : {}),
          ...(overridePrompt.trim() ? { strategy_prompt: overridePrompt.trim() } : {}),
          ...(maxTokens || maxCalls
            ? {
                budget: {
                  ...(maxTokens ? { max_total_tokens: maxTokens } : {}),
                  ...(maxCalls ? { max_slice_calls: maxCalls } : {}),
                },
              }
            : {}),
        };
      }
    } catch (e) {
      setStartError(e instanceof Error ? e.message : "Invalid run override.");
      return;
    }

    setStarting(true);

    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: agent.id,
          message: message.trim(),
          ...(overrides && Object.keys(overrides).length > 0 ? { overrides } : {}),
        }),
      });
      const text = await res.text();
      let data: { session_id?: string; error?: string } = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { error: text || `HTTP ${res.status}` };
      }
      if (!res.ok || !data.session_id) {
        throw new Error(data.error ?? `Failed to start (${res.status})`);
      }
      router.push(`/chats/${data.session_id}`);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : "Failed to start");
      setStarting(false);
    }
  };

  const sliceCount =
    Array.isArray(agent.slices_available) && agent.slices_available.length > 0
      ? agent.slices_available.length
      : null;

  return (
    <article
      className="group border border-border rounded-lg bg-bg-elev hover:border-border-strong transition-colors"
      style={{ boxShadow: "var(--shadow-sm)" }}
    >
      <div className="px-4 py-3 flex items-start gap-3 min-w-0">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            <Link
              href={`/agents/${agent.id}/edit`}
              className="text-[14.5px] font-semibold tracking-tight text-fg hover:text-accent transition-colors truncate"
              title={agent.name}
            >
              {agent.name}
            </Link>
            {isOrchestrator && (
              <Chip variant="accent" className="text-[10px]">
                orchestrator
              </Chip>
            )}
            {agent.cron && (
              <span
                className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded"
                style={{
                  color: "var(--warn)",
                  background: "color-mix(in srgb, var(--warn) 10%, transparent)",
                }}
                title={`Cron: ${agent.cron}`}
              >
                <IconClock className="w-3 h-3" />
                <span className="mono">{agent.cron}</span>
              </span>
            )}
          </div>
          {agent.description && (
            <p className="text-[12.5px] text-muted mt-1 line-clamp-2 leading-snug">
              {agent.description}
            </p>
          )}
          <div className="flex items-center gap-2 mt-2 flex-wrap text-[11px] text-subtle">
            {supportedClis.length > 1 ? (
              <span className="inline-flex items-center gap-1">
                <span title={supportedClis.map((cli) => CLI_LABELS[cli]).join(" · ")}>
                  {supportedClis.map((cli) => CLI_SHORT_LABELS[cli]).join(" · ")}
                </span>
                <Chip variant="accent" className="text-[9.5px]">
                  multi
                </Chip>
              </span>
            ) : (
              <span className="text-fg" title={CLI_LABELS[defaultCli]}>{CLI_SHORT_LABELS[defaultCli]}</span>
            )}
            {defaultModel && (
              <>
                <span className="text-subtle">·</span>
                <span className="mono truncate max-w-[220px]" title={defaultModel}>
                  {toClaudeAlias(defaultModel) ?? defaultModel}
                </span>
              </>
            )}
            {sliceCount !== null && (
              <>
                <span className="text-subtle">·</span>
                <span>{sliceCount} slices</span>
              </>
            )}
            {agent.slices_available === "*" && (
              <>
                <span className="text-subtle">·</span>
                <span>all slices</span>
              </>
            )}
            {agent.tags && agent.tags.length > 0 && (
              <>
                <span className="text-subtle">·</span>
                {agent.tags.map((t) => (
                  <Chip key={t} className="text-[10px]">
                    {t}
                  </Chip>
                ))}
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <ShareExportButton
            endpoint={`/api/share/agents/${encodeURIComponent(agent.id)}`}
            filename={`saturn-agent-${agent.id}`}
          />
          <Link href={`/agents/${agent.id}/edit`} title="Edit agent">
            <Button size="sm" variant="ghost">
              <IconEdit className="w-3.5 h-3.5" />
            </Button>
          </Link>
        </div>
        <Button
          size="sm"
          variant={open ? "ghost" : "primary"}
          onClick={() => setOpen((v) => !v)}
          disabled={starting}
          className="shrink-0"
        >
          <IconFork className="w-3.5 h-3.5" />
          {open ? "Cancel" : "Chat"}
        </Button>
      </div>

      {open && (
        <div className="px-4 pb-3 space-y-2 border-t border-border pt-3">
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            aria-label={`Message for ${agent.name}`}
            placeholder="Start the conversation…"
            className="min-h-[60px] text-[13px]"
            disabled={starting}
            autoFocus
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                startChat();
              }
            }}
          />
          {isOrchestrator && (
            <details
              className="text-[12px]"
              open={showOverrides}
              onToggle={(e) =>
                setShowOverrides((e.target as HTMLDetailsElement).open)
              }
            >
              <summary className="cursor-pointer text-subtle hover:text-fg select-none inline-flex items-center gap-1">
                Override for this run
              </summary>
              <div className="mt-2 rounded-md border border-border bg-bg-subtle p-3 space-y-2">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <Input
                    value={overrideModel}
                    onChange={(e) => setOverrideModel(e.target.value)}
                    aria-label="Model override"
                    placeholder="Model override"
                  />
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    value={overrideMaxTokens}
                    onChange={(e) => setOverrideMaxTokens(e.target.value)}
                    aria-label="Max tokens override"
                    placeholder="Max tokens"
                  />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <Input
                    type="number"
                    min={1}
                    step={1}
                    value={overrideMaxCalls}
                    onChange={(e) => setOverrideMaxCalls(e.target.value)}
                    aria-label="Max slice calls override"
                    placeholder="Max slice calls"
                  />
                </div>
                <Textarea
                  value={overridePrompt}
                  onChange={(e) => setOverridePrompt(e.target.value)}
                  aria-label="Strategy prompt override"
                  className="min-h-[60px] mono text-[12px]"
                  placeholder="Strategy prompt override (leave blank for agent default)"
                />
              </div>
            </details>
          )}
          {startError && (
            <div
              className="rounded-md border px-3 py-2 text-[12px]"
              style={{
                color: "var(--fail)",
                borderColor: "color-mix(in srgb, var(--fail) 28%, var(--border))",
                background: "color-mix(in srgb, var(--fail) 7%, transparent)",
              }}
              role="alert"
            >
              {startError}
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-subtle">
              ⌘↵ to send · {agent.prompt.length} chars in system prompt
            </span>
            <Button
              size="sm"
              variant="primary"
              onClick={startChat}
              disabled={!message.trim() || starting}
            >
              {starting ? "Starting…" : "Start chat"}
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}
