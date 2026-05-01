import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { toEvents } from "./events";
import { getSession, sessionDir } from "./runs";
import { createTask, listTasks, updateTask, type Task } from "./tasks";

type TodoItem = {
  text: string;
  completed: boolean;
};

type SyncResult = {
  created: number;
  updated: number;
  unchanged: number;
};

function todoKey(text: string): string {
  return createHash("sha1").update(text.trim().toLowerCase()).digest("hex").slice(0, 12);
}

function syncTag(key: string): string {
  return `agent-todo:${key}`;
}

function uniqueTodos(items: TodoItem[]): TodoItem[] {
  const byKey = new Map<string, TodoItem>();
  for (const item of items) {
    const text = item.text.trim();
    if (!text) continue;
    byKey.set(todoKey(text), { text, completed: item.completed });
  }
  return [...byKey.values()];
}

async function latestTodoListForTurn(sessionId: string, turnId?: string): Promise<TodoItem[]> {
  const streamPath = path.join(sessionDir(sessionId), "stream.jsonl");
  const raw = await fs.readFile(streamPath, "utf8").catch(() => "");
  const items: TodoItem[][] = [];
  let inTurn = !turnId;

  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (obj.type === "saturn.turn_start") {
      if (turnId && inTurn) break;
      inTurn = !turnId || obj.turn_id === turnId;
      continue;
    }

    if (!inTurn) continue;

    for (const event of toEvents(obj)) {
      if (event.kind === "todo_list") items.push(event.items);
    }
  }

  return uniqueTodos(items.at(-1) ?? []);
}

function findSyncedTask(tasks: Task[], tag: string): Task | undefined {
  return tasks.find((task) => task.tags.includes(tag));
}

function notFoundError(message: string): Error & NodeJS.ErrnoException {
  const err = new Error(message) as Error & NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

export async function syncTodoListTasks(sessionId: string, turnId?: string): Promise<SyncResult> {
  const session = await getSession(sessionId);
  if (!session) throw notFoundError(`session not found: ${sessionId}`);

  const todos = await latestTodoListForTurn(sessionId, turnId);
  if (todos.length === 0) return { created: 0, updated: 0, unchanged: 0 };

  const actor = session.meta.agent_id ?? session.meta.agent_snapshot?.id ?? sessionId;
  const existing = await listTasks({ linked_session_id: sessionId });
  const result: SyncResult = { created: 0, updated: 0, unchanged: 0 };

  for (const todo of todos) {
    const key = todoKey(todo.text);
    const tag = syncTag(key);
    const status = todo.completed ? "done" : "open";
    const current = findSyncedTask(existing, tag);

    if (!current) {
      const task = await createTask({
        title: todo.text,
        description: "Auto-captured from an agent todo list.",
        priority: "medium",
        tags: ["agent-todo", tag],
        created_by: actor,
        linked_session_id: sessionId,
      });
      existing.push(task);
      result.created += 1;
      if (task.status !== status) {
        await updateTask(task.id, { status }, actor);
        result.updated += 1;
      }
      continue;
    }

    const patch: Parameters<typeof updateTask>[1] = {};
    if (current.title !== todo.text) patch.title = todo.text;
    if (todo.completed && current.status !== "done") patch.status = "done";
    if (!todo.completed && current.status === "done") patch.status = "open";

    if (Object.keys(patch).length > 0) {
      await updateTask(current.id, patch, actor);
      result.updated += 1;
    } else {
      result.unchanged += 1;
    }
  }

  return result;
}
