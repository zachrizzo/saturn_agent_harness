#!/usr/bin/env node
import { spawn } from "node:child_process";
import readline from "node:readline";

function parseArgs(argv) {
  const out = { mode: "default" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--mode") out.mode = argv[++i] ?? "default";
    else if (arg === "--thread-id") out.threadId = argv[++i];
    else if (arg === "--model") out.model = argv[++i];
    else if (arg === "--effort") out.effort = argv[++i];
    else if (arg === "--cwd") out.cwd = argv[++i];
  }
  out.mode = out.mode === "plan" ? "plan" : "default";
  return out;
}

function normalizeEffort(value) {
  if (!value) return undefined;
  if (value === "max") return "xhigh";
  if (value === "minimal") return "low";
  return value;
}

function withoutUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));
}

function readStdin() {
  return new Promise((resolve) => {
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      body += chunk;
    });
    process.stdin.on("end", () => resolve(body));
  });
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function normalizeItem(item) {
  if (!item || typeof item !== "object") return item;
  const typeMap = {
    agentMessage: "agent_message",
    commandExecution: "command_execution",
    fileChange: "file_change",
    mcpToolCall: "mcp_tool_call",
    collabAgentToolCall: "collab_tool_call",
  };
  const type = typeMap[item.type] ?? item.type;
  const normalized = { ...item, type };

  if (item.aggregatedOutput !== undefined) normalized.aggregated_output = item.aggregatedOutput;
  if (item.exitCode !== undefined) normalized.exit_code = item.exitCode;
  if (item.commandActions !== undefined) normalized.command_actions = item.commandActions;
  if (item.receiverThreadIds !== undefined) normalized.receiver_thread_ids = item.receiverThreadIds;
  if (item.agentsStates !== undefined) normalized.agents_states = item.agentsStates;

  return normalized;
}

function answerUserInputRequest(questions) {
  const answers = {};
  for (const question of Array.isArray(questions) ? questions : []) {
    const id = typeof question.id === "string" ? question.id : "";
    if (!id) continue;
    const firstOption = Array.isArray(question.options) ? question.options[0] : undefined;
    const answer = firstOption?.label ?? "Proceed with the safest reasonable default.";
    answers[id] = { answers: [answer] };
  }
  return { answers };
}

function serverError(id, message) {
  return {
    id,
    error: {
      code: -32601,
      message,
    },
  };
}

const args = parseArgs(process.argv.slice(2));
const prompt = await readStdin();
const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
  stdio: ["pipe", "pipe", "pipe"],
});

child.stderr.pipe(process.stderr);

let nextId = 1;
const pending = new Map();
let threadStartedEmitted = false;
let turnCompleted;
const turnDone = new Promise((resolve) => {
  turnCompleted = resolve;
});
let turnStatus = "running";
let sawAgentMessageDelta = false;

function sendRaw(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params) {
  const id = nextId;
  nextId += 1;
  sendRaw({ id, method, params });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
  });
}

function notify(method, params) {
  sendRaw({ method, params });
}

function emitThreadStarted(thread) {
  const threadId = thread?.id ?? args.threadId;
  if (!threadId || threadStartedEmitted) return;
  threadStartedEmitted = true;
  emit({ type: "thread.started", thread_id: threadId });
}

function handleServerRequest(message) {
  if (message.method === "item/tool/requestUserInput") {
    sendRaw({ id: message.id, result: answerUserInputRequest(message.params?.questions) });
    return;
  }

  if (message.method === "item/commandExecution/requestApproval") {
    sendRaw({ id: message.id, result: { decision: "decline" } });
    return;
  }

  if (message.method === "item/fileChange/requestApproval") {
    sendRaw({ id: message.id, result: { decision: "decline" } });
    return;
  }

  if (message.method === "item/permissions/requestApproval") {
    sendRaw({ id: message.id, result: { permissions: {}, scope: "turn" } });
    return;
  }

  sendRaw(serverError(message.id, `Unhandled app-server request: ${message.method}`));
}

