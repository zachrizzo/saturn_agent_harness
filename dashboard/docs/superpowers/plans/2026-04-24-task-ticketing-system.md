# Task Ticketing System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an internal task/ticketing system where humans and agents can create, claim, update, and complete tasks, with atomic file-based claim locking to prevent double-work.

**Architecture:** Tasks are stored as directories under `AUTOMATIONS_ROOT/tasks/{id}/` with `meta.json`, `activity.jsonl`, and an optional `claim.lock`. Claiming uses Node's `O_EXCL` open flag for atomic mutual exclusion. A Next.js API layer exposes all operations; the UI adds a `/tasks` page and a dashboard widget.

**Tech Stack:** Next.js 14 App Router, TypeScript, Node.js `fs` (no new dependencies), existing Tailwind/Card/Button/Badge UI components, `node:crypto` `randomUUID` for IDs.

---

## File Map

**New files:**
- `lib/tasks.ts` — Task types + all file I/O (list, get, create, update, delete, claim, release, renew, appendActivity)
- `app/api/tasks/route.ts` — GET (list) + POST (create)
- `app/api/tasks/[id]/route.ts` — GET (detail) + PATCH (update) + DELETE
- `app/api/tasks/[id]/claim/route.ts` — POST (atomic claim)
- `app/api/tasks/[id]/release/route.ts` — POST (release)
- `app/api/tasks/[id]/renew/route.ts` — POST (renew TTL)
- `app/components/dashboard/TasksWidget.tsx` — Dashboard summary card
- `app/(app)/tasks/page.tsx` — Full /tasks page (list + board views)
- `app/(app)/tasks/[id]/page.tsx` — Task detail page

**Modified files:**
- `lib/paths.ts` — Add task path helpers
- `app/(app)/page.tsx` — Import and render TasksWidget
- `app/components/shell/Sidebar.tsx` — Add Tasks nav item
- `app/components/shell/icons.tsx` — Add IconTask

---

## Task 1: Add path helpers

**Files:**
- Modify: `lib/paths.ts`

- [ ] **Step 1: Add task path helpers**

Open `lib/paths.ts` and add after the `binDir()` function:

```ts
export function tasksDir(): string {
  return path.join(automationsRoot(), "tasks");
}

export function taskDir(id: string): string {
  return path.join(tasksDir(), id);
}

export function taskMetaPath(id: string): string {
  return path.join(taskDir(id), "meta.json");
}

export function taskActivityPath(id: string): string {
  return path.join(taskDir(id), "activity.jsonl");
}

export function taskClaimPath(id: string): string {
  return path.join(taskDir(id), "claim.lock");
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd "/Users/zachrizzo/programming/ai harnnes/dashboard" && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git -C "/Users/zachrizzo/programming/ai harnnes/dashboard" add lib/paths.ts && git -C "/Users/zachrizzo/programming/ai harnnes/dashboard" commit -m "feat: add task path helpers to lib/paths.ts"
```

---

## Task 2: Create lib/tasks.ts — types and file I/O

**Files:**
- Create: `lib/tasks.ts`

- [ ] **Step 1: Create lib/tasks.ts**

Create `/Users/zachrizzo/programming/ai harnnes/dashboard/lib/tasks.ts` with this full content:

