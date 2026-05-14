import { NextRequest, NextResponse } from "next/server";
import {
  GitLabApiError,
  fetchGitLabJson,
  normalizeGitLabInstanceUrl,
  tokenForGitLabHost,
} from "@/lib/gitlab-api";
import {
  gitLabMergeRequestSessionTag,
  parseGitLabMergeRequestUrl,
  type ParsedGitLabMergeRequestUrl,
} from "@/lib/gitlab-mr";
import { listSessions, type SessionMeta } from "@/lib/runs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PER_PAGE = 50;
const MAX_PAGES = 4;
const MAX_PIPELINE_DETAIL_MRS = 120;
const PIPELINE_DETAIL_CONCURRENCY = 8;
const JIRA_PAGE_SIZE = 100;
const ISSUE_KEY_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g;

type GitLabMergeRequestScope = "assigned_to_me" | "reviews_for_me" | "all";
type MergeRequestScope = "mine" | GitLabMergeRequestScope;
type MergeRequestState = "opened" | "merged" | "closed" | "locked" | "all";

type GitLabUserApi = {
  name?: string;
  username?: string;
  avatar_url?: string;
};

type GitLabPipelineApi = Record<string, unknown> & {
  id?: number;
  iid?: number;
  status?: string;
  web_url?: string;
  ref?: string;
  sha?: string;
  created_at?: string;
  updated_at?: string;
  started_at?: string;
  finished_at?: string;
  detailed_status?: {
    text?: string;
    label?: string;
    group?: string;
    tooltip?: string;
  };
};

type GitLabMergeRequestListApi = Record<string, unknown> & {
  id?: number;
  iid?: number;
  title?: string;
  state?: string;
  draft?: boolean;
  work_in_progress?: boolean;
  web_url?: string;
  author?: GitLabUserApi;
  assignees?: GitLabUserApi[];
  reviewers?: GitLabUserApi[];
  source_branch?: string;
  target_branch?: string;
  created_at?: string;
  updated_at?: string;
  changes_count?: string;
  user_notes_count?: number;
  merge_status?: string;
  detailed_merge_status?: string;
  sha?: string;
  head_pipeline?: GitLabPipelineApi | null;
};

type JiraSprintApi = {
  id?: number;
  name?: string;
  state?: string;
};

type JiraSprintListApi = {
  values?: JiraSprintApi[];
};

type JiraIssueApi = {
  key?: string;
};

type JiraIssueListApi = {
  isLast?: boolean;
  issues?: JiraIssueApi[];
  maxResults?: number;
  total?: number;
};

type SprintInfo = {
  configured: boolean;
  source: "env" | "jira" | "unconfigured" | "error";
  issueKeys: string[];
  sprintId?: number;
  sprintName?: string;
  sprintState?: string;
  hint?: string;
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
  createdAt?: string;
  updatedAt?: string;
  changesCount?: string;
  userNotesCount?: number;
  mergeStatus?: string;
  detailedMergeStatus?: string;
  sha?: string;
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
  pipelineCreatedAt?: string;
  pipelineUpdatedAt?: string;
  pipelineStartedAt?: string;
  pipelineFinishedAt?: string;
  issueKeys: string[];
  inCurrentSprint?: boolean;
  sprintName?: string;
};

function validScope(value: string | null): MergeRequestScope {
  if (value === "assigned_to_me" || value === "reviews_for_me" || value === "all") return value;
  return "mine";
}