function handleNotification(message) {
  const { method, params = {} } = message;
  if (method === "thread/started") {
    emitThreadStarted(params.thread);
    return;
  }

  if (method === "turn/started") {
    emit({ type: "turn.started" });
    return;
  }

  if (method === "item/agentMessage/delta") {
    const text = String(params.delta ?? "");
    if (text) {
      sawAgentMessageDelta = true;
      emit({ type: "text", part: { text } });
    }
    return;
  }

  if (method === "item/plan/delta") {
    const text = String(params.delta ?? "");
    if (text) emit({ type: "plan.delta", item_id: params.itemId ?? params.item_id, text, delta: text });
    return;
  }

  if (method === "turn/plan/updated") {
    const items = (Array.isArray(params.plan) ? params.plan : [])
      .map((step) => ({
        text: String(step.step ?? "").trim(),
        completed: step.status === "completed",
      }))
      .filter((step) => step.text.length > 0);
    if (items.length > 0) {
      emit({ type: "item.updated", item: { id: "plan", type: "todo_list", items } });
    }
    return;
  }

  if (method === "item/started" || method === "item/completed") {
    const item = normalizeItem(params.item);
    if (method === "item/completed" && item?.type === "agent_message" && sawAgentMessageDelta) {
      item.saturn_final_only = true;
    }
    emit({
      type: method === "item/started" ? "item.started" : "item.completed",
      item,
    });
    return;
  }

  if (method === "turn/completed") {
    turnStatus = params.turn?.status ?? "completed";
    emit({ type: "turn.completed", usage: params.turn?.usage ?? params.usage });
    turnCompleted();
  }
}

const rl = readline.createInterface({ input: child.stdout });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.id !== undefined && !message.method) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) {
      waiter.reject(new Error(`${waiter.method}: ${message.error.message ?? "request failed"}`));
    } else {
      waiter.resolve(message.result);
    }
    return;
  }

  if (message.id !== undefined && message.method) {
    handleServerRequest(message);
    return;
  }

  if (message.method) handleNotification(message);
});

const childExited = new Promise((_, reject) => {
  child.on("exit", (code, signal) => {
    if (turnStatus === "completed") return;
    reject(new Error(`codex app-server exited before turn completed (${signal ?? code})`));
  });
});

try {
  await request("initialize", {
    clientInfo: {
      name: "saturn_dashboard",
      title: "Saturn Dashboard",
      version: "0.1.0",
    },
    capabilities: { experimentalApi: true },
  });
  notify("initialized", {});

  const commonThreadParams = withoutUndefined({
    model: args.model,
    cwd: args.cwd,
    approvalPolicy: "never",
    persistExtendedHistory: true,
  });
  const threadResponse = args.threadId
    ? await request("thread/resume", {
        ...commonThreadParams,
        threadId: args.threadId,
        excludeTurns: true,
      })
    : await request("thread/start", commonThreadParams);

  const thread = threadResponse?.thread ?? { id: args.threadId };
  emitThreadStarted(thread);

  const model = args.model ?? threadResponse?.model;
  if (!model) {
    throw new Error("codex app-server did not return a model for collaboration mode");
  }
  const effort = normalizeEffort(args.effort) ?? threadResponse?.reasoningEffort ?? (args.mode === "plan" ? "medium" : null);
  const sandboxPolicy = args.mode === "plan"
    ? { type: "readOnly", networkAccess: true }
    : { type: "dangerFullAccess" };

  await request("turn/start", withoutUndefined({
    threadId: thread.id,
    input: [{ type: "text", text: prompt }],
    approvalPolicy: "never",
    sandboxPolicy,
    collaborationMode: {
      mode: args.mode,
      settings: {
        model,
        reasoning_effort: effort,
        developer_instructions: null,
      },
    },
  }));

  await Promise.race([turnDone, childExited]);
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
} finally {
  rl.close();
  child.stdin.end();
  child.kill();
}

if (turnStatus !== "completed") {
  process.exitCode = 1;
}