```ts
import { promises as fs, constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { tasksDir, taskDir, taskMetaPath, taskActivityPath, taskClaimPath } from "./paths";

export type TaskStatus = "open" | "in_progress" | "done" | "cancelled";
export type TaskPriority = "low" | "medium" | "high" | "critical";

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  created_by: string;
  created_at: string;
  updated_at: string;
  tags: string[];
  linked_session_id: string | null;
  linked_job_name: string | null;
  notes: string;
}

export interface TaskClaim {
  claimed_by: string;
  claimed_at: string;
  expires_at: string;
}

export interface TaskActivity {
  ts: string;
  actor: string;
  action:
    | "created"
    | "claimed"
    | "released"
    | "commented"
    | "status_changed"
    | "updated"
    | "completed";
  detail: string;
}

export interface TaskDetail extends Task {
  claim: TaskClaim | null;
  activity: TaskActivity[];
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function readMeta(id: string): Promise<Task> {
  const raw = await fs.readFile(taskMetaPath(id), "utf8");
  return JSON.parse(raw) as Task;
}

async function writeMeta(task: Task): Promise<void> {
  await fs.writeFile(taskMetaPath(task.id), JSON.stringify(task, null, 2), "utf8");
}

async function readClaim(id: string): Promise<TaskClaim | null> {
  try {
    const raw = await fs.readFile(taskClaimPath(id), "utf8");
    return JSON.parse(raw) as TaskClaim;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function appendActivity(id: string, entry: TaskActivity): Promise<void> {
  await fs.appendFile(taskActivityPath(id), JSON.stringify(entry) + "\n", "utf8");
}

async function readActivity(id: string): Promise<TaskActivity[]> {
  try {
    const raw = await fs.readFile(taskActivityPath(id), "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as TaskActivity);
  } catch {
    return [];
  }
}

// ── public API ────────────────────────────────────────────────────────────────

export async function listTasks(opts?: {
  status?: TaskStatus;
  priority?: TaskPriority;
  tag?: string;
  limit?: number;
}): Promise<Task[]> {
  let ids: string[];
  try {
    const entries = await fs.readdir(tasksDir(), { withFileTypes: true });
    ids = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const tasks: Task[] = [];
  for (const id of ids) {
    try {
      tasks.push(await readMeta(id));
    } catch {
      // skip corrupt tasks
    }
  }

  let filtered = tasks;
  if (opts?.status) filtered = filtered.filter((t) => t.status === opts.status);
  if (opts?.priority) filtered = filtered.filter((t) => t.priority === opts.priority);
  if (opts?.tag) filtered = filtered.filter((t) => t.tags.includes(opts.tag!));

  filtered.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  if (opts?.limit) filtered = filtered.slice(0, opts.limit);
  return filtered;
}

export async function getTask(id: string): Promise<TaskDetail | null> {
  try {
    const [task, claim, activity] = await Promise.all([
      readMeta(id),
      readClaim(id),
      readActivity(id),
    ]);
    return { ...task, claim, activity };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function createTask(input: {
  title: string;
  description?: string;
  priority?: TaskPriority;
  tags?: string[];
  created_by: string;
}): Promise<Task> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const task: Task = {
    id,
    title: input.title,
    description: input.description ?? "",
    status: "open",
    priority: input.priority ?? "medium",
    created_by: input.created_by,
    created_at: now,
    updated_at: now,
    tags: input.tags ?? [],
    linked_session_id: null,
    linked_job_name: null,
    notes: "",
  };

  await fs.mkdir(taskDir(id), { recursive: true });
  await writeMeta(task);
  await fs.writeFile(taskActivityPath(id), "", "utf8");
  await appendActivity(id, { ts: now, actor: input.created_by, action: "created", detail: task.title });
  return task;
}

export async function updateTask(
  id: string,
  patch: Partial<Pick<Task, "title" | "description" | "status" | "priority" | "tags" | "notes" | "linked_session_id" | "linked_job_name">>,
  actor: string
): Promise<Task> {
  const task = await readMeta(id);
  const now = new Date().toISOString();
  const updated: Task = { ...task, ...patch, updated_at: now };
  await writeMeta(updated);

  const statusChanged = patch.status && patch.status !== task.status;
  if (statusChanged) {
    await appendActivity(id, { ts: now, actor, action: "status_changed", detail: `${task.status}→${patch.status}` });
  } else {
    await appendActivity(id, { ts: now, actor, action: "updated", detail: Object.keys(patch).join(", ") });
  }
  return updated;
}

export async function deleteTask(id: string): Promise<void> {
  await fs.rm(taskDir(id), { recursive: true, force: true });
}

const DEFAULT_TTL_MINUTES = 15;

export async function claimTask(
  id: string,
  claimedBy: string,
  ttlMinutes = DEFAULT_TTL_MINUTES
): Promise<{ ok: true } | { ok: false; conflict: true; claimed_by: string; expires_at: string }> {
  const now = new Date();

  const existing = await readClaim(id);
  if (existing) {
    if (new Date(existing.expires_at) > now) {
      return { ok: false, conflict: true, claimed_by: existing.claimed_by, expires_at: existing.expires_at };
    }
    await fs.unlink(taskClaimPath(id)).catch(() => {});
    await appendActivity(id, { ts: now.toISOString(), actor: "system", action: "released", detail: "stale lock expired" });
  }

  const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000).toISOString();
  const claimData: TaskClaim = { claimed_by: claimedBy, claimed_at: now.toISOString(), expires_at: expiresAt };

  try {
    const fd = await fs.open(taskClaimPath(id), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    await fd.writeFile(JSON.stringify(claimData, null, 2), "utf8");
    await fd.close();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      const fresh = await readClaim(id);
      return {
        ok: false,
        conflict: true,
        claimed_by: fresh?.claimed_by ?? "unknown",
        expires_at: fresh?.expires_at ?? "",
      };
    }
    throw err;
  }

  await updateTask(id, { status: "in_progress" }, claimedBy);
  await appendActivity(id, { ts: now.toISOString(), actor: claimedBy, action: "claimed", detail: `expires ${expiresAt}` });
  return { ok: true };
}

export async function releaseTask(
  id: string,
  claimedBy: string,
  newStatus?: TaskStatus
): Promise<{ ok: true } | { ok: false; forbidden: true }> {
  const claim = await readClaim(id);
  if (!claim || claim.claimed_by !== claimedBy) return { ok: false, forbidden: true };

  await fs.unlink(taskClaimPath(id));
  const status = newStatus ?? "open";
  await updateTask(id, { status }, claimedBy);
  await appendActivity(id, { ts: new Date().toISOString(), actor: claimedBy, action: "released", detail: `status→${status}` });
  return { ok: true };
}

export async function renewTaskClaim(
  id: string,
  claimedBy: string,
  ttlMinutes = DEFAULT_TTL_MINUTES
): Promise<{ ok: true; expires_at: string } | { ok: false; forbidden: true }> {
  const claim = await readClaim(id);
  if (!claim || claim.claimed_by !== claimedBy) return { ok: false, forbidden: true };

  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000).toISOString();
  const updated: TaskClaim = { ...claim, expires_at: expiresAt };
  await fs.writeFile(taskClaimPath(id), JSON.stringify(updated, null, 2), "utf8");
  await appendActivity(id, { ts: new Date().toISOString(), actor: claimedBy, action: "updated", detail: `renewed until ${expiresAt}` });
  return { ok: true, expires_at: expiresAt };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd "/Users/zachrizzo/programming/ai harnnes/dashboard" && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git -C "/Users/zachrizzo/programming/ai harnnes/dashboard" add lib/tasks.ts && git -C "/Users/zachrizzo/programming/ai harnnes/dashboard" commit -m "feat: add lib/tasks.ts with types, file I/O, and claim locking"
```

