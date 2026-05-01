import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { SettingsTabs } from "./SettingsTabs";
import { readAppSettings } from "@/lib/settings";
import { listAgents, listJobs, listSessions } from "@/lib/runs";
import { listWorkingDirectories } from "@/lib/working-directories";
import { agentsFile, jobsFile, mcpConfigFile, sessionsRoot, settingsFile, workingDirectoriesFile } from "@/lib/paths";
import { parseStreamJsonl, type StreamEvent } from "@/lib/events";
import { CLI_SHORT_LABELS } from "@/lib/clis";

export const revalidate = 0;
export const dynamic = "force-dynamic";

const execFileAsync = promisify(execFile);

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

async function loadAwsProfiles(): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("aws", ["configure", "list-profiles"], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export default async function SettingsPage() {
  const [settings, agents, jobs, workingDirectories, configuredMcpServers, observedMcpServers, awsProfiles] = await Promise.all([
    readAppSettings(),
    listAgents().catch(() => []),
    listJobs().catch(() => []),
    listWorkingDirectories().catch(() => []),
    loadMcpSummaries(),
    loadObservedMcpServers(),
    loadAwsProfiles(),
  ]);
  const hiddenOnlyServers = settings.hiddenMcpImageServers.map((name) => ({
    name,
    type: "hidden",
    target: "saved image filter",
    envKeys: [],
  }));
  const mcpServers = mergeMcpServers(configuredMcpServers, observedMcpServers, hiddenOnlyServers);

  const scheduledAgents = agents.filter((agent) => Boolean(agent.cron)).length;
  const configuredPaths: Array<readonly [string, string]> = [
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

      <SettingsTabs
        initialSettings={settings}
        workingDirectories={workingDirectories}
        mcpServers={mcpServers}
        awsProfiles={awsProfiles}
        agents={agents}
        jobs={jobs}
        configuredPaths={configuredPaths}
      />
    </div>
  );
}