function validState(value: string | null): MergeRequestState {
  if (value === "merged" || value === "closed" || value === "locked" || value === "all") return value;
  return "opened";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function userLabel(user: GitLabUserApi | undefined): string | undefined {
  return user?.name?.trim() || user?.username?.trim() || undefined;
}

function envValue(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function extractIssueKeys(...values: Array<string | undefined>): string[] {
  const found = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    for (const match of value.matchAll(ISSUE_KEY_RE)) found.add(match[0].toUpperCase());
  }
  return Array.from(found).sort();
}

function configuredSprintIssueKeys(): string[] {
  const raw = envValue("SATURN_CURRENT_SPRINT_ISSUES", "JIRA_CURRENT_SPRINT_ISSUES", "CURRENT_SPRINT_ISSUES");
  return raw ? extractIssueKeys(raw) : [];
}

function jiraBaseUrl(): string | undefined {
  const raw = envValue("JIRA_BASE_URL", "JIRA_URL", "ATLASSIAN_SITE_URL", "ATLASSIAN_BASE_URL");
  if (!raw) return undefined;
  try {
    return new URL(raw).origin;
  } catch {
    return undefined;
  }
}

function jiraAuthHeader(): string | undefined {
  const bearer = envValue("JIRA_PAT", "JIRA_TOKEN", "ATLASSIAN_PAT");
  if (bearer) return `Bearer ${bearer}`;
  const email = envValue("JIRA_EMAIL", "ATLASSIAN_EMAIL");
  const apiToken = envValue("JIRA_API_TOKEN", "ATLASSIAN_API_TOKEN");
  if (!email || !apiToken) return undefined;
  return `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
}

async function fetchJiraJson<T>(baseUrl: string, path: string, authHeader: string): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, {
    cache: "no-store",
    headers: {
      Accept: "application/json",
      Authorization: authHeader,
    },
  });
  if (!res.ok) throw new Error(`Jira returned HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function activeSprintForBoard(baseUrl: string, boardId: string, authHeader: string): Promise<JiraSprintApi | undefined> {
  const params = new URLSearchParams({ state: "active", maxResults: "50" });
  const data = await fetchJiraJson<JiraSprintListApi>(baseUrl, `/rest/agile/1.0/board/${encodeURIComponent(boardId)}/sprint?${params.toString()}`, authHeader);
  return (data.values ?? []).find((sprint) => sprint.state === "active") ?? data.values?.[0];
}

async function issueKeysForSprint(
  baseUrl: string,
  authHeader: string,
  sprintId: number,
  boardId?: string,
): Promise<string[]> {
  const keys = new Set<string>();
  let startAt = 0;

  while (true) {
    const params = new URLSearchParams({
      startAt: String(startAt),
      maxResults: String(JIRA_PAGE_SIZE),
      fields: "key",
    });
    const path = boardId
      ? `/rest/agile/1.0/board/${encodeURIComponent(boardId)}/sprint/${sprintId}/issue?${params.toString()}`
      : `/rest/agile/1.0/sprint/${sprintId}/issue?${params.toString()}`;
    const data = await fetchJiraJson<JiraIssueListApi>(baseUrl, path, authHeader);
    for (const issue of data.issues ?? []) {
      if (issue.key) keys.add(issue.key.toUpperCase());
    }
    const count = data.issues?.length ?? 0;
    if (data.isLast || count === 0) break;
    startAt += count;
    if (typeof data.total === "number" && startAt >= data.total) break;
  }

  return Array.from(keys).sort();
}

async function currentSprintInfo(): Promise<SprintInfo> {
  const configuredKeys = configuredSprintIssueKeys();
  if (configuredKeys.length > 0) {
    return {
      configured: true,
      source: "env",
      issueKeys: configuredKeys,
      sprintName: envValue("SATURN_CURRENT_SPRINT_NAME", "JIRA_CURRENT_SPRINT_NAME", "CURRENT_SPRINT_NAME") ?? "Current sprint",
    };
  }

  const baseUrl = jiraBaseUrl();
  const authHeader = jiraAuthHeader();
  const boardId = envValue("JIRA_BOARD_ID", "ATLASSIAN_BOARD_ID");
  const sprintIdRaw = envValue("JIRA_SPRINT_ID", "SATURN_JIRA_SPRINT_ID", "ATLASSIAN_SPRINT_ID");
  if (!baseUrl || !authHeader || (!boardId && !sprintIdRaw)) {
    return {
      configured: false,
      source: "unconfigured",
      issueKeys: [],
      hint: "Set SATURN_CURRENT_SPRINT_ISSUES, or configure JIRA_BASE_URL, JIRA_EMAIL/JIRA_API_TOKEN, and JIRA_BOARD_ID.",
    };
  }

  try {
    let sprintId = sprintIdRaw ? Number(sprintIdRaw) : NaN;
    let sprintName = envValue("SATURN_CURRENT_SPRINT_NAME", "JIRA_CURRENT_SPRINT_NAME", "CURRENT_SPRINT_NAME");
    let sprintState: string | undefined;

    if ((!Number.isFinite(sprintId) || sprintId <= 0) && boardId) {
      const activeSprint = await activeSprintForBoard(baseUrl, boardId, authHeader);
      sprintId = activeSprint?.id ?? NaN;
      sprintName = sprintName ?? activeSprint?.name;
      sprintState = activeSprint?.state;
    }

    if (!Number.isFinite(sprintId) || sprintId <= 0) {
      return {
        configured: false,
        source: "error",
        issueKeys: [],
        hint: "No active Jira sprint was found for the configured board.",
      };
    }

    const issueKeys = await issueKeysForSprint(baseUrl, authHeader, sprintId, boardId);
    return {
      configured: true,
      source: "jira",
      issueKeys,
      sprintId,
      sprintName: sprintName ?? `Sprint ${sprintId}`,
      sprintState,
    };
  } catch (err) {
    return {
      configured: false,
      source: "error",
      issueKeys: [],
      hint: err instanceof Error ? err.message : "Could not load the current Jira sprint.",
    };
  }
}

function pipelineFields(pipeline: GitLabPipelineApi | null | undefined): Partial<MergeRequestListItem> {
  return {
    pipelineId: numberValue(pipeline?.id),
    pipelineIid: numberValue(pipeline?.iid),
    pipelineStatus: stringValue(pipeline?.status) || stringValue(pipeline?.detailed_status?.group) || undefined,
    pipelineStatusLabel: stringValue(pipeline?.detailed_status?.label) || stringValue(pipeline?.detailed_status?.text) || undefined,
    pipelineStatusGroup: stringValue(pipeline?.detailed_status?.group) || undefined,
    pipelineStatusTooltip: stringValue(pipeline?.detailed_status?.tooltip) || undefined,
    pipelineWebUrl: stringValue(pipeline?.web_url) || undefined,
    pipelineRef: stringValue(pipeline?.ref) || undefined,
    pipelineSha: stringValue(pipeline?.sha) || undefined,
    pipelineCreatedAt: stringValue(pipeline?.created_at) || undefined,
    pipelineUpdatedAt: stringValue(pipeline?.updated_at) || undefined,
    pipelineStartedAt: stringValue(pipeline?.started_at) || undefined,
    pipelineFinishedAt: stringValue(pipeline?.finished_at) || undefined,
  };
}

function sessionUpdatedAt(session: SessionMeta): string {
  return session.turns.at(-1)?.finished_at
    ?? session.turns.at(-1)?.started_at
    ?? session.finished_at
    ?? session.started_at;
}

function sessionsByMrTag(sessions: SessionMeta[]): Map<string, string> {
  const mapped = new Map<string, { sessionId: string; updatedAt: string }>();
  for (const session of sessions) {
    for (const tag of session.tags ?? []) {
      if (!tag.startsWith("gitlab-mr:")) continue;
      const current = mapped.get(tag);
      const updatedAt = sessionUpdatedAt(session);
      if (!current || updatedAt > current.updatedAt) {
        mapped.set(tag, { sessionId: session.session_id, updatedAt });
      }
    }
  }
  return new Map(Array.from(mapped.entries()).map(([tag, item]) => [tag, item.sessionId]));
}

function rawMrKey(raw: GitLabMergeRequestListApi): string {
  return stringValue(raw.web_url) || String(raw.id ?? raw.iid ?? `${stringValue(raw.source_branch)}:${stringValue(raw.target_branch)}`);
}

function rawUpdatedTime(raw: GitLabMergeRequestListApi): number {
  const parsed = Date.parse(stringValue(raw.updated_at));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeMr(raw: GitLabMergeRequestListApi, parsed: ParsedGitLabMergeRequestUrl): MergeRequestListItem | null {
  const id = typeof raw.id === "number" ? raw.id : parsed.iid;
  const iid = typeof raw.iid === "number" ? raw.iid : parsed.iid;
  const webUrl = stringValue(raw.web_url) || parsed.sourceUrl;
  const title = stringValue(raw.title) || `Merge request !${iid}`;
  const issueKeys = extractIssueKeys(title, stringValue(raw.source_branch), stringValue(raw.target_branch), webUrl);
  return {
    id,
    iid,
    title,
    state: stringValue(raw.state) || "unknown",
    draft: raw.draft === true || raw.work_in_progress === true,
    webUrl,
    instanceUrl: parsed.instanceUrl,
    projectPath: parsed.projectPath,
    sessionTag: gitLabMergeRequestSessionTag(parsed),
    authorName: raw.author?.name,
    authorUsername: raw.author?.username,
    assignees: (raw.assignees ?? []).map(userLabel).filter((value): value is string => Boolean(value)),
    reviewers: (raw.reviewers ?? []).map(userLabel).filter((value): value is string => Boolean(value)),
    sourceBranch: stringValue(raw.source_branch),
    targetBranch: stringValue(raw.target_branch),
    createdAt: stringValue(raw.created_at) || undefined,
    updatedAt: stringValue(raw.updated_at) || undefined,
    changesCount: stringValue(raw.changes_count) || undefined,
    userNotesCount: typeof raw.user_notes_count === "number" ? raw.user_notes_count : undefined,
    mergeStatus: stringValue(raw.merge_status) || undefined,
    detailedMergeStatus: stringValue(raw.detailed_merge_status) || undefined,
    sha: stringValue(raw.sha) || undefined,
    issueKeys,
    ...pipelineFields(raw.head_pipeline),
  };
}

function hasPipelineStatus(item: MergeRequestListItem): boolean {
  return Boolean(item.pipelineStatus || item.pipelineStatusLabel || item.pipelineWebUrl);
}

function annotateSprint(items: MergeRequestListItem[], sprint: SprintInfo): MergeRequestListItem[] {
  const sprintKeys = new Set(sprint.issueKeys.map((key) => key.toUpperCase()));
  return items.map((item) => {
    const inCurrentSprint = sprint.configured && item.issueKeys.length > 0
      ? item.issueKeys.some((key) => sprintKeys.has(key))
      : undefined;
    return {
      ...item,
      inCurrentSprint,
      sprintName: inCurrentSprint ? sprint.sprintName : undefined,
    };
  });
}

async function hydratePipelineDetails(
  apiBaseUrl: string,
  token: string | undefined,
  items: MergeRequestListItem[],
): Promise<MergeRequestListItem[]> {
  const hydrated = [...items];
  const indexes = hydrated
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !hasPipelineStatus(item))
    .slice(0, MAX_PIPELINE_DETAIL_MRS);
  let cursor = 0;

  await Promise.all(Array.from({ length: Math.min(PIPELINE_DETAIL_CONCURRENCY, indexes.length) }, async () => {
    while (cursor < indexes.length) {
      const current = indexes[cursor];
      cursor += 1;
      if (!current) continue;

      try {
        const url = `${apiBaseUrl}/projects/${encodeURIComponent(current.item.projectPath)}/merge_requests/${current.item.iid}`;
        const { data } = await fetchGitLabJson<GitLabMergeRequestListApi>(url, token);
        hydrated[current.index] = {
          ...current.item,
          ...pipelineFields(data.head_pipeline),
        };
      } catch {
        // Pipeline visibility varies by project/token. Keep the MR list usable if a status cannot be loaded.
      }
    }
  }));

  return hydrated;
}

async function listMergeRequests(
  apiBaseUrl: string,
  token: string | undefined,
  scope: GitLabMergeRequestScope,
  state: MergeRequestState,
  search: string,
): Promise<{ items: GitLabMergeRequestListApi[]; truncated: boolean }> {
  const items: GitLabMergeRequestListApi[] = [];
  let page = 1;

  while (page <= MAX_PAGES) {
    const url = new URL(`${apiBaseUrl}/merge_requests`);
    url.searchParams.set("scope", scope);
    url.searchParams.set("state", state);
    url.searchParams.set("order_by", "updated_at");
    url.searchParams.set("sort", "desc");
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(PER_PAGE));
    if (search) url.searchParams.set("search", search);

    const { data, nextPage } = await fetchGitLabJson<GitLabMergeRequestListApi[]>(url.toString(), token);
    if (!Array.isArray(data) || data.length === 0) break;
    items.push(...data);
    if (!nextPage) break;
    page = Number(nextPage);
    if (!Number.isFinite(page) || page < 1) break;
  }

  return {
    items,
    truncated: items.length >= PER_PAGE * MAX_PAGES,
  };
}

type RoleAnnotatedMergeRequest = {
  raw: GitLabMergeRequestListApi;
  assignedToMe: boolean;
  reviewRequested: boolean;
};

async function listMergeRequestsForScope(
  apiBaseUrl: string,
  token: string | undefined,
  scope: MergeRequestScope,
  state: MergeRequestState,
  search: string,
): Promise<{ items: RoleAnnotatedMergeRequest[]; truncated: boolean }> {
  if (scope !== "mine") {
    const result = await listMergeRequests(apiBaseUrl, token, scope, state, search);
    return {
      items: result.items.map((raw) => ({
        raw,
        assignedToMe: scope === "assigned_to_me",
        reviewRequested: scope === "reviews_for_me",
      })),
      truncated: result.truncated,
    };
  }

  const [assigned, reviewRequested] = await Promise.all([
    listMergeRequests(apiBaseUrl, token, "assigned_to_me", state, search),
    listMergeRequests(apiBaseUrl, token, "reviews_for_me", state, search),
  ]);
  const merged = new Map<string, RoleAnnotatedMergeRequest>();

  const addItems = (items: GitLabMergeRequestListApi[], role: "assigned" | "review") => {
    for (const raw of items) {
      const key = rawMrKey(raw);
      const existing = merged.get(key);
      if (existing) {
        existing.assignedToMe ||= role === "assigned";
        existing.reviewRequested ||= role === "review";
        continue;
      }
      merged.set(key, {
        raw,
        assignedToMe: role === "assigned",
        reviewRequested: role === "review",
      });
    }
  };

  addItems(assigned.items, "assigned");
  addItems(reviewRequested.items, "review");

  return {
    items: Array.from(merged.values()).sort((left, right) => rawUpdatedTime(right.raw) - rawUpdatedTime(left.raw)),
    truncated: assigned.truncated || reviewRequested.truncated,
  };
}

export async function GET(req: NextRequest) {
  let instanceUrl: string;
  try {
    instanceUrl = normalizeGitLabInstanceUrl(req.nextUrl.searchParams.get("instance"));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid GitLab instance." }, { status: 400 });
  }

  const scope = validScope(req.nextUrl.searchParams.get("scope"));
  const state = validState(req.nextUrl.searchParams.get("state"));
  const search = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  const apiBaseUrl = `${instanceUrl}/api/v4`;
  const auth = await tokenForGitLabHost(instanceUrl);

  try {
    const [listResult, sessions, sprint] = await Promise.all([
      listMergeRequestsForScope(apiBaseUrl, auth?.value, scope, state, search),
      listSessions({ compactMeta: true }),
      currentSprintInfo(),
    ]);
    const sessionByTag = sessionsByMrTag(sessions);
    const mergeRequests = listResult.items.flatMap(({ raw, assignedToMe, reviewRequested }) => {
      const webUrl = stringValue(raw.web_url);
      if (!webUrl) return [];
      let parsed: ParsedGitLabMergeRequestUrl;
      try {
        parsed = parseGitLabMergeRequestUrl(webUrl);
      } catch {
        return [];
      }
      const item = normalizeMr(raw, parsed);
      if (!item) return [];
      return [{
        ...item,
        assignedToMe,
        reviewRequested,
        sessionId: sessionByTag.get(item.sessionTag),
      }];
    });
    const hydratedMergeRequests = await hydratePipelineDetails(apiBaseUrl, auth?.value, mergeRequests);
    const sprintMergeRequests = annotateSprint(hydratedMergeRequests, sprint);

    return NextResponse.json({
      instanceUrl,
      scope,
      state,
      mergeRequests: sprintMergeRequests,
      sprint: {
        configured: sprint.configured,
        source: sprint.source,
        sprintId: sprint.sprintId,
        sprintName: sprint.sprintName,
        sprintState: sprint.sprintState,
        issueCount: sprint.issueKeys.length,
        hint: sprint.hint,
      },
      truncated: listResult.truncated,
      authSource: auth?.source,
    });
  } catch (err) {
    const status = err instanceof GitLabApiError && err.status === 401 ? 401 : 502;
    const message = err instanceof Error ? err.message : "GitLab merge request list failed";
    const hint = status === 401
      ? auth
        ? `The GitLab token from ${auth.source} could not list merge requests on ${instanceUrl}.`
        : "Listing assigned merge requests needs a GitLab token. Run glab auth login, or set GITLAB_TOKEN, GITLAB_PRIVATE_TOKEN, GITLAB_API_TOKEN, GITLAB_PERSONAL_ACCESS_TOKEN, or GITLAB_TOKEN_<HOST> in the dashboard environment."
      : undefined;
    return NextResponse.json({ error: message, hint }, { status });
  }
}