---

## Task 3: API route — list and create tasks

**Files:**
- Create: `app/api/tasks/route.ts`

- [ ] **Step 1: Create app/api/tasks/route.ts**

```ts
import { NextRequest, NextResponse } from "next/server";
import { listTasks, createTask, type TaskStatus, type TaskPriority } from "@/lib/tasks";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const status = searchParams.get("status") as TaskStatus | null;
  const priority = searchParams.get("priority") as TaskPriority | null;
  const tag = searchParams.get("tag") ?? undefined;
  const limit = searchParams.get("limit") ? Number(searchParams.get("limit")) : undefined;

  const tasks = await listTasks({
    status: status ?? undefined,
    priority: priority ?? undefined,
    tag,
    limit,
  });
  return NextResponse.json({ tasks });
}

export async function POST(req: NextRequest) {
  const body = await req.json() as {
    title?: string;
    description?: string;
    priority?: TaskPriority;
    tags?: string[];
    created_by?: string;
  };

  if (!body.title?.trim()) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  const task = await createTask({
    title: body.title.trim(),
    description: body.description,
    priority: body.priority,
    tags: body.tags,
    created_by: body.created_by ?? "human",
  });
  return NextResponse.json({ task }, { status: 201 });
}
```

- [ ] **Step 2: Smoke-test the route**

Start the dev server if not running (`npm run dev` in the dashboard directory, port 3737).

```bash
curl -s http://127.0.0.1:3737/api/tasks
```

Expected: `{"tasks":[]}`

```bash
curl -s -X POST http://127.0.0.1:3737/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"Test task","priority":"high","created_by":"human"}' | python3 -m json.tool
```

Expected: JSON with `task.id`, `task.status: "open"`, `task.priority: "high"`

- [ ] **Step 3: Commit**

```bash
git -C "/Users/zachrizzo/programming/ai harnnes/dashboard" add app/api/tasks/route.ts && git -C "/Users/zachrizzo/programming/ai harnnes/dashboard" commit -m "feat: add GET/POST /api/tasks route"
```

---

## Task 4: API route — get, update, delete task

**Files:**
- Create: `app/api/tasks/[id]/route.ts`

- [ ] **Step 1: Create app/api/tasks/[id]/route.ts**

