"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Chip, Input, Select } from "@/app/components/ui";
import type { AppSettings } from "@/lib/settings";

type SettingsRecord = AppSettings & Partial<MemoryEmbeddingSettings>;

type MemoryEmbeddingSettings = {
  memoryEmbeddingProvider: string;
  memoryEmbeddingModel: string;
  memoryEmbeddingBaseUrl: string;
  memoryEmbeddingApiKey: string;
  memoryEmbeddingDimensions: number;
  memoryRetrievalMode: string;
  memoryCuratorEnabled: boolean;
  memoryCuratorProvider: string;
  memoryCuratorModel: string;
  memoryCuratorBaseUrl: string;
  memoryCuratorApiKey: string;
};

type EmbeddingStatus = {
  state: string;
  retrievalMode?: string;
  indexedCount?: number;
  embeddedCount?: number;
  pendingCount?: number;
  staleCount?: number;
  totalCount?: number;
  provider?: string;
  model?: string;
  lastUpdated?: string;
  lastError?: string;
  rebuilding: boolean;
};

type Props = {
  settings?: SettingsRecord;
  onSettingsChange?: (settings: SettingsRecord) => void;
  compact?: boolean;
  className?: string;
};

const STATUS_POLL_MS = 5000;
const PROVIDERS = ["disabled", "openai-compatible", "local-http", "bedrock"];
const RETRIEVAL_MODES = ["hybrid", "semantic", "keyword"];
const MASKED_SECRET = "••••••••••••";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function boolValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function formatCount(value?: number): string {
  return typeof value === "number" ? value.toLocaleString() : "—";
}

function formatStatusDate(value?: string): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function normalizeStatus(data: unknown): EmbeddingStatus {
  const root = isRecord(data) ? data : {};
  const source = isRecord(root.status) ? root.status : root;
  const counts = isRecord(source.counts) ? source.counts : {};
  const index = isRecord(source.index) ? source.index : {};
  const embeddings = isRecord(source.embeddings) ? source.embeddings : {};
  const retrieval = isRecord(root.settings) ? root.settings : {};
  const embeddingSettings = isRecord(retrieval.embedding) ? retrieval.embedding : {};
  const state = stringValue(
    source.state ?? source.status ?? source.phase ?? (source.rebuilding ? "rebuilding" : undefined),
    "unknown",
  );

  return {
    state,
    retrievalMode: stringValue(source.retrievalMode ?? source.retrieval_mode ?? source.mode ?? retrieval.mode),
    indexedCount: numberValue(source.indexedCount ?? source.indexed_count ?? source.totalNotes ?? counts.indexed ?? index.count),
    embeddedCount: numberValue(source.embeddedCount ?? source.embedded_count ?? source.totalChunks ?? counts.embedded ?? embeddings.count),
    pendingCount: numberValue(source.pendingCount ?? source.pending_count ?? source.queued ?? counts.pending),
    staleCount: numberValue(source.staleCount ?? source.stale_count ?? counts.stale),
    totalCount: numberValue(source.totalCount ?? source.total_count ?? source.totalNotes ?? counts.total),
    provider: stringValue(source.provider ?? embeddingSettings.provider),
    model: stringValue(source.model ?? embeddingSettings.model),
    lastUpdated: stringValue(
      source.lastUpdated ?? source.updatedAt ?? source.updated_at ?? source.lastIndexedAt ?? source.last_indexed_at,
    ),
    lastError: stringValue(source.lastError ?? source.last_error ?? source.error),
    rebuilding: boolValue(source.rebuilding ?? source.isRebuilding, state === "rebuilding"),
  };
}

function statusChipClass(status: EmbeddingStatus | null): string {
  if (!status) return "";
  const state = status.state.toLowerCase();
  if (status.lastError || state.includes("error") || state.includes("fail")) return "chip-fail";
  if (status.rebuilding || state.includes("build") || state.includes("pending")) return "chip-warn";
  if (state.includes("ready") || state.includes("ok") || state.includes("indexed") || state.includes("idle")) return "chip-success";
  if (state.includes("disabled")) return "";
  return "chip-accent";
}

