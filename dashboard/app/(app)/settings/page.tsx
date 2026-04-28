import Link from "next/link";
import { promises as fs } from "node:fs";
import path from "node:path";
import { SettingsClient } from "./SettingsClient";
import { readAppSettings } from "@/lib/settings";
import { listAgents, listJobs, listSessions, type Agent, type CLI, type Job } from "@/lib/runs";
import { listWorkingDirectories } from "@/lib/working-directories";
import { agentsFile, jobsFile, mcpConfigFile, sessionsRoot, settingsFile, workingDirectoriesFile } from "@/lib/paths";
import { formatReasoningEffort } from "@/lib/models";
import { parseStreamJsonl, type StreamEvent } from "@/lib/events";
import { CLI_SHORT_LABELS, DEFAULT_CLI, normalizeCli } from "@/lib/clis";

export const revalidate = 0;
export const dynamic = "force-dynamic";

type McpServerSummary = {
  name: string;
  type: string;
  target: string;
  envKeys: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = url.search ? "?..." : "";
    return url.toString();
  } catch {
    return value;
  }
}

async function loadMcpSummaries(): Promise<McpServerSummary[]> {
  try {
    const raw = await fs.readFile(mcpConfigFile(), "utf8");
    const parsed = JSON.parse(raw);
    const servers = isRecord(parsed?.mcpServers) ? parsed.mcpServers : isRecord(parsed) ? parsed : {};
    return Object.entries(servers)
      .flatMap(([name, rawServer]) => {
        if (!isRecord(rawServer)) return [];
        const server = rawServer;
        const command = typeof server.command === "string" ? server.command : "";
        const url = typeof server.url === "string" ? redactUrl(server.url) : "";
        const env = isRecord(server.env) ? server.env : {};
        return [{
          name,
          type: url ? "remote" : "stdio",
          target: url || command || "configured",
          envKeys: Object.keys(env).sort(),
        }];
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    return [];
  }
}

function mcpServerFromToolEvent(ev: StreamEvent): string | undefined {
  if (ev.kind !== "tool_use") return undefined;
  const raw = (ev.raw && typeof ev.raw === "object" ? ev.raw : {}) as Record<string, unknown>;
  const item = raw.item && typeof raw.item === "object" ? raw.item as Record<string, unknown> : {};
  if (typeof item.server === "string" && item.server.trim()) return item.server.trim();

  const claudeMatch = ev.name.match(/^mcp__(.+?)__.+/);
  if (claudeMatch) return claudeMatch[1];

  const dotMatch = ev.name.match(/^([^.\s]+)\.[^.\s]+$/);
  if (dotMatch) return dotMatch[1];

  return undefined;
}

async function loadObservedMcpServers(limit = 100): Promise<McpServerSummary[]> {
  const sessions = await listSessions().catch(() => []);
  const names = new Set<string>();
  await Promise.all(
    sessions.slice(0, limit).map(async (session) => {
      const raw = await fs.readFile(path.join(sessionsRoot(), session.session_id, "stream.jsonl"), "utf8").catch(() => "");
      for (const ev of parseStreamJsonl(raw)) {
        const name = mcpServerFromToolEvent(ev);
        if (name) names.add(name);
      }
    }),
  );
  return [...names].sort((a, b) => a.localeCompare(b)).map((name) => ({
    name,
    type: "observed",
    target: "seen in chat history",
    envKeys: [],
  }));
}

function mergeMcpServers(...groups: McpServerSummary[][]): McpServerSummary[] {
  const map = new Map<string, McpServerSummary>();
  for (const group of groups) {
    for (const server of group) {
      const existing = map.get(server.name);
      if (!existing || existing.type === "observed") map.set(server.name, server);
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
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

export default async function SettingsPage() {
  const [settings, agents, jobs, workingDirectories, configuredMcpServers, observedMcpServers] = await Promise.all([
    readAppSettings(),
    listAgents().catch(() => []),
    listJobs().catch(() => []),
    listWorkingDirectories().catch(() => []),
    loadMcpSummaries(),
    loadObservedMcpServers(),
  ]);
  const hiddenOnlyServers = settings.hiddenMcpImageServers.map((name) => ({
    name,
    type: "hidden",
    target: "saved image filter",
    envKeys: [],
  }));
  const mcpServers = mergeMcpServers(configuredMcpServers, observedMcpServers, hiddenOnlyServers);

  const scheduledAgents = agents.filter((agent) => Boolean(agent.cron)).length;
  const configuredPaths = [
    ["Settings", settingsFile()],
    ["Agents", agentsFile()],
    ["Jobs", jobsFile()],
    ["Working dirs", workingDirectoriesFile()],
    ["MCP", mcpConfigFile()],
  ];

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight">Settings</h1>
        <p className="text-[13px] text-muted mt-1">
          Defaults, configured tools, and saved automation settings.
        </p>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-[10px]">
        <div className="kpi">
          <span className="accent-line" />
          <div className="kpi-label">Default CLI</div>
          <div className="kpi-value text-[20px]">{CLI_SHORT_LABELS[settings.defaultCli]}</div>
          <div className="kpi-delta">{settings.defaultModels[settings.defaultCli] ?? "first model"}</div>
        </div>
        <div className="kpi">
          <span className="accent-line" />
          <div className="kpi-label">Agents</div>
          <div className="kpi-value">{agents.length}</div>
          <div className="kpi-delta">{scheduledAgents} scheduled</div>
        </div>
        <div className="kpi">
          <span className="accent-line" />
          <div className="kpi-label">Jobs</div>
          <div className="kpi-value">{jobs.length}</div>
          <div className="kpi-delta">scheduled runs</div>
        </div>
        <div className="kpi">
          <span className="accent-line" />
          <div className="kpi-label">MCP servers</div>
          <div className="kpi-value">{mcpServers.length}</div>
          <div className="kpi-delta">env values hidden</div>
        </div>
      </div>

      <SettingsClient
        initialSettings={settings}
        workingDirectories={workingDirectories}
        mcpServers={mcpServers}
      />

      <section>
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

      <section>
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

      <section>
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
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
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