```ts
import { NextRequest, NextResponse } from "next/server";
import { getTask, updateTask, deleteTask, type TaskStatus, type TaskPriority } from "@/lib/tasks";

export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function GET(_req: NextRequest, { params }: Params) {
  const task = await getTask(params.id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ task });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const body = await req.json() as {
    title?: string;
    description?: string;
    status?: TaskStatus;
    priority?: TaskPriority;
    tags?: string[];
    notes?: string;
    linked_session_id?: string | null;
    linked_job_name?: string | null;
    actor?: string;
  };

  try {
    const { actor, ...patch } = body;
    const task = await updateTask(params.id, patch, actor ?? "human");
    return NextResponse.json({ task });
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    throw err;
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  await deleteTask(params.id);
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Smoke-test**

```bash
TASK_ID=$(curl -s http://127.0.0.1:3737/api/tasks | python3 -c "import sys,json; t=json.load(sys.stdin)['tasks']; print(t[0]['id'] if t else '')")
echo "Task ID: $TASK_ID"
curl -s http://127.0.0.1:3737/api/tasks/$TASK_ID | python3 -m json.tool | head -20
```

Expected: full task detail with `claim: null` and `activity` array.

- [ ] **Step 3: Commit**

```bash
git -C "/Users/zachrizzo/programming/ai harnnes/dashboard" add "app/api/tasks/[id]/route.ts" && git -C "/Users/zachrizzo/programming/ai harnnes/dashboard" commit -m "feat: add GET/PATCH/DELETE /api/tasks/[id] route"
```

---

## Task 5: API routes — claim, release, renew

**Files:**
- Create: `app/api/tasks/[id]/claim/route.ts`
- Create: `app/api/tasks/[id]/release/route.ts`
- Create: `app/api/tasks/[id]/renew/route.ts`

- [ ] **Step 1: Create claim route** at `app/api/tasks/[id]/claim/route.ts`

```ts
import { NextRequest, NextResponse } from "next/server";
import { claimTask } from "@/lib/tasks";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json() as { claimed_by?: string; ttl_minutes?: number };
  if (!body.claimed_by?.trim()) {
    return NextResponse.json({ error: "claimed_by is required" }, { status: 400 });
  }

  const result = await claimTask(params.id, body.claimed_by, body.ttl_minutes);
  if (!result.ok) {
    return NextResponse.json({ error: "already claimed", ...result }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 2: Create release route** at `app/api/tasks/[id]/release/route.ts`

```ts
import { NextRequest, NextResponse } from "next/server";
import { releaseTask, type TaskStatus } from "@/lib/tasks";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json() as { claimed_by?: string; status?: TaskStatus };
  if (!body.claimed_by?.trim()) {
    return NextResponse.json({ error: "claimed_by is required" }, { status: 400 });
  }

  const result = await releaseTask(params.id, body.claimed_by, body.status);
  if (!result.ok) {
    return NextResponse.json({ error: "forbidden: claimed_by mismatch" }, { status: 403 });
  }
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Create renew route** at `app/api/tasks/[id]/renew/route.ts`

```ts
import { NextRequest, NextResponse } from "next/server";
import { renewTaskClaim } from "@/lib/tasks";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const body = await req.json() as { claimed_by?: string; ttl_minutes?: number };
  if (!body.claimed_by?.trim()) {
    return NextResponse.json({ error: "claimed_by is required" }, { status: 400 });
  }

  const result = await renewTaskClaim(params.id, body.claimed_by, body.ttl_minutes);
  if (!result.ok) {
    return NextResponse.json({ error: "forbidden: claimed_by mismatch" }, { status: 403 });
  }
  return NextResponse.json({ ok: true, expires_at: result.expires_at });
}
```

- [ ] **Step 4: Smoke-test claim locking**

```bash
TASK_ID=$(curl -s http://127.0.0.1:3737/api/tasks | python3 -c "import sys,json; t=json.load(sys.stdin)['tasks']; print(t[0]['id'] if t else '')")

# Claim it
curl -s -X POST http://127.0.0.1:3737/api/tasks/$TASK_ID/claim \
  -H "Content-Type: application/json" \
  -d '{"claimed_by":"agent-1"}' | python3 -m json.tool

# Try to claim again — should 409
curl -s -X POST http://127.0.0.1:3737/api/tasks/$TASK_ID/claim \
  -H "Content-Type: application/json" \
  -d '{"claimed_by":"agent-2"}' | python3 -m json.tool

# Release
curl -s -X POST http://127.0.0.1:3737/api/tasks/$TASK_ID/release \
  -H "Content-Type: application/json" \
  -d '{"claimed_by":"agent-1"}' | python3 -m json.tool
```

Expected: first claim `{"ok":true}`, second `{"error":"already claimed","ok":false,"conflict":true,...}`, release `{"ok":true}`.

- [ ] **Step 5: Commit**

```bash
git -C "/Users/zachrizzo/programming/ai harnnes/dashboard" add "app/api/tasks/[id]/claim/route.ts" "app/api/tasks/[id]/release/route.ts" "app/api/tasks/[id]/renew/route.ts" && git -C "/Users/zachrizzo/programming/ai harnnes/dashboard" commit -m "feat: add claim/release/renew API routes with atomic O_EXCL locking"
```

---

## Task 6: Add IconTask and Tasks nav item

**Files:**
- Modify: `app/components/shell/icons.tsx`
- Modify: `app/components/shell/Sidebar.tsx`

- [ ] **Step 1: Add IconTask to icons.tsx**

Append to the end of `app/components/shell/icons.tsx`:

```tsx
export function IconTask() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
    </svg>
  );
}
```

- [ ] **Step 2: Update Sidebar.tsx**

In `app/components/shell/Sidebar.tsx`:

1. Change the import on line 7 from:
```tsx
import { IconHome, IconChat, IconAgent, IconJob } from "./icons";
```
to:
```tsx
import { IconHome, IconChat, IconAgent, IconJob, IconTask } from "./icons";
```

2. Add to the `NAV` array after the Jobs entry (after `{ href: "/jobs", ... }`):
```tsx
{ href: "/tasks", label: "Tasks", icon: <IconTask />, match: matchPrefix("/tasks") },
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd "/Users/zachrizzo/programming/ai harnnes/dashboard" && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git -C "/Users/zachrizzo/programming/ai harnnes/dashboard" add app/components/shell/icons.tsx app/components/shell/Sidebar.tsx && git -C "/Users/zachrizzo/programming/ai harnnes/dashboard" commit -m "feat: add Tasks nav item and IconTask to sidebar"
```

---

## Task 7: Dashboard TasksWidget

**Files:**
- Create: `app/components/dashboard/TasksWidget.tsx`
- Modify: `app/(app)/page.tsx`

- [ ] **Step 1: Create TasksWidget.tsx**

Create `app/components/dashboard/TasksWidget.tsx`:

```tsx
import Link from "next/link";
import { Card } from "@/app/components/ui/Card";
import type { Task } from "@/lib/tasks";

const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const PRIORITY_COLOR: Record<string, string> = {
  critical: "text-fail",
  high: "text-warn",
  medium: "text-accent",
  low: "text-subtle",
};

type Props = { tasks: Task[] };

export function TasksWidget({ tasks }: Props) {
  const open = tasks.filter((t) => t.status === "open").length;
  const inProgress = tasks.filter((t) => t.status === "in_progress").length;
  const done = tasks.filter((t) => t.status === "done").length;

  const topOpen = tasks
    .filter((t) => t.status === "open")
    .sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9))
    .slice(0, 3);

  return (
    <Card className="px-4 py-3">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-[13px] font-semibold tracking-tight">Tasks</h2>
        <Link href="/tasks" className="text-[11px] text-accent hover:underline">
          View all →
        </Link>
      </div>

      <div className="flex gap-4 mb-3">
        {[
          { label: "Open", value: open },
          { label: "In Progress", value: inProgress },
          { label: "Done", value: done },
        ].map((s) => (
          <div key={s.label}>
            <div className="text-[10px] uppercase tracking-wider text-subtle">{s.label}</div>
            <div className="text-[18px] font-semibold tabular-nums text-fg">{s.value}</div>
          </div>
        ))}
      </div>

      {topOpen.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {topOpen.map((t) => (
            <li key={t.id}>
              <Link href={`/tasks/${t.id}`} className="flex items-center gap-2 text-[12px] hover:text-accent transition-colors">
                <span className={`shrink-0 text-[10px] uppercase font-medium ${PRIORITY_COLOR[t.priority]}`}>
                  {t.priority}
                </span>
                <span className="truncate text-fg">{t.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12px] text-subtle">No open tasks.</p>
      )}
    </Card>
  );
}
```

- [ ] **Step 2: Update app/(app)/page.tsx**

1. Add imports after the existing imports:
```tsx
import { listTasks } from "@/lib/tasks";
import { TasksWidget } from "../components/dashboard/TasksWidget";
```

2. Change the `Promise.all` call from:
```tsx
const [jobs, allRuns, sessions] = await Promise.all([
  listJobs(),
  listRuns(),
  listSessions(),
]);
```
to:
```tsx
const [jobs, allRuns, sessions, tasks] = await Promise.all([
  listJobs(),
  listRuns(),
  listSessions(),
  listTasks(),
]);
```

3. Add `<TasksWidget tasks={tasks} />` between `<KpiRow ... />` and `<RecentChatsRail ... />`:
```tsx
<KpiRow ... />

<TasksWidget tasks={tasks} />

<RecentChatsRail sessions={sessions} />
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd "/Users/zachrizzo/programming/ai harnnes/dashboard" && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git -C "/Users/zachrizzo/programming/ai harnnes/dashboard" add app/components/dashboard/TasksWidget.tsx "app/(app)/page.tsx" && git -C "/Users/zachrizzo/programming/ai harnnes/dashboard" commit -m "feat: add TasksWidget to dashboard page"
```

---

## Task 8: /tasks list and board page

**Files:**
- Create: `app/(app)/tasks/page.tsx`

- [ ] **Step 1: Create app/(app)/tasks/page.tsx**

```tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Card } from "@/app/components/ui/Card";
import { Button } from "@/app/components/ui/Button";
import { Input } from "@/app/components/ui/Input";
import { Select } from "@/app/components/ui/Select";
import type { Task, TaskStatus, TaskPriority } from "@/lib/tasks";