function field(settings: SettingsRecord | null, key: keyof MemoryEmbeddingSettings, fallback = ""): string {
  return stringValue(settings?.[key], fallback);
}

export function MemorySettingsPanel({
  settings: controlledSettings,
  onSettingsChange,
  compact = false,
  className = "",
}: Props) {
  const controlled = Boolean(controlledSettings && onSettingsChange);
  const [localSettings, setLocalSettings] = useState<SettingsRecord | null>(controlledSettings ?? null);
  const [savedLocalSettings, setSavedLocalSettings] = useState<SettingsRecord | null>(controlledSettings ?? null);
  const [settingsLoading, setSettingsLoading] = useState(!controlledSettings);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<EmbeddingStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [secretDrafts, setSecretDrafts] = useState({ embedding: "", curator: "" });

  const settings = controlledSettings ?? localSettings;

  useEffect(() => {
    if (!controlledSettings) return;
    setLocalSettings(controlledSettings);
    setSavedLocalSettings(controlledSettings);
  }, [controlledSettings]);

  useEffect(() => {
    if (controlledSettings) return;
    let cancelled = false;
    setSettingsLoading(true);
    fetch("/api/settings")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`Settings request failed: ${res.status}`))))
      .then((data) => {
        if (cancelled) return;
        const next = isRecord(data) && isRecord(data.settings) ? data.settings as SettingsRecord : data as SettingsRecord;
        setLocalSettings(next);
        setSavedLocalSettings(next);
        setSettingsMessage(null);
      })
      .catch((err) => {
        if (!cancelled) setSettingsMessage(err instanceof Error ? err.message : "Unable to load memory settings.");
      })
      .finally(() => {
        if (!cancelled) setSettingsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [controlledSettings]);

  const refreshStatus = useCallback(async (showLoading = false) => {
    if (showLoading) setStatusLoading(true);
    try {
      const res = await fetch("/api/memory/embeddings/status");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Status request failed: ${res.status}`);
      setStatus(normalizeStatus(data));
      setStatusError(null);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "Unable to load embedding status.");
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    let stopped = false;
    const poll = () => {
      if (!stopped && document.visibilityState === "visible") void refreshStatus(false);
    };
    void refreshStatus(true);
    const interval = window.setInterval(poll, STATUS_POLL_MS);
    document.addEventListener("visibilitychange", poll);
    return () => {
      stopped = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [refreshStatus]);

  const localHasChanges = useMemo(() => {
    if (controlled || !settings || !savedLocalSettings) return false;
    return JSON.stringify(settings) !== JSON.stringify(savedLocalSettings);
  }, [controlled, savedLocalSettings, settings]);

  function updateSetting(key: keyof MemoryEmbeddingSettings, value: string | boolean | number) {
    const current = settings ?? ({} as SettingsRecord);
    const next = { ...current, [key]: value } as SettingsRecord;
    setLocalSettings(next);
    onSettingsChange?.(next);
    if (settingsMessage === "Saved") setSettingsMessage(null);
  }

  function updateSecret(kind: "embedding" | "curator", key: "memoryEmbeddingApiKey" | "memoryCuratorApiKey", value: string) {
    setSecretDrafts((current) => ({ ...current, [kind]: value }));
    updateSetting(key, value);
  }

  async function saveLocalSettings() {
    if (!settings) return;
    setSaving(true);
    setSettingsMessage(null);
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "failed to save memory settings");
      const next = data.settings as SettingsRecord;
      setLocalSettings(next);
      setSavedLocalSettings(next);
      setSecretDrafts({ embedding: "", curator: "" });
      setSettingsMessage("Saved");
    } catch (err) {
      setSettingsMessage(err instanceof Error ? err.message : "failed to save memory settings");
    } finally {
      setSaving(false);
    }
  }

  async function rebuildEmbeddings() {
    setRebuilding(true);
    setStatusError(null);
    try {
      const res = await fetch("/api/memory/embeddings/rebuild", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(isRecord(data) && typeof data.error === "string" ? data.error : `Rebuild failed: ${res.status}`);
      setStatus(normalizeStatus(isRecord(data) && data.status ? data.status : { ...status, state: "rebuilding", rebuilding: true }));
      void refreshStatus(false);
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : "Unable to rebuild embeddings.");
    } finally {
      setRebuilding(false);
    }
  }

  const effectiveMode = field(settings ?? null, "memoryRetrievalMode", status?.retrievalMode || "hybrid");
  const embeddingSecret = secretDrafts.embedding || (field(settings ?? null, "memoryEmbeddingApiKey") ? MASKED_SECRET : "");
  const curatorSecret = secretDrafts.curator || (field(settings ?? null, "memoryCuratorApiKey") ? MASKED_SECRET : "");
  const statusLabel = statusLoading && !status ? "Checking" : status?.state || "Unknown";

  return (
    <section className={`memory-settings-panel ${compact ? "memory-settings-panel-compact" : ""} ${className}`.trim()}>
      <div className="memory-settings-head">
        <div>
          <h3>Memory retrieval</h3>
          <p>Embedding index, retrieval mode, and curator defaults.</p>
        </div>
        <div className="memory-settings-actions">
          <Chip className={statusChipClass(status)}>{statusLabel}</Chip>
          <Button type="button" size="sm" variant="ghost" onClick={() => refreshStatus(true)} disabled={statusLoading}>
            {statusLoading ? "Refreshing..." : "Refresh"}
          </Button>
          <Button type="button" size="sm" onClick={rebuildEmbeddings} disabled={rebuilding || status?.rebuilding}>
            {rebuilding || status?.rebuilding ? "Rebuilding..." : "Rebuild"}
          </Button>
        </div>
      </div>

      <div className="memory-status-grid">
        <div><span>Mode</span><strong>{effectiveMode}</strong></div>
        <div><span>Indexed</span><strong>{formatCount(status?.indexedCount)}</strong></div>
        <div><span>Embedded</span><strong>{formatCount(status?.embeddedCount)}</strong></div>
        <div><span>Pending</span><strong>{formatCount(status?.pendingCount)}</strong></div>
        <div><span>Stale</span><strong>{formatCount(status?.staleCount)}</strong></div>
        <div><span>Updated</span><strong>{formatStatusDate(status?.lastUpdated)}</strong></div>
      </div>

      {compact ? (
        <details className="memory-settings-details">
          <summary>Embedding settings</summary>
          <MemorySettingsFields
            settings={settings}
            settingsLoading={settingsLoading}
            embeddingSecret={embeddingSecret}
            curatorSecret={curatorSecret}
            updateSetting={updateSetting}
            updateSecret={updateSecret}
          />
        </details>
      ) : (
        <MemorySettingsFields
          settings={settings}
          settingsLoading={settingsLoading}
          embeddingSecret={embeddingSecret}
          curatorSecret={curatorSecret}
          updateSetting={updateSetting}
          updateSecret={updateSecret}
        />
      )}

      {(status?.lastError || statusError || settingsMessage) && (
        <div
          className={[
            "memory-settings-message",
            settingsMessage === "Saved" ? "memory-settings-message-success" : "",
          ].join(" ")}
          aria-live="polite"
        >
          {status?.lastError || statusError || settingsMessage}
        </div>
      )}

      {!controlled && (!compact || localHasChanges || saving) && (
        <div className="memory-settings-save-row">
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={saveLocalSettings}
            disabled={settingsLoading || saving || !localHasChanges}
          >
            {saving ? "Saving..." : localHasChanges ? "Save memory settings" : "Memory settings saved"}
          </Button>
        </div>
      )}
    </section>
  );
}

function MemorySettingsFields({
  settings,
  settingsLoading,
  embeddingSecret,
  curatorSecret,
  updateSetting,
  updateSecret,
}: {
  settings?: SettingsRecord | null;
  settingsLoading: boolean;
  embeddingSecret: string;
  curatorSecret: string;
  updateSetting: (key: keyof MemoryEmbeddingSettings, value: string | boolean | number) => void;
  updateSecret: (kind: "embedding" | "curator", key: "memoryEmbeddingApiKey" | "memoryCuratorApiKey", value: string) => void;
}) {
  const disabled = settingsLoading || !settings;

  return (
    <div className="memory-settings-fields">
      <label>
        <span>Embedding provider</span>
        <Select
          value={field(settings ?? null, "memoryEmbeddingProvider", "disabled")}
          onChange={(event) => updateSetting("memoryEmbeddingProvider", event.target.value)}
          disabled={disabled}
        >
          {PROVIDERS.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
        </Select>
      </label>
      <label>
        <span>Embedding model</span>
        <Input
          value={field(settings ?? null, "memoryEmbeddingModel")}
          onChange={(event) => updateSetting("memoryEmbeddingModel", event.target.value)}
          placeholder="text-embedding-3-large"
          disabled={disabled}
          spellCheck={false}
        />
      </label>
      <label>
        <span>Embedding base URL</span>
        <Input
          value={field(settings ?? null, "memoryEmbeddingBaseUrl")}
          onChange={(event) => updateSetting("memoryEmbeddingBaseUrl", event.target.value)}
          placeholder="https://api.openai.com/v1"
          disabled={disabled}
          spellCheck={false}
        />
      </label>
      <label>
        <span>Embedding dimensions</span>
        <Input
          type="number"
          value={String(settings?.memoryEmbeddingDimensions ?? 1536)}
          onChange={(event) => updateSetting("memoryEmbeddingDimensions", Number(event.target.value))}
          placeholder="1536"
          disabled={disabled}
          min={16}
          max={12288}
        />
      </label>
      <label>
        <span>Embedding API key</span>
        <Input
          type="password"
          value={embeddingSecret}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => updateSecret(
            "embedding",
            "memoryEmbeddingApiKey",
            event.target.value.replace(MASKED_SECRET, ""),
          )}
          placeholder="Stored secret"
          disabled={disabled}
          autoComplete="off"
        />
      </label>
      <label>
        <span>Retrieval mode</span>
        <Select
          value={field(settings ?? null, "memoryRetrievalMode", "hybrid")}
          onChange={(event) => updateSetting("memoryRetrievalMode", event.target.value)}
          disabled={disabled}
        >
          {RETRIEVAL_MODES.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
        </Select>
      </label>
      <label className="memory-settings-toggle">
        <input
          type="checkbox"
          checked={boolValue(settings?.memoryCuratorEnabled, false)}
          onChange={(event) => updateSetting("memoryCuratorEnabled", event.target.checked)}
          disabled={disabled}
        />
        <span>
          <strong>Curator enabled</strong>
          <small>Use a model to maintain retrieval metadata.</small>
        </span>
      </label>
      <label>
        <span>Curator provider</span>
        <Select
          value={field(settings ?? null, "memoryCuratorProvider", "disabled")}
          onChange={(event) => updateSetting("memoryCuratorProvider", event.target.value)}
          disabled={disabled}
        >
          {PROVIDERS.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
        </Select>
      </label>
      <label>
        <span>Curator model</span>
        <Input
          value={field(settings ?? null, "memoryCuratorModel")}
          onChange={(event) => updateSetting("memoryCuratorModel", event.target.value)}
          placeholder="gpt-4.1-mini"
          disabled={disabled}
          spellCheck={false}
        />
      </label>
      <label>
        <span>Curator base URL</span>
        <Input
          value={field(settings ?? null, "memoryCuratorBaseUrl")}
          onChange={(event) => updateSetting("memoryCuratorBaseUrl", event.target.value)}
          placeholder="https://api.openai.com/v1"
          disabled={disabled}
          spellCheck={false}
        />
      </label>
      <label>
        <span>Curator API key</span>
        <Input
          type="password"
          value={curatorSecret}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => updateSecret(
            "curator",
            "memoryCuratorApiKey",
            event.target.value.replace(MASKED_SECRET, ""),
          )}
          placeholder="Stored secret"
          disabled={disabled}
          autoComplete="off"
        />
      </label>
    </div>
  );
}
