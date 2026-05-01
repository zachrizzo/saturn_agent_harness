"use client";

import { useEffect, useMemo, useState } from "react";
import type { CLI } from "@/lib/runs";
import type { AppSettings } from "@/lib/settings";
import type { Model, ModelReasoningEffort } from "@/lib/models";
import { formatModelOption, formatReasoningEffort, reasoningEffortOptionsForCli } from "@/lib/models";
import type { WorkingDirectoryEntry } from "@/lib/working-directories";
import { Button, Input, Select } from "@/app/components/ui";
import { DirPicker } from "@/app/components/DirPicker";
import { CLI_LABELS, CLI_VALUES } from "@/lib/clis";
import { IconUser } from "@/app/components/shell/icons";
import { MemorySettingsPanel } from "@/app/components/memory/MemorySettingsPanel";

type Props = {
  initialSettings: AppSettings;
  workingDirectories: WorkingDirectoryEntry[];
  mcpServers: Array<{ name: string; type: string; target: string; envKeys: string[] }>;
  awsProfiles: string[];
};

const CLIS: CLI[] = [...CLI_VALUES];

type ClaudePersonalAuthStatus = {
  loggedIn: boolean;
  authMethod?: string;
  apiProvider?: string;
  error?: string;
};

type BedrockAuthStatus = {
  ready: boolean;
  profile: string;
  region: string;
  error?: string;
};

type SettingsRecord = AppSettings & Record<string, unknown>;