const PRIORITY_COLOR: Record<string, string> = {
  critical: "text-fail border-fail/30 bg-fail/10",
  high: "text-warn border-warn/30 bg-warn/10",
  medium: "text-accent border-accent/30 bg-accent/10",
  low: "text-subtle border-border bg-bg-subtle",
};

const STATUS_COLUMNS: TaskStatus[] = ["open", "in_progress", "done"];

function PriorityBadge({ priority }: { priority: TaskPriority }) {
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] uppercase font-medium border ${PRIORITY_COLOR[priority]}`}>
      {priority}
    </span>
  );
}

function StatusBadge({ status }: { status: TaskStatus }) {
  const cls =
    status === "done" ? "text-success" :
    status === "in_progress" ? "text-accent" :
    status === "cancelled" ? "text-subtle line-through" :
    "text-muted";
  return <span className={`text-[11px] font-medium ${cls}`}>{status.replace("_", " ")}</span>;
}

function CreateTaskModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [tags, setTags] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setLoading(true);
    await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: title.trim(),
        description,
        priority,
        tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
        created_by: "human",
      }),
    });
    setLoading(false);
    onCreated();
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <Card className="w-full max-w-md p-5">
        <h2 className="text-[15px] font-semibold mb-4">New task</h2>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div>
            <label className="text-[11px] text-subtle uppercase tracking-wide mb-1 block">Title *</label>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs to be done?" required />
          </div>
          <div>
            <label className="text-[11px] text-subtle uppercase tracking-wide mb-1 block">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="input w-full h-20 resize-none text-[13px]"
              placeholder="Optional details..."
            />
          </div>
          <div>
            <label className="text-[11px] text-subtle uppercase tracking-wide mb-1 block">Priority</label>
            <Select value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </Select>
          </div>
          <div>
            <label className="text-[11px] text-subtle uppercase tracking-wide mb-1 block">Tags (comma-separated)</label>
            <Input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="bug, cron, agent-x" />
          </div>
          <div className="flex gap-2 justify-end pt-1">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={loading || !title.trim()}>
              {loading ? "Creating..." : "Create task"}
            </Button>
          </div>
        </form>
      </Card>
    </div>
  );
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [view, setView] = useState<"list" | "board">("list");
  const [filterStatus, setFilterStatus] = useState<TaskStatus | "">("");
  const [filterPriority, setFilterPriority] = useState<TaskPriority | "">("");
  const [showCreate, setShowCreate] = useState(false);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (filterStatus) params.set("status", filterStatus);
    if (filterPriority) params.set("priority", filterPriority);
    const res = await fetch(`/api/tasks?${params}`);
    const data = await res.json() as { tasks: Task[] };
    setTasks(data.tasks ?? []);
  }, [filterStatus, filterPriority]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tasks</h1>
          <p className="text-sm text-muted mt-1">Shared task queue for humans and agents.</p>
        </div>
        <Button variant="primary" onClick={() => setShowCreate(true)}>+ New task</Button>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value as TaskStatus | "")}>
          <option value="">All statuses</option>
          <option value="open">Open</option>
          <option value="in_progress">In Progress</option>
          <option value="done">Done</option>
          <option value="cancelled">Cancelled</option>
        </Select>
        <Select value={filterPriority} onChange={(e) => setFilterPriority(e.target.value as TaskPriority | "")}>
          <option value="">All priorities</option>
          <option value="critical">Critical</option>
          <option value="high">High</option>
          <option value="medium">Medium</option>
          <option value="low">Low</option>
        </Select>
        <div className="ml-auto flex gap-1">
          <Button size="sm" variant={view === "list" ? "primary" : "ghost"} onClick={() => setView("list")}>List</Button>
          <Button size="sm" variant={view === "board" ? "primary" : "ghost"} onClick={() => setView("board")}>Board</Button>
        </div>
      </div>

      {view === "list" && (
        <Card>
          {tasks.length === 0 ? (
            <div className="px-4 py-8 text-center text-subtle text-[13px]">No tasks found.</div>
          ) : (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-[var(--border)] text-[11px] uppercase tracking-wider text-subtle">
                  <th className="text-left px-4 py-2 font-medium">Title</th>
                  <th className="text-left px-4 py-2 font-medium">Priority</th>
                  <th className="text-left px-4 py-2 font-medium">Status</th>
                  <th className="text-left px-4 py-2 font-medium hidden md:table-cell">Created</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((t) => (
                  <tr key={t.id} className="border-b border-[var(--border)] last:border-0 hover:bg-bg-hover transition-colors">
                    <td className="px-4 py-2.5">
                      <Link href={`/tasks/${t.id}`} className="hover:text-accent transition-colors font-medium">
                        {t.title}
                      </Link>
                      {t.tags.length > 0 && (
                        <div className="flex gap-1 mt-0.5 flex-wrap">
                          {t.tags.map((tag) => (
                            <span key={tag} className="text-[10px] text-subtle bg-bg-subtle rounded px-1">{tag}</span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-2.5"><PriorityBadge priority={t.priority} /></td>
                    <td className="px-4 py-2.5"><StatusBadge status={t.status} /></td>
                    <td className="px-4 py-2.5 text-subtle hidden md:table-cell">
                      {new Date(t.created_at).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {view === "board" && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {STATUS_COLUMNS.map((col) => {
            const colTasks = tasks.filter((t) => t.status === col);
            return (
              <div key={col}>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[11px] uppercase tracking-wider font-medium text-subtle">
                    {col.replace("_", " ")}
                  </span>
                  <span className="text-[11px] text-subtle">({colTasks.length})</span>
                </div>
                <div className="flex flex-col gap-2">
                  {colTasks.map((t) => (
                    <Card key={t.id} interactive className="px-3 py-2.5">
                      <Link href={`/tasks/${t.id}`} className="block hover:text-accent transition-colors">
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <span className="text-[13px] font-medium leading-snug">{t.title}</span>
                          <PriorityBadge priority={t.priority} />
                        </div>
                        {t.tags.length > 0 && (
                          <div className="flex gap-1 flex-wrap">
                            {t.tags.map((tag) => (
                              <span key={tag} className="text-[10px] text-subtle bg-bg-subtle rounded px-1">{tag}</span>
                            ))}
                          </div>
                        )}
                      </Link>
                    </Card>
                  ))}
                  {colTasks.length === 0 && (
                    <div className="text-[12px] text-subtle px-1">Empty</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showCreate && <CreateTaskModal onClose={() => setShowCreate(false)} onCreated={load} />}
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd "/Users/zachrizzo/programming/ai harnnes/dashboard" && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors

- [ ] **Step 3: Test in browser**

Navigate to `http://127.0.0.1:3737/tasks`. Verify list view loads, board toggle works, create modal opens and creates a task.

