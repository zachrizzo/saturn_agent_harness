import { NextRequest, NextResponse } from "next/server";
import { createTask, listTasks, type TaskPriority, type TaskStatus } from "@/lib/tasks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TASK_STATUSES = ["open", "in_progress", "done", "cancelled"] as const satisfies readonly TaskStatus[];
const TASK_PRIORITIES = ["low", "medium", "high", "critical"] as const satisfies readonly TaskPriority[];

function isTaskStatus(value: string): value is TaskStatus {
  return TASK_STATUSES.includes(value as TaskStatus);
}

function isTaskPriority(value: string): value is TaskPriority {
  return TASK_PRIORITIES.includes(value as TaskPriority);
}

function parseTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((tag): tag is string => typeof tag === "string")
      .map((tag) => tag.trim())
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((tag) => tag.trim()).filter(Boolean);
  }
  return [];
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const statusParam = searchParams.get("status");
  const priorityParam = searchParams.get("priority");
  const limitParam = searchParams.get("limit");

  if (statusParam && !isTaskStatus(statusParam)) {
    return NextResponse.json({ error: "invalid status" }, { status: 400 });
  }
  if (priorityParam && !isTaskPriority(priorityParam)) {
    return NextResponse.json({ error: "invalid priority" }, { status: 400 });
  }
  const status = statusParam ? statusParam as TaskStatus : undefined;
  const priority = priorityParam ? priorityParam as TaskPriority : undefined;

  let limit: number | undefined;
  if (limitParam) {
    limit = Number(limitParam);
    if (!Number.isInteger(limit) || limit < 1) {
      return NextResponse.json({ error: "limit must be a positive integer" }, { status: 400 });
    }
  }

  const tasks = await listTasks({
    status,
    priority,
    tag: searchParams.get("tag") ?? undefined,
    linked_session_id: searchParams.get("linked_session_id") ?? undefined,
    limit,
  });

  return NextResponse.json({ tasks });
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  const priority = typeof body.priority === "string" && isTaskPriority(body.priority)
    ? body.priority
    : undefined;
  if (body.priority && !priority) {
    return NextResponse.json({ error: "invalid priority" }, { status: 400 });
  }

  const task = await createTask({
    title,
    description: typeof body.description === "string" ? body.description.trim() : undefined,
    priority,
    tags: parseTags(body.tags),
    created_by: typeof body.created_by === "string" && body.created_by.trim() ? body.created_by.trim() : "human",
    linked_session_id:
      typeof body.linked_session_id === "string" && body.linked_session_id.trim()
        ? body.linked_session_id.trim()
        : null,
    linked_job_name:
      typeof body.linked_job_name === "string" && body.linked_job_name.trim()
        ? body.linked_job_name.trim()
        : null,
  });

  return NextResponse.json({ task }, { status: 201 });
}
