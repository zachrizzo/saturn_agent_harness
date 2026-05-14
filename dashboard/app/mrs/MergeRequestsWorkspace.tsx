"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { CLI } from "@/lib/runs";
import type { ModelReasoningEffort } from "@/lib/models";

type MergeRequestScope = "assigned_to_me" | "all";
type MergeRequestState = "opened" | "merged" | "closed" | "all";

export type MrWorkspaceSettings = {
  defaultCli: CLI;
  defaultModel?: string;
  defaultReasoningEffort?: ModelReasoningEffort;
  defaultMcpTools: boolean;
  defaultCwd?: string;
};

type MergeRequestListItem = {
  id: number;
  iid: number;
  title: string;
  state: string;
  draft: boolean;
  webUrl: string;
  instanceUrl: string;
  projectPath: string;
  sessionTag: string;
  sessionId?: string;
  authorName?: string;
  authorUsername?: string;
  assignees: string[];
  reviewers: string[];
  sourceBranch: string;
  targetBranch: string;
  updatedAt?: string;
  changesCount?: string;
  userNotesCount?: number;
  detailedMergeStatus?: string;
};

type MergeRequestsResponse = {
  instanceUrl?: string;
  scope?: MergeRequestScope;
  state?: MergeRequestState;
  mergeRequests?: MergeRequestListItem[];
  truncated?: boolean;
  authSource?: string;
  error?: string;
  hint?: string;
};

type Props = {
  settings: MrWorkspaceSettings;
  selectedSessionId?: string;
  selectedMrUrl?: string;
  children?: ReactNode;
};

