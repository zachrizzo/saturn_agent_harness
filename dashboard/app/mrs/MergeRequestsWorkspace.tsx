"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { CLI } from "@/lib/runs";
import type { ModelReasoningEffort } from "@/lib/models";

type MergeRequestScope = "mine" | "assigned_to_me" | "reviews_for_me" | "all";
type MergeRequestState = "opened" | "merged" | "closed" | "all";
type MergeRequestGrouping = "none" | "sprint";

const MR_PANEL_COLLAPSED_STORAGE_KEY = "saturn:mrs-panel-collapsed";

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
  assignedToMe?: boolean;
  reviewRequested?: boolean;
  pipelineId?: number;
  pipelineIid?: number;
  pipelineStatus?: string;
  pipelineStatusLabel?: string;
  pipelineStatusGroup?: string;
  pipelineStatusTooltip?: string;
  pipelineWebUrl?: string;
  pipelineRef?: string;
  pipelineSha?: string;
  pipelineUpdatedAt?: string;
  issueKeys: string[];
  inCurrentSprint?: boolean;
  sprintName?: string;
};

type SprintInfo = {
  configured: boolean;
  source: "env" | "jira" | "unconfigured" | "error";
  sprintId?: number;
  sprintName?: string;
  sprintState?: string;
  issueCount?: number;
  hint?: string;
};

