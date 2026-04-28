# Task Ticketing System — Design Spec
**Date:** 2026-04-24
**Status:** Approved

## Overview

An internal task/ticketing system that allows humans and agents to create, claim, update, and complete tasks — all within the existing dashboard. No external integrations (e.g. Jira) unless explicitly triggered. The system prevents two agents from working on the same task simultaneously via atomic file-based claim locking with TTL expiry.

---

## Data Storage

All tasks live under `AUTOMATIONS_ROOT/tasks/{task_id}/`:

```
tasks/
  {task_id}/
    meta.json       ← task definition + current status
    activity.jsonl  ← append-only log of all changes/comments
    claim.lock      ← present only when task is claimed; contains TTL
```

### `meta.json` schema

```json
{
  "id": "string (UUID v4)",
  "title": "string",
  "description": "string",
  "status": "open | in_progress | done | cancelled",
  "priority": "low | medium | high | critical",
  "created_by": "human | agent_id | session_id",
  "created_at": "ISO8601",
  "updated_at": "ISO8601",
  "tags": ["string"],
  "linked_session_id": "string | null",
  "linked_job_name": "string | null",
  "notes": "string"
}
```

### `claim.lock` schema

```json
{
  "claimed_by": "agent_id or session_id",
  "claimed_at": "ISO8601",
  "expires_at": "ISO8601"
}
```

- Written atomically using `O_EXCL` flag (fails if file already exists)
- Default TTL: 15 minutes, renewable via `/api/tasks/[id]/renew`
- Expired locks are treated as unclaimed (any reader can ignore/delete stale locks)

### `activity.jsonl` schema

One JSON object per line, append-only:

```json
{"ts": "ISO8601", "actor": "human | agent_id | session_id", "action": "created | claimed | released | commented | status_changed | updated | completed", "detail": "string"}
```

---

## File System Paths

Add to `lib/paths.ts`:

```ts
tasksDir()                → AUTOMATIONS_ROOT/tasks/
taskDir(id)               → AUTOMATIONS_ROOT/tasks/{id}/
taskMetaPath(id)          → AUTOMATIONS_ROOT/tasks/{id}/meta.json
taskActivityPath(id)      → AUTOMATIONS_ROOT/tasks/{id}/activity.jsonl
taskClaimPath(id)         → AUTOMATIONS_ROOT/tasks/{id}/claim.lock
```

---

## Data Model Types

New file `lib/tasks.ts`:

```ts
export type TaskStatus = 'open' | 'in_progress' | 'done' | 'cancelled'
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical'

export interface Task {
  id: string
  title: string
  description: string
  status: TaskStatus
  priority: TaskPriority
  created_by: string
  created_at: string
  updated_at: string
  tags: string[]
  linked_session_id: string | null
  linked_job_name: string | null
  notes: string
}

export interface TaskClaim {
  claimed_by: string
  claimed_at: string
  expires_at: string
}

export interface TaskActivity {
  ts: string
  actor: string
  action: 'created' | 'claimed' | 'released' | 'commented' | 'status_changed' | 'updated' | 'completed'
  detail: string
}
```

---

## API Routes

All routes under `app/api/tasks/`:

| Method | Route | Description |
|--------|-------|-------------|
| `GET` | `/api/tasks` | List tasks. Query params: `status`, `priority`, `tag`, `limit` |
| `POST` | `/api/tasks` | Create a task. Body: `{ title, description, priority, tags, created_by }` |
| `GET` | `/api/tasks/[id]` | Get task + activity log + current claim |
| `PATCH` | `/api/tasks/[id]` | Update title, description, status, priority, tags, notes, linked ids |
| `DELETE` | `/api/tasks/[id]` | Hard delete task directory |
| `POST` | `/api/tasks/[id]/claim` | Atomically claim task. Body: `{ claimed_by, ttl_minutes? }`. Returns 409 if claimed. |
| `POST` | `/api/tasks/[id]/release` | Delete claim.lock, append activity entry |
| `POST` | `/api/tasks/[id]/renew` | Extend expires_at. Body: `{ claimed_by, ttl_minutes? }`. Returns 403 if mismatch. |

All write operations append to `activity.jsonl` and update `updated_at` in `meta.json`.

---

## Claim Locking Logic

```
CLAIM:
  1. Read claim.lock if it exists
  2. If exists and expires_at > now → return 409 Conflict
  3. If exists and expires_at <= now → delete stale lock (log expiry in activity)
  4. Write claim.lock using fs.open(path, 'wx') — atomic, fails if file exists (race safe)
  5. Set status to in_progress, append activity entry

RELEASE:
  1. Read claim.lock, verify claimed_by matches requester
  2. Delete claim.lock
  3. Set status back to open (unless caller passes explicit new status)
  4. Append activity entry

RENEW:
  1. Read claim.lock, verify claimed_by matches
  2. Overwrite expires_at = now + TTL
  3. Append activity entry
```

---

## Agent Tool Interface

Agents interact with tasks exclusively through API calls — no direct file access. Tools injected into sessions/jobs:

| Tool | Description |
|------|-------------|
| `tasks_list` | List tasks filtered by status/priority/tag |
| `tasks_create` | Create a new task |
| `tasks_get` | Get a task's details and activity |
| `tasks_claim` | Claim a task (returns 409 if taken) |
| `tasks_update` | Update status, notes, linked IDs |
| `tasks_release` | Release a claim |
| `tasks_renew` | Renew a claim's TTL |

Not connected to any external system unless explicitly configured.

---

## UI

### Dashboard Widget

Compact "Tasks" card on the main dashboard:
- Count by status: Open / In Progress / Done
- Top 3 open tasks by priority
- "View all" link to `/tasks`
- Refreshes on existing 10s polling interval

### `/tasks` Page

**List view (default):**
- Filter by status, priority, tag
- Columns: Title, Priority badge, Status, Claimed by, Created, Linked session/job
- Click row → task detail

**Board view (toggle):**
- Three columns: Open | In Progress | Done
- Status change via dropdown (drag-and-drop is v2)

**Task detail:**
- Title, description, priority, tags
- Claim status with expiry countdown if claimed
- Linked session/job with nav link
- Chronological activity log
- Inline editing: title, description, notes, priority, tags
- Actions: Claim / Release / Mark Done / Cancel

**Create task modal:**
- Fields: Title (required), Description, Priority (default: medium), Tags
- `created_by` auto-set to `"human"`

Reuses existing components: `Card`, `Button`, `Badge`, `Input`, `Select`. Dark theme CSS variables throughout.

---

## Error Handling

- `409 Conflict` — claim attempt on an active lock
- `403 Forbidden` — renew/release with mismatched `claimed_by`
- `404` — task directory or meta.json not found
- Expired locks silently cleaned up on next claim attempt

---

## Out of Scope

- External integrations (Jira, Linear, GitHub Issues)
- SSE push for task updates (polling sufficient for now)
- Drag-and-drop kanban
- Task dependencies
- File attachments
- Due dates / reminders
