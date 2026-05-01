import { NextRequest, NextResponse } from "next/server";
import { getTask, updateTask, type TaskPriority, type TaskStatus } from "@/lib/tasks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TASK_STATUSES = ["open", "in_progress", "done", "cancelled"] as const satisfies readonly TaskStatus[];
const TASK_PRIORITIES = ["low", "medium", "high", "critical"] as const satisfies readonly TaskPriority[];

function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && TASK_STATUSES.includes(value as TaskStatus);
}

function isTaskPriority(value: unknown): value is TaskPriority {
  return typeof value === "string" && TASK_PRIORITIES.includes(value as TaskPriority);
}

function parseTags(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value
      .filter((tag): tag is string => typeof tag === "string")
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((tag) => tag.trim()).filter(Boolean);
  }
  return undefined;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = await getTask(id);
  if (!task) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ task });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const patch: Parameters<typeof updateTask>[1] = {};

  if (body.title !== undefined) {
    if (typeof body.title !== "string" || !body.title.trim()) {
      return NextResponse.json({ error: "title must be a non-empty string" }, { status: 400 });
    }
    patch.title = body.title.trim();
  }
  if (body.description !== undefined) {
    if (typeof body.description !== "string") {
      return NextResponse.json({ error: "description must be a string" }, { status: 400 });
    }
    patch.description = body.description.trim();
  }
  if (body.status !== undefined) {
    if (!isTaskStatus(body.status)) {
      return NextResponse.json({ error: "invalid status" }, { status: 400 });
    }
    patch.status = body.status;
  }
  if (body.priority !== undefined) {
    if (!isTaskPriority(body.priority)) {
      return NextResponse.json({ error: "invalid priority" }, { status: 400 });
    }
    patch.priority = body.priority;
  }
  if (body.tags !== undefined) {
    const tags = parseTags(body.tags);
    if (!tags) return NextResponse.json({ error: "tags must be an array or comma-separated string" }, { status: 400 });
    patch.tags = tags;
  }
  if (body.notes !== undefined) {
    if (typeof body.notes !== "string") {
      return NextResponse.json({ error: "notes must be a string" }, { status: 400 });
    }
    patch.notes = body.notes;
  }
  if (body.linked_session_id !== undefined) {
    patch.linked_session_id = typeof body.linked_session_id === "string" && body.linked_session_id.trim()
      ? body.linked_session_id.trim()
      : null;
  }
  if (body.linked_job_name !== undefined) {
    patch.linked_job_name = typeof body.linked_job_name === "string" && body.linked_job_name.trim()
      ? body.linked_job_name.trim()
      : null;
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "no valid task fields provided" }, { status: 400 });
  }

  const actor = typeof body.actor === "string" && body.actor.trim() ? body.actor.trim() : "saturn-cli";

  try {
    const task = await updateTask(id, patch, actor);
    return NextResponse.json({ task });
  } catch (err) {
    const message = err instanceof Error ? err.message : "failed";
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
