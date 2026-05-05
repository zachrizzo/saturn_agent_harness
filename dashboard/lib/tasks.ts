import { promises as fs, constants } from "node:fs";
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
  action: "created" | "claimed" | "released" | "commented" | "status_changed" | "updated" | "completed";
  detail: string;
}

export interface TaskDetail extends Task {
  claim: TaskClaim | null;
  activity: TaskActivity[];
}

function isENOENT(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === "ENOENT";
}

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
    if (isENOENT(err)) return null;
    throw err;
  }
}

export async function appendActivity(id: string, entry: TaskActivity): Promise<void> {
  await fs.appendFile(taskActivityPath(id), JSON.stringify(entry) + "\n", "utf8");
}

async function readActivity(id: string): Promise<TaskActivity[]> {
  try {
    const raw = await fs.readFile(taskActivityPath(id), "utf8");
    return raw.split("\n").filter(Boolean).map((line) => JSON.parse(line) as TaskActivity);
  } catch {
    return [];
  }
}

export async function listTasks(opts?: {
  status?: TaskStatus;
  priority?: TaskPriority;
  tag?: string;
  linked_session_id?: string;
  limit?: number;
}): Promise<Task[]> {
  let ids: string[];
  try {
    const entries = await fs.readdir(tasksDir(), { withFileTypes: true });
    ids = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err: unknown) {
    if (isENOENT(err)) return [];
    throw err;
  }

  const settled = await Promise.allSettled(ids.map((id) => readMeta(id)));
  const tasks: Task[] = settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));

  let filtered = tasks;
  if (opts?.status) filtered = filtered.filter((t) => t.status === opts.status);
  if (opts?.priority) filtered = filtered.filter((t) => t.priority === opts.priority);
  if (opts?.tag) filtered = filtered.filter((t) => t.tags.includes(opts.tag!));
  if (opts?.linked_session_id) filtered = filtered.filter((t) => t.linked_session_id === opts.linked_session_id);

  filtered.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  if (opts?.limit) filtered = filtered.slice(0, opts.limit);
  return filtered;
}

export async function getTask(id: string): Promise<TaskDetail | null> {
  try {
    const [task, claim, activity] = await Promise.all([readMeta(id), readClaim(id), readActivity(id)]);
    return { ...task, claim, activity };
  } catch (err: unknown) {
    if (isENOENT(err)) return null;
    throw err;
  }
}

export async function createTask(input: {
  title: string;
  description?: string;
  priority?: TaskPriority;
  tags?: string[];
  created_by: string;
  linked_session_id?: string | null;
  linked_job_name?: string | null;
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
    linked_session_id: input.linked_session_id ?? null,
    linked_job_name: input.linked_job_name ?? null,
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
  if (Object.keys(patch).length === 0) return task;

  const now = new Date().toISOString();
  const updated: Task = { ...task, ...patch, updated_at: now };
  await writeMeta(updated);

  if (patch.status && patch.status !== task.status) {
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
export const MAX_TASK_TTL_MINUTES = 24 * 60;

function normalizedTtlMinutes(ttlMinutes: number): number {
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > MAX_TASK_TTL_MINUTES) {
    throw new Error(`ttl_minutes must be an integer from 1 to ${MAX_TASK_TTL_MINUTES}`);
  }
  return ttlMinutes;
}

export async function claimTask(
  id: string,
  claimedBy: string,
  ttlMinutes = DEFAULT_TTL_MINUTES
): Promise<{ ok: true } | { ok: false; conflict: true; claimed_by: string; expires_at: string }> {
  const ttl = normalizedTtlMinutes(ttlMinutes);
  await readMeta(id);

  const now = new Date();
  const existing = await readClaim(id);

  if (existing) {
    if (new Date(existing.expires_at) > now) {
      return { ok: false, conflict: true, claimed_by: existing.claimed_by, expires_at: existing.expires_at };
    }
    await fs.unlink(taskClaimPath(id)).catch(() => {});
    await appendActivity(id, { ts: now.toISOString(), actor: "system", action: "released", detail: "stale lock expired" });
  }

  const expiresAt = new Date(now.getTime() + ttl * 60 * 1000).toISOString();
  const claimData: TaskClaim = { claimed_by: claimedBy, claimed_at: now.toISOString(), expires_at: expiresAt };

  try {
    const fd = await fs.open(taskClaimPath(id), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL);
    await fd.writeFile(JSON.stringify(claimData, null, 2), "utf8");
    await fd.close();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
    const fresh = await readClaim(id);
    return { ok: false, conflict: true, claimed_by: fresh?.claimed_by ?? "unknown", expires_at: fresh?.expires_at ?? "" };
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
  await readMeta(id);

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
  const ttl = normalizedTtlMinutes(ttlMinutes);
  await readMeta(id);

  const claim = await readClaim(id);
  if (!claim || claim.claimed_by !== claimedBy) return { ok: false, forbidden: true };

  const expiresAt = new Date(Date.now() + ttl * 60 * 1000).toISOString();
  const updated: TaskClaim = { ...claim, expires_at: expiresAt };
  await fs.writeFile(taskClaimPath(id), JSON.stringify(updated, null, 2), "utf8");
  await appendActivity(id, { ts: new Date().toISOString(), actor: claimedBy, action: "updated", detail: `renewed until ${expiresAt}` });
  return { ok: true, expires_at: expiresAt };
}