- [ ] **Step 4: Commit**

```bash
git -C "/Users/zachrizzo/programming/ai harnnes/dashboard" add "app/(app)/tasks/page.tsx" && git -C "/Users/zachrizzo/programming/ai harnnes/dashboard" commit -m "feat: add /tasks list and board page with create modal"
```

---

## Task 9: Task detail page

**Files:**
- Create: `app/(app)/tasks/[id]/page.tsx`

- [ ] **Step 1: Create app/(app)/tasks/[id]/page.tsx**

```tsx
"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardHeader, CardBody } from "@/app/components/ui/Card";
import { Button } from "@/app/components/ui/Button";
import { Input } from "@/app/components/ui/Input";
import { Select } from "@/app/components/ui/Select";
import type { TaskDetail, TaskStatus, TaskPriority } from "@/lib/tasks";

const PRIORITY_COLOR: Record<string, string> = {
  critical: "text-fail",
  high: "text-warn",
  medium: "text-accent",
  low: "text-subtle",
};

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [claimActor, setClaimActor] = useState("");
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editPriority, setEditPriority] = useState<TaskPriority>("medium");
  const [editTags, setEditTags] = useState("");

  const load = useCallback(async () => {
    const res = await fetch(`/api/tasks/${id}`);
    if (!res.ok) { setLoading(false); return; }
    const data = await res.json() as { task: TaskDetail };
    setTask(data.task);
    setEditTitle(data.task.title);
    setEditDescription(data.task.description);
    setEditNotes(data.task.notes);
    setEditPriority(data.task.priority);
    setEditTags(data.task.tags.join(", "));
    setLoading(false);
  }, [id]);

  useEffect(() => { load(); }, [load]);

  async function handleClaim() {
    if (!claimActor.trim()) return;
    setSaving(true);
    await fetch(`/api/tasks/${id}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claimed_by: claimActor }),
    });
    setSaving(false);
    load();
  }

  async function handleRelease() {
    if (!task?.claim) return;
    setSaving(true);
    await fetch(`/api/tasks/${id}/release`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claimed_by: task.claim.claimed_by }),
    });
    setSaving(false);
    load();
  }

  async function handleStatusChange(status: TaskStatus) {
    setSaving(true);
    await fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, actor: "human" }),
    });
    setSaving(false);
    load();
  }

  async function handleSaveEdit() {
    setSaving(true);
    await fetch(`/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: editTitle,
        description: editDescription,
        notes: editNotes,
        priority: editPriority,
        tags: editTags.split(",").map((t) => t.trim()).filter(Boolean),
        actor: "human",
      }),
    });
    setSaving(false);
    setEditing(false);
    load();
  }

  async function handleDelete() {
    if (!confirm("Delete this task?")) return;
    await fetch(`/api/tasks/${id}`, { method: "DELETE" });
    router.push("/tasks");
  }

  if (loading) return <div className="text-subtle text-[13px] p-6">Loading...</div>;
  if (!task) return (
    <div className="text-subtle text-[13px] p-6">
      Task not found. <Link href="/tasks" className="text-accent">Back to tasks</Link>
    </div>
  );

  const claimExpiry = task.claim ? new Date(task.claim.expires_at) : null;
  const claimExpired = claimExpiry ? claimExpiry < new Date() : false;

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center gap-2 text-[12px] text-subtle">
        <Link href="/tasks" className="hover:text-accent transition-colors">Tasks</Link>
        <span>/</span>
        <span className="text-fg truncate">{task.title}</span>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            {editing ? (
              <Input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} className="text-[15px] font-semibold flex-1" />
            ) : (
              <h1 className="text-[15px] font-semibold leading-snug">{task.title}</h1>
            )}
            <div className="flex gap-1 shrink-0">
              {!editing && <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Edit</Button>}
              {editing && <Button size="sm" variant="primary" onClick={handleSaveEdit} disabled={saving}>Save</Button>}
              {editing && <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>}
              <Button size="sm" variant="danger" onClick={handleDelete}>Delete</Button>
            </div>
          </div>
        </CardHeader>
        <CardBody className="space-y-4">
          <div className="flex flex-wrap gap-4">
            <div>
              <div className="text-[10px] uppercase tracking-wide text-subtle mb-1">Priority</div>
              {editing ? (
                <Select value={editPriority} onChange={(e) => setEditPriority(e.target.value as TaskPriority)}>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </Select>
              ) : (
                <span className={`text-[13px] font-medium ${PRIORITY_COLOR[task.priority]}`}>{task.priority}</span>
              )}
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-wide text-subtle mb-1">Status</div>
              <Select value={task.status} onChange={(e) => handleStatusChange(e.target.value as TaskStatus)} disabled={saving}>
                <option value="open">Open</option>
                <option value="in_progress">In Progress</option>
                <option value="done">Done</option>
                <option value="cancelled">Cancelled</option>
              </Select>
            </div>
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wide text-subtle mb-1">Description</div>
            {editing ? (
              <textarea value={editDescription} onChange={(e) => setEditDescription(e.target.value)} className="input w-full h-24 resize-none text-[13px]" />
            ) : (
              <p className="text-[13px] text-muted whitespace-pre-wrap">
                {task.description || <span className="text-subtle italic">No description.</span>}
              </p>
            )}
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wide text-subtle mb-1">Tags</div>
            {editing ? (
              <Input value={editTags} onChange={(e) => setEditTags(e.target.value)} placeholder="comma-separated" />
            ) : (
              <div className="flex gap-1 flex-wrap">
                {task.tags.length > 0
                  ? task.tags.map((tag) => <span key={tag} className="text-[11px] text-subtle bg-bg-subtle rounded px-1.5 py-0.5">{tag}</span>)
                  : <span className="text-[12px] text-subtle italic">None</span>}
              </div>
            )}
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-wide text-subtle mb-1">Notes</div>
            {editing ? (
              <textarea value={editNotes} onChange={(e) => setEditNotes(e.target.value)} className="input w-full h-16 resize-none text-[13px]" placeholder="Latest notes..." />
            ) : (
              <p className="text-[13px] text-muted whitespace-pre-wrap">
                {task.notes || <span className="text-subtle italic">None</span>}
              </p>
            )}
          </div>

          {(task.linked_session_id || task.linked_job_name) && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-subtle mb-1">Linked</div>
              <div className="flex flex-col gap-1 text-[12px]">
                {task.linked_session_id && (
                  <Link href={`/chats/${task.linked_session_id}`} className="text-accent hover:underline">
                    Session: {task.linked_session_id.slice(0, 8)}…
                  </Link>
                )}
                {task.linked_job_name && (
                  <Link href={`/jobs/${task.linked_job_name}`} className="text-accent hover:underline">
                    Job: {task.linked_job_name}
                  </Link>
                )}
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader><h2 className="text-[13px] font-semibold">Claim</h2></CardHeader>
        <CardBody>
          {task.claim && !claimExpired ? (
            <div className="space-y-2">
              <div className="text-[13px]">
                Claimed by <span className="font-medium text-fg">{task.claim.claimed_by}</span>
              </div>
              <div className="text-[11px] text-subtle">Expires {claimExpiry?.toLocaleTimeString()}</div>
              <Button size="sm" variant="ghost" onClick={handleRelease} disabled={saving}>Release</Button>
            </div>
          ) : (
            <div className="flex gap-2 items-center">
              <Input value={claimActor} onChange={(e) => setClaimActor(e.target.value)} placeholder="Your agent ID or name" className="max-w-xs" />
              <Button size="sm" variant="primary" onClick={handleClaim} disabled={saving || !claimActor.trim()}>Claim</Button>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader><h2 className="text-[13px] font-semibold">Activity</h2></CardHeader>
        <CardBody>
          {task.activity.length === 0 ? (
            <p className="text-[12px] text-subtle">No activity yet.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {[...task.activity].reverse().map((a, i) => (
                <li key={i} className="flex gap-2 text-[12px]">
                  <span className="text-subtle shrink-0">{new Date(a.ts).toLocaleTimeString()}</span>
                  <span className="text-muted">
                    <span className="font-medium text-fg">{a.actor}</span>{" "}
                    {a.action.replace("_", " ")}
                    {a.detail ? ` — ${a.detail}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd "/Users/zachrizzo/programming/ai harnnes/dashboard" && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors

- [ ] **Step 3: Test detail page in browser**

Navigate to `http://127.0.0.1:3737/tasks`, click a task. Verify: detail loads, status dropdown updates task, edit mode works and saves, claim section shows correct state, activity log populates after actions.

- [ ] **Step 4: Commit**

```bash
git -C "/Users/zachrizzo/programming/ai harnnes/dashboard" add "app/(app)/tasks/[id]/page.tsx" && git -C "/Users/zachrizzo/programming/ai harnnes/dashboard" commit -m "feat: add task detail page with edit, claim, and activity log"
```

---

## Task 10: Final integration check

- [ ] **Step 1: Full TypeScript check**

```bash
cd "/Users/zachrizzo/programming/ai harnnes/dashboard" && npx tsc --noEmit 2>&1
```

Expected: no errors

- [ ] **Step 2: Verify dashboard TasksWidget**

Navigate to `http://127.0.0.1:3737`. Verify Tasks widget shows status counts and top open tasks.

- [ ] **Step 3: Verify sidebar nav**

Verify sidebar shows Tasks link that navigates to `/tasks`.

- [ ] **Step 4: End-to-end claim race test**

```bash
TASK_ID=$(curl -s http://127.0.0.1:3737/api/tasks | python3 -c "import sys,json; t=json.load(sys.stdin)['tasks']; print(t[0]['id'] if t else '')")
curl -s -X POST http://127.0.0.1:3737/api/tasks/$TASK_ID/claim -H "Content-Type: application/json" -d '{"claimed_by":"agent-A"}' &
curl -s -X POST http://127.0.0.1:3737/api/tasks/$TASK_ID/claim -H "Content-Type: application/json" -d '{"claimed_by":"agent-B"}' &
wait
```

Expected: exactly one `{"ok":true}` and one `{"error":"already claimed",...}`.