type MergeRequestsResponse = {
  instanceUrl?: string;
  scope?: MergeRequestScope;
  state?: MergeRequestState;
  mergeRequests?: MergeRequestListItem[];
  sprint?: SprintInfo;
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

type MergeRequestGroup = {
  key: string;
  title: string;
  description?: string;
  items: MergeRequestListItem[];
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

function statusClass(value?: string): string {
  return (value || "unknown").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

function pipelineLabel(mr: MergeRequestListItem): string {
  return mr.pipelineStatusLabel || mr.pipelineStatus || "no pipeline";
}

function createPinnedMrContext(mr: MergeRequestListItem): string {
  return [
    "GitLab merge request target",
    "",
    `MR: !${mr.iid} ${mr.title}`,
    `URL: ${mr.webUrl}`,
    `Project: ${mr.projectPath}`,
    branchLabel(mr.sourceBranch, mr.targetBranch) ? `Branches: ${branchLabel(mr.sourceBranch, mr.targetBranch)}` : "",
    mr.pipelineStatus || mr.pipelineStatusLabel ? `Pipeline: ${pipelineLabel(mr)}${mr.pipelineWebUrl ? ` (${mr.pipelineWebUrl})` : ""}` : "",
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
  const [scope, setScope] = useState<MergeRequestScope>("mine");
  const [state, setState] = useState<MergeRequestState>("opened");
  const [grouping, setGrouping] = useState<MergeRequestGrouping>("none");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<MergeRequestListItem[]>([]);
  const [sprint, setSprint] = useState<SprintInfo | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [authSource, setAuthSource] = useState<string | undefined>();
  const [openingKey, setOpeningKey] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [panelPreferenceLoaded, setPanelPreferenceLoaded] = useState(false);

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
        setSprint(undefined);
        setTruncated(false);
        return;
      }
      setItems(data?.mergeRequests ?? []);
      setSprint(data?.sprint);
      setTruncated(Boolean(data?.truncated));
      setAuthSource(data?.authSource);
    } catch (err) {
      if (signal?.aborted) return;
      setError(err instanceof Error ? err.message : "Could not load merge requests.");
      setHint(null);
      setItems([]);
      setSprint(undefined);
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

  useEffect(() => {
    try {
      setPanelCollapsed(window.localStorage.getItem(MR_PANEL_COLLAPSED_STORAGE_KEY) === "1");
    } catch {
      setPanelCollapsed(false);
    } finally {
      setPanelPreferenceLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (!panelPreferenceLoaded) return;
    try {
      window.localStorage.setItem(MR_PANEL_COLLAPSED_STORAGE_KEY, panelCollapsed ? "1" : "0");
    } catch {
      // Ignore storage failures; collapsing still works for the current session.
    }
  }, [panelCollapsed, panelPreferenceLoaded]);

  const refresh = () => {
    setRefreshNonce((current) => current + 1);
  };

  const visibleItems = useMemo(() => items, [items]);
  const visibleGroups = useMemo<MergeRequestGroup[]>(() => {
    if (grouping !== "sprint") {
      return [{ key: "all", title: "", items: visibleItems }];
    }

    const current = visibleItems.filter((item) => item.inCurrentSprint === true);
    const outside = visibleItems.filter((item) => item.inCurrentSprint === false);
    const unknown = visibleItems.filter((item) => item.inCurrentSprint !== true && item.inCurrentSprint !== false);
    const sprintLabel = sprint?.sprintName ? `This sprint: ${sprint.sprintName}` : "This sprint";
    const sprintDescription = sprint?.configured
      ? `${(sprint.issueCount ?? 0).toLocaleString()} Jira issue${sprint.issueCount === 1 ? "" : "s"} loaded`
      : sprint?.hint ?? "Configure Jira or SATURN_CURRENT_SPRINT_ISSUES to identify current sprint MRs.";

    return [
      { key: "current", title: sprintLabel, description: sprintDescription, items: current },
      { key: "outside", title: "Not in this sprint", items: outside },
      { key: "unknown", title: sprint?.configured ? "No Jira key found" : "Sprint unknown", description: sprint?.configured ? undefined : sprintDescription, items: unknown },
    ].filter((group) => group.items.length > 0 || group.key === "current");
  }, [grouping, sprint, visibleItems]);

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
    <div className={`mrs-workspace ${panelCollapsed ? "mrs-workspace-panel-collapsed" : ""}`.trim()}>
      <aside className={`mrs-list-panel ${panelCollapsed ? "is-collapsed" : ""}`.trim()} aria-label="Merge requests">
        {panelCollapsed ? (
          <div className="mrs-collapsed-rail">
            <button
              type="button"
              className="mrs-icon-button"
              onClick={() => setPanelCollapsed(false)}
              title="Expand merge requests panel"
              aria-label="Expand merge requests panel"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m9 18 6-6-6-6" />
              </svg>
            </button>
            <span className="mrs-collapsed-label">Merge requests</span>
            <span
              className="mrs-collapsed-count"
              aria-label={loading && visibleItems.length === 0 ? "Loading merge requests" : `${visibleItems.length} merge requests in list`}
            >
              {loading && visibleItems.length === 0 ? "..." : visibleItems.length}
            </span>
          </div>
        ) : (
          <>
            <div className="mrs-list-head">
              <div>
                <h1>Merge requests</h1>
                <p>{authSource ? `GitLab auth: ${authSource}` : "GitLab merge request queue"}</p>
              </div>
              <div className="mrs-head-actions">
                <button
                  type="button"
                  className="mrs-icon-button"
                  onClick={() => setPanelCollapsed(true)}
                  title="Collapse merge requests panel"
                  aria-label="Collapse merge requests panel"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="m15 18-6-6 6-6" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="mrs-icon-button"
                  onClick={refresh}
                  title="Refresh merge requests"
                  aria-label="Refresh merge requests"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M21 12a9 9 0 0 1-15.3 6.4L3 16" />
                    <path d="M3 21v-5h5" />
                    <path d="M3 12a9 9 0 0 1 15.3-6.4L21 8" />
                    <path d="M21 3v5h-5" />
                  </svg>
                </button>
              </div>
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
                <button
                  type="button"
                  className={`chip-filter ${scope === "mine" ? "on" : ""}`}
                  onClick={() => setScope("mine")}
                >
                  Mine
                </button>
                <button
                  type="button"
                  className={`chip-filter ${scope === "assigned_to_me" ? "on" : ""}`}
                  onClick={() => setScope("assigned_to_me")}
                >
                  Assigned
                </button>
                <button
                  type="button"
                  className={`chip-filter ${scope === "reviews_for_me" ? "on" : ""}`}
                  onClick={() => setScope("reviews_for_me")}
                >
                  Reviewing
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
              <div className="mrs-filter-row">
                <span className="mrs-filter-label">Group</span>
                <button type="button" className={`chip-filter ${grouping === "none" ? "on" : ""}`} onClick={() => setGrouping("none")}>
                  None
                </button>
                <button type="button" className={`chip-filter ${grouping === "sprint" ? "on" : ""}`} onClick={() => setGrouping("sprint")}>
                  Sprint
                </button>
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
                visibleGroups.map((group) => (
                  <div key={group.key} className="mrs-group">
                    {group.title && (
                      <div className="mrs-group-head">
                        <span>{group.title}</span>
                        <span>{group.items.length.toLocaleString()}</span>
                        {group.description && <small>{group.description}</small>}
                      </div>
                    )}
                    {group.items.map((mr) => {
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
                            {mr.reviewRequested && <span className="mrs-role-chip review">review</span>}
                            {mr.assignedToMe && <span className="mrs-role-chip assigned">assigned</span>}
                            {mr.inCurrentSprint && <span className="mrs-sprint-chip">sprint</span>}
                            {mr.pipelineStatus && (
                              <span
                                className={`mrs-pipeline-chip ${statusClass(mr.pipelineStatusGroup || mr.pipelineStatus)}`}
                                title={mr.pipelineStatusTooltip || `Pipeline ${pipelineLabel(mr)}`}
                              >
                                ci {pipelineLabel(mr)}
                              </span>
                            )}
                            <span className="mrs-updated">{shortDate(mr.updatedAt)}</span>
                          </span>
                          <span className="mrs-title">{mr.title}</span>
                          <span className="mrs-project">{mr.projectPath}</span>
                          <span className="mrs-meta">
                            {(mr.issueKeys ?? []).length > 0 && <span>{(mr.issueKeys ?? []).slice(0, 3).join(", ")}</span>}
                            {branchLabel(mr.sourceBranch, mr.targetBranch) && <span>{branchLabel(mr.sourceBranch, mr.targetBranch)}</span>}
                            {mr.assignees.length > 0 && <span>assigned {mr.assignees.slice(0, 2).join(", ")}</span>}
                            {mr.reviewers.length > 0 && <span>review {mr.reviewers.slice(0, 2).join(", ")}</span>}
                            {mr.pipelineUpdatedAt && <span>ci updated {shortDate(mr.pipelineUpdatedAt)}</span>}
                            {typeof mr.userNotesCount === "number" && mr.userNotesCount > 0 && <span>{mr.userNotesCount} comments</span>}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          </>
        )}
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
