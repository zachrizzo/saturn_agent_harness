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

type MergeRequestScope = "assigned_to_me" | "all";
type MergeRequestState = "opened" | "merged" | "closed" | "locked" | "all";

type GitLabUserApi = {
  name?: string;
  username?: string;
  avatar_url?: string;
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
};

function validScope(value: string | null): MergeRequestScope {
  return value === "all" ? "all" : "assigned_to_me";
}

function validState(value: string | null): MergeRequestState {
  if (value === "merged" || value === "closed" || value === "locked" || value === "all") return value;
  return "opened";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function userLabel(user: GitLabUserApi | undefined): string | undefined {
  return user?.name?.trim() || user?.username?.trim() || undefined;
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

function normalizeMr(raw: GitLabMergeRequestListApi, parsed: ParsedGitLabMergeRequestUrl): MergeRequestListItem | null {
  const id = typeof raw.id === "number" ? raw.id : parsed.iid;
  const iid = typeof raw.iid === "number" ? raw.iid : parsed.iid;
  const webUrl = stringValue(raw.web_url) || parsed.sourceUrl;
  const title = stringValue(raw.title) || `Merge request !${iid}`;
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
  };
}

async function listMergeRequests(apiBaseUrl: string, token: string | undefined, scope: MergeRequestScope, state: MergeRequestState, search: string): Promise<GitLabMergeRequestListApi[]> {
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

  return items;
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
    const [rawItems, sessions] = await Promise.all([
      listMergeRequests(apiBaseUrl, auth?.value, scope, state, search),
      listSessions({ compactMeta: true }),
    ]);
    const sessionByTag = sessionsByMrTag(sessions);
    const mergeRequests = rawItems.flatMap((raw) => {
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
        sessionId: sessionByTag.get(item.sessionTag),
      }];
    });

    return NextResponse.json({
      instanceUrl,
      scope,
      state,
      mergeRequests,
      truncated: rawItems.length >= PER_PAGE * MAX_PAGES,
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
