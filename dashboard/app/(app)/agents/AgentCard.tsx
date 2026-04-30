"use client";

import Link from "next/link";
import type { Agent } from "@/lib/runs";
import { agentDefaultCli, agentSupportedClis } from "@/lib/session-utils";
import { toClaudeAlias } from "@/lib/claude-models";
import { CLI_LABELS, CLI_SHORT_LABELS } from "@/lib/clis";
import { Chip } from "@/app/components/ui";
import { IconAgent, IconChat, IconClock, IconEdit } from "@/app/components/shell/icons";
import { ShareExportButton } from "@/app/components/share/ShareExportButton";
import { newChatHrefForAgent } from "@/lib/agent-navigation";

type Props = { agent: Agent };

export function AgentCard({ agent }: Props) {
  const isOrchestrator = agent.kind === "orchestrator";
  const supportedClis = agentSupportedClis(agent);
  const defaultCli = agentDefaultCli(agent);
  const defaultModel = agent.models?.[defaultCli] ?? agent.model;
  const sliceCount =
    Array.isArray(agent.slices_available) && agent.slices_available.length > 0
      ? agent.slices_available.length
      : null;
  const promptLength = agent.prompt.trim().length;
  const modelLabel = defaultModel ? toClaudeAlias(defaultModel) ?? defaultModel : "CLI default";
  const cliLabel = supportedClis.length > 1
    ? supportedClis.map((cli) => CLI_SHORT_LABELS[cli]).join(" · ")
    : CLI_SHORT_LABELS[defaultCli];

  return (
    <article className="agent-card group">
      <div className="agent-card-top">
        <div className="agent-card-icon" aria-hidden="true">
          <IconAgent className="w-5 h-5" />
        </div>
        <div className="agent-card-title min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <Link href={`/agents/${agent.id}/edit`} className="agent-card-name" title={agent.name}>
              {agent.name}
            </Link>
            {agent.cron && (
              <span className="agent-card-cron" title={`Cron: ${agent.cron}`}>
                <IconClock className="w-3 h-3" />
                <span className="mono">{agent.cron}</span>
              </span>
            )}
          </div>
          <div className="agent-card-subtitle">
            {isOrchestrator ? "Orchestrator" : "Chat agent"}
          </div>
        </div>
        <div className="agent-card-actions">
          <ShareExportButton
            endpoint={`/api/share/agents/${encodeURIComponent(agent.id)}`}
            filename={`saturn-agent-${agent.id}`}
          />
          <Link href={`/agents/${agent.id}/edit`} title="Edit agent" className="btn btn-ghost btn-icon">
            <IconEdit className="w-3.5 h-3.5" />
          </Link>
        </div>
      </div>

      <div className="agent-card-body">
        {agent.description && (
          <p className="agent-card-description">
            {agent.description}
          </p>
        )}

        <div className="agent-card-chips">
          {isOrchestrator && <Chip variant="accent">orchestrator</Chip>}
          {supportedClis.length > 1 ? (
            <Chip variant="accent" title={supportedClis.map((cli) => CLI_LABELS[cli]).join(" · ")}>
              multi-cli
            </Chip>
          ) : (
            <Chip title={CLI_LABELS[defaultCli]}>{cliLabel}</Chip>
          )}
          {agent.tags?.map((tag) => (
            <Chip key={tag}>{tag}</Chip>
          ))}
        </div>

        <div className="agent-card-stats">
          <div>
            <span>Model</span>
            <strong className="mono" title={defaultModel ?? modelLabel}>{modelLabel}</strong>
          </div>
          <div>
            <span>Workflow</span>
            <strong>
              {agent.slices_available === "*"
                ? "All slices"
                : sliceCount !== null
                  ? `${sliceCount} slices`
                  : isOrchestrator
                    ? "Custom"
                    : "Direct"}
            </strong>
          </div>
          <div>
            <span>Prompt</span>
            <strong>{promptLength.toLocaleString()} chars</strong>
          </div>
        </div>

        <Link href={newChatHrefForAgent(agent.id)} className="agent-card-chat btn btn-primary">
          <IconChat className="w-3.5 h-3.5" />
          Chat with this agent
        </Link>
      </div>
    </article>
  );
}
