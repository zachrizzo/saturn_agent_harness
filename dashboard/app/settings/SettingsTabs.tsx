"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { SettingsClient } from "./SettingsClient";
import type { AppSettings } from "@/lib/settings";
import type { Agent, CLI, Job } from "@/lib/runs";
import type { WorkingDirectoryEntry } from "@/lib/working-directories";
import { formatReasoningEffort } from "@/lib/models";
import { CLI_SHORT_LABELS, DEFAULT_CLI, normalizeCli } from "@/lib/clis";
import { Button } from "@/app/components/ui";

type McpServerSummary = {
  name: string;
  type: string;
  target: string;
  envKeys: string[];
  targets?: string[];
};

type ConfiguredPath = readonly [string, string];

type Props = {
  initialSettings: AppSettings;
  workingDirectories: WorkingDirectoryEntry[];
  mcpServers: McpServerSummary[];
  awsProfiles: string[];
  agents: Agent[];
  jobs: Job[];
  configuredPaths: ConfiguredPath[];
};

const SETTINGS_TABS = [
  { id: "defaults", label: "Defaults" },
  { id: "agents", label: "Agents" },
  { id: "jobs", label: "Jobs" },
  { id: "mcp", label: "MCP" },
  { id: "storage", label: "Storage" },
] as const;

type SettingsTabId = (typeof SETTINGS_TABS)[number]["id"];

function tabHash(tab: SettingsTabId): string {
  return `settings-${tab}`;
}