export function SettingsClient({ initialSettings, workingDirectories, mcpServers, awsProfiles }: Props) {
  const [settings, setSettings] = useState<AppSettings>(initialSettings);
  const [savedSettings, setSavedSettings] = useState<AppSettings>(initialSettings);
  const [modelsByCli, setModelsByCli] = useState<Partial<Record<CLI, Model[]>>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<ClaudePersonalAuthStatus | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authLaunching, setAuthLaunching] = useState(false);
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [bedrockAuthStatus, setBedrockAuthStatus] = useState<BedrockAuthStatus | null>(null);
  const [bedrockAuthLoading, setBedrockAuthLoading] = useState(true);
  const [bedrockAuthLaunching, setBedrockAuthLaunching] = useState(false);
  const [bedrockAuthMessage, setBedrockAuthMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    for (const cli of CLIS) {
      fetch(`/api/models?cli=${encodeURIComponent(cli)}`)
        .then((r) => r.json())
        .then((data) => {
          if (cancelled) return;
          setModelsByCli((prev) => ({ ...prev, [cli]: data.models ?? [] }));
        })
        .catch(() => {});
    }
    return () => { cancelled = true; };
  }, []);

  const refreshClaudePersonalAuth = async () => {
    setAuthLoading(true);
    try {
      const res = await fetch("/api/claude-personal/auth");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "failed to check Claude auth");
      setAuthStatus(data.status ?? null);
    } catch (err) {
      setAuthStatus({
        loggedIn: false,
        error: err instanceof Error ? err.message : "failed to check Claude auth",
      });
    } finally {
      setAuthLoading(false);
    }
  };

  useEffect(() => {
    void refreshClaudePersonalAuth();
  }, []);

  const refreshBedrockAuth = async () => {
    setBedrockAuthLoading(true);
    try {
      const params = new URLSearchParams({
        profile: settings.bedrockProfile,
        region: settings.bedrockRegion,
      });
      const res = await fetch(`/api/bedrock/auth?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "failed to check Bedrock auth");
      setBedrockAuthStatus(data.status ?? null);
    } catch (err) {
      setBedrockAuthStatus({
        ready: false,
        profile: settings.bedrockProfile,
        region: settings.bedrockRegion,
        error: err instanceof Error ? err.message : "failed to check Bedrock auth",
      });
    } finally {
      setBedrockAuthLoading(false);
    }
  };

  useEffect(() => {
    void refreshBedrockAuth();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedModel = useMemo(() => {
    const modelId = settings.defaultModels[settings.defaultCli];
    return modelId
      ? modelsByCli[settings.defaultCli]?.find((m) => m.id === modelId)
      : undefined;
  }, [modelsByCli, settings.defaultCli, settings.defaultModels]);

  const hasChanges = useMemo(
    () => JSON.stringify(settings) !== JSON.stringify(savedSettings),
    [settings, savedSettings],
  );

  useEffect(() => {
    if (hasChanges && message === "Saved") setMessage(null);
  }, [hasChanges, message]);

  const updateModel = (cli: CLI, value: string) => {
    setSettings((prev) => {
      const defaultModels = { ...prev.defaultModels };
      if (value) defaultModels[cli] = value;
      else delete defaultModels[cli];
      return { ...prev, defaultModels };
    });
  };

  const updateEffort = (cli: CLI, value: string) => {
    setSettings((prev) => {
      const defaultReasoningEfforts = { ...prev.defaultReasoningEfforts };
      if (value) defaultReasoningEfforts[cli] = value as ModelReasoningEffort;
      else delete defaultReasoningEfforts[cli];
      return { ...prev, defaultReasoningEfforts };
    });
  };

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "failed to save settings");
      setSettings(data.settings);
      setSavedSettings(data.settings);
      setMessage("Saved");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const updateCwd = (value: string) => {
    setSettings((prev) => {
      const trimmed = value.trim();
      if (!trimmed) {
        const next = { ...prev };
        delete next.defaultCwd;
        return next;
      }
      return { ...prev, defaultCwd: trimmed };
    });
  };

  const updateBedrockProfile = (value: string) => {
    setSettings((prev) => ({ ...prev, bedrockProfile: value }));
  };

  const updateBedrockRegion = (value: string) => {
    setSettings((prev) => ({ ...prev, bedrockRegion: value }));
  };

  const setMcpImagesVisible = (serverName: string, visible: boolean) => {
    setSettings((prev) => {
      const hidden = new Set(prev.hiddenMcpImageServers ?? []);
      if (visible) hidden.delete(serverName);
      else hidden.add(serverName);
      return { ...prev, hiddenMcpImageServers: [...hidden].sort((a, b) => a.localeCompare(b)) };
    });
  };

  const updateMemorySettings = (next: SettingsRecord) => {
    setSettings(next as AppSettings);
  };

  const launchClaudePersonalAuth = async () => {
    setAuthLaunching(true);
    setAuthMessage(null);
    try {
      const res = await fetch("/api/claude-personal/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "claudeai" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "failed to open Claude login");
      setAuthStatus(data.status ?? authStatus);
      setAuthMessage("Login window opened");
    } catch (err) {
      setAuthMessage(err instanceof Error ? err.message : "failed to open Claude login");
    } finally {
      setAuthLaunching(false);
    }
  };

  const launchBedrockAuth = async () => {
    setBedrockAuthLaunching(true);
    setBedrockAuthMessage(null);
    try {
      const res = await fetch("/api/bedrock/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile: settings.bedrockProfile,
          region: settings.bedrockRegion,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "failed to open AWS SSO login");
      setBedrockAuthStatus(data.status ?? bedrockAuthStatus);
      setBedrockAuthMessage("AWS SSO login window opened");
    } catch (err) {
      setBedrockAuthMessage(err instanceof Error ? err.message : "failed to open AWS SSO login");
    } finally {
      setBedrockAuthLaunching(false);
    }
  };

  const authDetail = authLoading
    ? "Checking status"
    : authStatus?.loggedIn
      ? `Signed in${authStatus.authMethod ? ` via ${authStatus.authMethod}` : ""}${authStatus.apiProvider ? ` · ${authStatus.apiProvider}` : ""}`
      : authStatus?.error
        ? authStatus.error
        : "Not signed in";
  const bedrockAuthDetail = bedrockAuthLoading
    ? "Checking status"
    : bedrockAuthStatus?.ready
      ? `Ready for ${bedrockAuthStatus.profile} in ${bedrockAuthStatus.region}`
      : bedrockAuthStatus?.error
        ? bedrockAuthStatus.error
        : "Not authenticated";

  return (
    <section className="space-y-4">
      <div className="card p-5 space-y-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-[15px] font-semibold">New chat defaults</h2>
            <p className="text-[12px] text-muted mt-1">
              Used when you start an ad-hoc chat without picking a saved agent.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {message && (
              <span className={`text-[12px] ${message === "Saved" ? "text-[var(--success)]" : "text-[var(--fail)]"}`}>
                {message}
              </span>
            )}
            <Button type="button" variant="primary" size="sm" onClick={save} disabled={saving || !hasChanges}>
              {saving ? "Saving..." : hasChanges ? "Save settings" : "Settings saved"}
            </Button>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-bg-subtle p-4 flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[13px] font-medium">Claude Personal auth</div>
            <div className={`text-[12px] mt-1 ${authStatus?.error ? "text-[var(--fail)]" : "text-subtle"}`}>
              {authDetail}
            </div>
            {authMessage && (
              <div className="text-[12px] text-subtle mt-1" aria-live="polite">
                {authMessage}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={refreshClaudePersonalAuth} disabled={authLoading}>
              {authLoading ? "Checking..." : "Refresh"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="primary"
              className="inline-flex items-center gap-1.5"
              onClick={launchClaudePersonalAuth}
              disabled={authLaunching}
            >
              <IconUser className="w-3.5 h-3.5" />
              {authLaunching ? "Opening..." : "Open Claude login"}
            </Button>
          </div>
        </div>

        <div className="rounded-lg border border-border bg-bg-subtle p-4 space-y-3">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-0">
              <div className="text-[13px] font-medium">Claude Bedrock AWS</div>
              <div className={`text-[12px] mt-1 ${bedrockAuthStatus?.error ? "text-[var(--fail)]" : "text-subtle"}`}>
                {bedrockAuthDetail}
              </div>
              {bedrockAuthMessage && (
                <div className="text-[12px] text-subtle mt-1" aria-live="polite">
                  {bedrockAuthMessage}
                </div>
              )}
              <div className="text-[12px] text-subtle mt-1">
                Saturn stores the AWS profile and region only. Credentials stay in the AWS CLI.
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button type="button" size="sm" variant="ghost" onClick={refreshBedrockAuth} disabled={bedrockAuthLoading}>
                {bedrockAuthLoading ? "Checking..." : "Refresh"}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="primary"
                onClick={launchBedrockAuth}
                disabled={bedrockAuthLaunching}
              >
                {bedrockAuthLaunching ? "Opening..." : "Open AWS SSO login"}
              </Button>
            </div>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="block space-y-1">
              <span className="text-[11px] text-muted uppercase tracking-wider">AWS profile</span>
              <Input
                list="bedrock-profile-options"
                value={settings.bedrockProfile}
                onChange={(e) => updateBedrockProfile(e.target.value)}
                placeholder="sondermind-development-new"
                spellCheck={false}
              />
              {awsProfiles.length > 0 && (
                <datalist id="bedrock-profile-options">
                  {awsProfiles.map((profile) => (
                    <option key={profile} value={profile} />
                  ))}
                </datalist>
              )}
            </label>
            <label className="block space-y-1">
              <span className="text-[11px] text-muted uppercase tracking-wider">AWS region</span>
              <Input
                value={settings.bedrockRegion}
                onChange={(e) => updateBedrockRegion(e.target.value)}
                placeholder="us-east-1"
                spellCheck={false}
              />
            </label>
          </div>
          <div className="text-[11px] text-subtle">
            Login command: <code className="mono break-all">AWS_PROFILE={settings.bedrockProfile || "profile"} AWS_REGION={settings.bedrockRegion || "region"} aws sso login --profile {settings.bedrockProfile || "profile"}</code>
          </div>
          {awsProfiles.length > 0 && (
            <div className="space-y-1">
              <div className="text-[11px] text-muted uppercase tracking-wider">Configured profiles</div>
              <div className="flex flex-wrap gap-2">
                {awsProfiles.map((profile) => (
                  <button
                    key={profile}
                    type="button"
                    onClick={() => updateBedrockProfile(profile)}
                    className={[
                      "chip mono max-w-[320px] truncate hover:bg-bg-hover",
                      settings.bedrockProfile === profile ? "border-accent text-accent" : "",
                    ].join(" ")}
                    title={profile}
                  >
                    {profile}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <label className="text-[11px] text-muted uppercase tracking-wider">Default CLI</label>
          <div className="flex flex-wrap gap-1 rounded-lg border border-border bg-bg-subtle p-1 w-fit">
            {CLIS.map((cli) => (
              <button
                key={cli}
                type="button"
                onClick={() => setSettings((prev) => ({ ...prev, defaultCli: cli }))}
                className={[
                  "px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors",
                  settings.defaultCli === cli
                    ? "bg-accent text-white"
                    : "text-muted hover:bg-bg-hover hover:text-fg",
                ].join(" ")}
              >
                {CLI_LABELS[cli]}
              </button>
            ))}
          </div>
          <div className="text-[12px] text-subtle">
            Active default: {CLI_LABELS[settings.defaultCli]}
            {selectedModel ? ` · ${formatModelOption(selectedModel)}` : ""}
          </div>
        </div>

        <div className="grid gap-3 lg:grid-cols-3">
          {CLIS.map((cli) => {
            const models = modelsByCli[cli] ?? [];
            const modelId = settings.defaultModels[cli] ?? "";
            const model = models.find((m) => m.id === modelId);
            const effort = settings.defaultReasoningEfforts[cli] ?? "";
            const efforts = reasoningEffortOptionsForCli(cli, model);

            return (
              <div key={cli} className="rounded-lg border border-border bg-bg-subtle p-4 space-y-3">
                <div>
                  <div className="text-[13px] font-medium">{CLI_LABELS[cli]}</div>
                  <div className="text-[11px] text-subtle">
                    {models.length > 0 ? `${models.length} models available` : "Loading models"}
                  </div>
                </div>
                <label className="block space-y-1">
                  <span className="text-[11px] text-muted uppercase tracking-wider">Model</span>
                  <Select value={modelId} onChange={(e) => updateModel(cli, e.target.value)}>
                    <option value="">Use first available model</option>
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>{formatModelOption(m)}</option>
                    ))}
                  </Select>
                </label>
                <label className="block space-y-1">
                  <span className="text-[11px] text-muted uppercase tracking-wider">Reasoning effort</span>
                  <Select value={effort} onChange={(e) => updateEffort(cli, e.target.value)}>
                    <option value="">Default effort</option>
                    {efforts.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </Select>
                </label>
                <div className="text-[11px] text-subtle">
                  Saved effort: {formatReasoningEffort(effort || undefined)}
                </div>
              </div>
            );
          })}
        </div>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
          <label className="block space-y-1.5">
            <span className="text-[11px] text-muted uppercase tracking-wider">Default working directory</span>
            <DirPicker
              value={settings.defaultCwd ?? ""}
              onChange={updateCwd}
              className="w-full"
            />
          </label>
          <label className="flex items-center gap-3 rounded-lg border border-border bg-bg-subtle px-4 py-3">
            <input
              type="checkbox"
              className="w-4 h-4 accent-accent"
              checked={settings.defaultMcpTools}
              onChange={(e) => setSettings((prev) => ({ ...prev, defaultMcpTools: e.target.checked }))}
            />
            <span className="min-w-0">
              <span className="block text-[13px] font-medium">MCP tools for local Claude</span>
              <span className="block text-[11px] text-subtle">Enables the composer checkbox by default.</span>
            </span>
          </label>
        </div>

        <MemorySettingsPanel
          settings={settings as SettingsRecord}
          onSettingsChange={updateMemorySettings}
        />

        {workingDirectories.length > 0 && (
          <div className="space-y-2">
            <div className="text-[11px] text-muted uppercase tracking-wider">Recent directories</div>
            <div className="flex flex-wrap gap-2">
              {workingDirectories.slice(0, 8).map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  onClick={() => updateCwd(entry.path)}
                  className="chip mono max-w-[320px] truncate hover:bg-bg-hover"
                  title={entry.path}
                >
                  {entry.path}
                </button>
              ))}
            </div>
          </div>
        )}

        {mcpServers.length > 0 && (
          <div className="space-y-3">
            <div>
              <div className="text-[11px] text-muted uppercase tracking-wider">MCP image previews</div>
              <div className="text-[12px] text-subtle mt-1">
                Hide noisy images from specific MCP tool results while keeping the tool call data intact.
              </div>
            </div>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {mcpServers.map((server) => {
                const checked = !(settings.hiddenMcpImageServers ?? []).includes(server.name);
                return (
                  <label
                    key={server.name}
                    className="flex items-start gap-3 rounded-lg border border-border bg-bg-subtle px-3 py-2.5"
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 w-4 h-4 accent-accent"
                      checked={checked}
                      onChange={(e) => setMcpImagesVisible(server.name, e.target.checked)}
                    />
                    <span className="min-w-0">
                      <span className="block text-[13px] font-medium truncate">{server.name}</span>
                      <span className="block text-[11px] text-subtle truncate" title={server.target}>
                        {checked ? "Images shown" : "Images hidden"} · {server.type}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