function shortDate(value?: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function branchLabel(source: string, target: string): string {
  if (!source && !target) return "";
  if (!source) return target;
  if (!target) return source;
  return `${source} -> ${target}`;
}

function createPinnedMrContext(mr: MergeRequestListItem): string {
  return [
    "GitLab merge request target",
    "",
    `MR: !${mr.iid} ${mr.title}`,
    `URL: ${mr.webUrl}`,
    `Project: ${mr.projectPath}`,
    branchLabel(mr.sourceBranch, mr.targetBranch) ? `Branches: ${branchLabel(mr.sourceBranch, mr.targetBranch)}` : "",
  ].filter(Boolean).join("\n");
}

function sessionTitle(mr: MergeRequestListItem): string {
  const title = `!${mr.iid} ${mr.title}`.trim();
  return title.length > 180 ? `${title.slice(0, 177)}...` : title;
}

function selectedUrlMatches(mr: MergeRequestListItem, selectedMrUrl?: string): boolean {
  if (!selectedMrUrl) return false;
  return mr.webUrl === selectedMrUrl || decodeURIComponent(mr.webUrl) === selectedMrUrl;
}

export function MergeRequestsWorkspace({
  settings,
  selectedSessionId,
  selectedMrUrl,
  children,
}: Props) {
  const router = useRouter();
  const [scope, setScope] = useState<MergeRequestScope>("assigned_to_me");
  const [state, setState] = useState<MergeRequestState>("opened");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<MergeRequestListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [authSource, setAuthSource] = useState<string | undefined>();
  const [openingKey, setOpeningKey] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    setHint(null);
    try {
      const params = new URLSearchParams({ scope, state });
      const q = query.trim();
      if (q) params.set("q", q);
      const res = await fetch(`/api/gitlab/merge-requests?${params.toString()}`, {
        cache: "no-store",
        signal,
      });
      const data = await res.json().catch(() => null) as MergeRequestsResponse | null;
      if (!res.ok) {
        setError(data?.error ?? `GitLab returned HTTP ${res.status}`);
        setHint(data?.hint ?? null);
        setItems([]);
        setTruncated(false);
        return;
      }
      setItems(data?.mergeRequests ?? []);
      setTruncated(Boolean(data?.truncated));
      setAuthSource(data?.authSource);
    } catch (err) {
      if (signal?.aborted) return;
      setError(err instanceof Error ? err.message : "Could not load merge requests.");
      setHint(null);
      setItems([]);
      setTruncated(false);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [query, scope, state]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void load(controller.signal);
    }, query.trim() ? 220 : 0);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [load, query, refreshNonce]);

  const refresh = () => {
    setRefreshNonce((current) => current + 1);
  };

  const visibleItems = useMemo(() => items, [items]);

  const openMergeRequest = async (mr: MergeRequestListItem) => {
    const existingSessionId = mr.sessionId || (selectedUrlMatches(mr, selectedMrUrl) ? selectedSessionId : undefined);
    if (existingSessionId) {
      router.push(`/mrs/${encodeURIComponent(existingSessionId)}?mr=${encodeURIComponent(mr.webUrl)}`);
      return;
    }

    setOpeningKey(mr.sessionTag);
    try {
      const body = {
        idle: true,
        tags: ["gitlab-mr", mr.sessionTag],
        title_override: sessionTitle(mr),
        mcpTools: settings.defaultMcpTools,
        adhoc_config: {
          cli: settings.defaultCli,
          model: settings.defaultModel,
          reasoningEffort: settings.defaultReasoningEffort,
          cwd: settings.defaultCwd,
        },
        pinned_context: [
          {
            role: "context",
            label: `GitLab MR !${mr.iid}`,
            text: createPinnedMrContext(mr),
          },
        ],
      };
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null) as { session_id?: string; error?: string } | null;
      if (!res.ok || !data?.session_id) {
        throw new Error(data?.error ?? `Could not create MR chat (${res.status})`);
      }
      router.push(`/mrs/${encodeURIComponent(data.session_id)}?mr=${encodeURIComponent(mr.webUrl)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open MR chat.");
    } finally {
      setOpeningKey(null);
    }
  };

  return (
    <div className="mrs-workspace">
      <aside className="mrs-list-panel">
        <div className="mrs-list-head">
          <div>
            <h1>Merge requests</h1>
            <p>{authSource ? `GitLab auth: ${authSource}` : "GitLab merge request queue"}</p>
          </div>
          <button type="button" className="mrs-icon-button" onClick={refresh} title="Refresh merge requests" aria-label="Refresh merge requests">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M21 12a9 9 0 0 1-15.3 6.4L3 16" />
              <path d="M3 21v-5h5" />
              <path d="M3 12a9 9 0 0 1 15.3-6.4L21 8" />
              <path d="M21 3v5h-5" />
            </svg>
          </button>
        </div>

        <div className="mrs-controls">
          <label className="mrs-search">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              type="search"
              placeholder="Search MRs"
            />
          </label>
          <div className="mrs-filter-row">
            <button type="button" className={`chip-filter ${scope === "assigned_to_me" ? "on" : ""}`} onClick={() => setScope("assigned_to_me")}>
              Assigned
            </button>
            <button type="button" className={`chip-filter ${scope === "all" ? "on" : ""}`} onClick={() => setScope("all")}>
              All
            </button>
            <select className="mrs-state-select" value={state} onChange={(event) => setState(event.target.value as MergeRequestState)}>
              <option value="opened">Open</option>
              <option value="merged">Merged</option>
              <option value="closed">Closed</option>
              <option value="all">Any state</option>
            </select>
          </div>
        </div>

        {error && (
          <div className="mrs-error">
            <strong>{error}</strong>
            {hint && <span>{hint}</span>}
          </div>
        )}

        {truncated && (
          <div className="mrs-note">Showing the most recently updated merge requests.</div>
        )}

        <div className="mrs-list" aria-busy={loading}>
          {loading && visibleItems.length === 0 ? (
            Array.from({ length: 8 }).map((_, index) => (
              <div key={index} className="mrs-row loading">
                <span className="loading-skeleton h-4 w-24" />
                <span className="loading-skeleton h-4 w-full" />
                <span className="loading-skeleton h-3 w-3/4" />
              </div>
            ))
          ) : visibleItems.length === 0 ? (
            <div className="mrs-empty">
              {error ? "Fix GitLab auth or filters, then refresh." : "No merge requests match these filters."}
            </div>
          ) : (
            visibleItems.map((mr) => {
              const active = mr.sessionId === selectedSessionId || selectedUrlMatches(mr, selectedMrUrl);
              const opening = openingKey === mr.sessionTag;
              return (
                <button
                  key={mr.sessionTag}
                  type="button"
                  className={`mrs-row ${active ? "active" : ""} ${opening ? "opening" : ""}`.trim()}
                  onClick={() => { void openMergeRequest(mr); }}
                  disabled={opening}
                >
                  <span className="mrs-row-top">
                    <span className="mrs-ref">!{mr.iid}</span>
                    <span className={`mrs-state ${mr.state}`}>{mr.draft ? "draft" : mr.state}</span>
                    {mr.sessionId && <span className="mrs-chat-chip">chat</span>}
                    <span className="mrs-updated">{shortDate(mr.updatedAt)}</span>
                  </span>
                  <span className="mrs-title">{mr.title}</span>
                  <span className="mrs-project">{mr.projectPath}</span>
                  <span className="mrs-meta">
                    {branchLabel(mr.sourceBranch, mr.targetBranch) && <span>{branchLabel(mr.sourceBranch, mr.targetBranch)}</span>}
                    {mr.assignees.length > 0 && <span>assigned {mr.assignees.slice(0, 2).join(", ")}</span>}
                    {typeof mr.userNotesCount === "number" && mr.userNotesCount > 0 && <span>{mr.userNotesCount} comments</span>}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </aside>

      <section className="mrs-detail-panel">
        {children ?? (
          <div className="mrs-detail-empty">
            <h2>Select a merge request</h2>
            <p>Pick an MR to open its dedicated chat and diff review panel.</p>
          </div>
        )}
      </section>
    </div>
  );
}