function tabFromHash(hash: string): SettingsTabId | undefined {
  const normalized = hash.replace(/^#/, "");
  return SETTINGS_TABS.find((tab) => tabHash(tab.id) === normalized)?.id;
}

function agentCli(agent: Agent): CLI {
  return normalizeCli(agent.defaultCli ?? agent.cli ?? DEFAULT_CLI);
}

function agentModel(agent: Agent): string {
  const cli = agentCli(agent);
  return agent.models?.[cli] ?? agent.model ?? "first available";
}

function agentEffort(agent: Agent): string {
  const cli = agentCli(agent);
  return formatReasoningEffort(agent.reasoningEfforts?.[cli] ?? agent.reasoningEffort);
}

function jobCli(job: Job): CLI {
  return normalizeCli(job.cli ?? DEFAULT_CLI);
}

export function SettingsTabs({
  initialSettings,
  workingDirectories,
  mcpServers,
  awsProfiles,
  agents,
  jobs,
  configuredPaths,
}: Props) {
  const [activeTab, setActiveTab] = useState<SettingsTabId>("defaults");
  const [mcpAuthLaunching, setMcpAuthLaunching] = useState<string | null>(null);
  const [mcpAuthMessages, setMcpAuthMessages] = useState<Record<string, string>>({});
  const activeLabel = useMemo(
    () => SETTINGS_TABS.find((tab) => tab.id === activeTab)?.label ?? "Settings",
    [activeTab],
  );

  useEffect(() => {
    const syncFromHash = () => {
      const nextTab = tabFromHash(window.location.hash);
      if (nextTab) setActiveTab(nextTab);
    };
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, []);

  const selectTab = (tab: SettingsTabId) => {
    setActiveTab(tab);
    const nextHash = `#${tabHash(tab)}`;
    if (window.location.hash !== nextHash) {
      window.history.replaceState(null, "", nextHash);
    }
  };

  const launchMcpAuth = async (serverName: string) => {
    setMcpAuthLaunching(serverName);
    setMcpAuthMessages((prev) => ({ ...prev, [serverName]: "" }));
    try {
      const res = await fetch("/api/mcp/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ server: serverName }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "failed to open MCP login");
      setMcpAuthMessages((prev) => ({ ...prev, [serverName]: "Codex MCP login window opened" }));
    } catch (err) {
      setMcpAuthMessages((prev) => ({
        ...prev,
        [serverName]: err instanceof Error ? err.message : "failed to open MCP login",
      }));
    } finally {
      setMcpAuthLaunching(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="sticky top-12 z-20 -mx-1 bg-bg/95 pt-1 backdrop-blur">
        <div className="tab-bar overflow-x-auto" role="tablist" aria-label="Settings sections">
          {SETTINGS_TABS.map((tab) => {
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                id={`settings-tab-${tab.id}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={`settings-panel-${tab.id}`}
                tabIndex={selected ? 0 : -1}
                className={`tab ${selected ? "active" : ""}`}
                onClick={() => selectTab(tab.id)}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="sr-only" aria-live="polite">
        {activeLabel} settings selected
      </div>

      <section
        id="settings-panel-defaults"
        role="tabpanel"
        aria-labelledby="settings-tab-defaults"
        hidden={activeTab !== "defaults"}
      >
        <SettingsClient
          initialSettings={initialSettings}
          workingDirectories={workingDirectories}
          mcpServers={mcpServers}
          awsProfiles={awsProfiles}
        />
      </section>

      <section
        id="settings-panel-agents"
        role="tabpanel"
        aria-labelledby="settings-tab-agents"
        hidden={activeTab !== "agents"}
      >
        <div className="sect-head">
          <h2>Saved agent defaults</h2>
          <span className="right">{agents.length} agents</span>
        </div>
        {agents.length === 0 ? (
          <div className="card p-6 text-[13px] text-muted">No saved agents yet.</div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {agents.map((agent) => {
              const cli = agentCli(agent);
              return (
                <Link
                  key={agent.id}
                  href={`/agents/${encodeURIComponent(agent.id)}/edit`}
                  className="card p-4 hover:border-accent/40 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium truncate">{agent.name}</div>
                      <div className="text-[11px] text-subtle truncate">{agent.id}</div>
                    </div>
                    <span className="chip">{CLI_SHORT_LABELS[cli]}</span>
                  </div>
                  <div className="mt-3 space-y-1 text-[12px] text-muted">
                    <div className="truncate">Model: <span className="text-fg">{agentModel(agent)}</span></div>
                    <div>Effort: <span className="text-fg">{agentEffort(agent)}</span></div>
                    <div className="truncate">CWD: <span className="text-fg mono">{agent.cwd ?? "none"}</span></div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      <section
        id="settings-panel-jobs"
        role="tabpanel"
        aria-labelledby="settings-tab-jobs"
        hidden={activeTab !== "jobs"}
      >
        <div className="sect-head">
          <h2>Scheduled job defaults</h2>
          <span className="right">{jobs.length} jobs</span>
        </div>
        {jobs.length === 0 ? (
          <div className="card p-6 text-[13px] text-muted">No scheduled jobs configured.</div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {jobs.map((job) => {
              const cli = jobCli(job);
              return (
                <Link
                  key={job.name}
                  href={`/jobs/${encodeURIComponent(job.name)}`}
                  className="card p-4 hover:border-accent/40 transition-colors"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium truncate">{job.name}</div>
                      <div className="text-[11px] text-subtle truncate">{job.cron}</div>
                    </div>
                    <span className="chip">{CLI_SHORT_LABELS[cli]}</span>
                  </div>
                  <div className="mt-3 space-y-1 text-[12px] text-muted">
                    <div className="truncate">Model: <span className="text-fg">{job.model ?? "first available"}</span></div>
                    <div>Effort: <span className="text-fg">{formatReasoningEffort(job.reasoningEffort)}</span></div>
                    <div className="truncate">CWD: <span className="text-fg mono">{job.cwd ?? "none"}</span></div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      <section
        id="settings-panel-mcp"
        role="tabpanel"
        aria-labelledby="settings-tab-mcp"
        hidden={activeTab !== "mcp"}
      >
        <div className="sect-head">
          <h2>MCP servers</h2>
          <span className="right">Secret values are not rendered</span>
        </div>
        {mcpServers.length === 0 ? (
          <div className="card p-6 text-[13px] text-muted">No MCP servers configured.</div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {mcpServers.map((server) => (
              <div key={server.name} className="card p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium truncate">{server.name}</div>
                    <div className="text-[11px] text-subtle truncate">{server.target}</div>
                  </div>
                  <span className="chip">{server.type}</span>
                </div>
                <div className="mt-3 text-[12px] text-muted">
                  Env keys:{" "}
                  <span className="text-fg">
                    {server.envKeys.length > 0 ? server.envKeys.join(", ") : "none"}
                  </span>
                </div>
                {server.type === "remote" && (!server.targets?.length || server.targets.includes("codex")) && (
                  <div className="mt-3 flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => launchMcpAuth(server.name)}
                      disabled={mcpAuthLaunching === server.name}
                    >
                      {mcpAuthLaunching === server.name ? "Opening..." : "Authorize Codex"}
                    </Button>
                    {mcpAuthMessages[server.name] && (
                      <span className="text-[11px] text-subtle">{mcpAuthMessages[server.name]}</span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section
        id="settings-panel-storage"
        role="tabpanel"
        aria-labelledby="settings-tab-storage"
        hidden={activeTab !== "storage"}
      >
        <div className="sect-head">
          <h2>Storage</h2>
          <span className="right">Local config files</span>
        </div>
        <div className="card p-4 space-y-2">
          {configuredPaths.map(([label, value]) => (
            <div key={label} className="grid gap-2 md:grid-cols-[120px_minmax(0,1fr)] text-[12px]">
              <div className="text-muted">{label}</div>
              <div className="mono truncate" title={value}>{value}</div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
