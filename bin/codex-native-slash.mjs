#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

function parseArgs(argv) {
  const out = { args: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--thread-id") out.threadId = argv[++i] || "";
    else if (arg === "--cwd") out.cwd = argv[++i] || process.cwd();
    else if (arg === "--meta") out.meta = argv[++i] || "";
    else out.args.push(arg);
  }
  out.command = (out.args.shift() || "").replace(/^\//, "");
  out.rest = out.args.join(" ").trim();
  out.cwd ||= process.cwd();
  return out;
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function table(headers, rows) {
  if (!rows.length) return "_None._";
  const data = [headers, ...rows].map((row) => row.map((cell) => String(cell ?? "")));
  const widths = headers.map((_, index) => Math.max(...data.map((row) => row[index].length)));
  const line = (row) => `| ${row.map((cell, index) => cell.padEnd(widths[index])).join(" | ")} |`;
  return [
    line(data[0]),
    `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`,
    ...data.slice(1).map(line),
  ].join("\n");
}

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  return {
    code: result.status ?? 1,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
  };
}

class CodexAppServer {
  constructor() {
    this.child = spawn("codex", ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stderr.resume();
    this.rl = readline.createInterface({ input: this.child.stdout });
    this.nextId = 1;
    this.pending = new Map();
    this.rl.on("line", (line) => this.handleLine(line));
    this.child.on("exit", (code, signal) => {
      const error = new Error(`codex app-server exited (${signal ?? code ?? "unknown"})`);
      for (const [id, waiter] of this.pending) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
        this.pending.delete(id);
      }
    });
  }

  async init() {
    await this.request("initialize", {
      clientInfo: { name: "saturn_dashboard", title: "Saturn Dashboard", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
  }

  request(method, params = undefined, timeoutMs = 20000) {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify(params === undefined ? { id, method } : { id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
    });
  }

  notify(method, params = undefined) {
    this.child.stdin.write(`${JSON.stringify(params === undefined ? { method } : { method, params })}\n`);
  }

  handleLine(line) {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id !== undefined && !message.method) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message || "failed"}`));
      else waiter.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      this.child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: "not handled" } })}\n`);
    }
  }

  close() {
    this.rl.close();
    this.child.stdin.end();
    this.child.kill();
  }
}

async function withServer(fn) {
  const server = new CodexAppServer();
  try {
    await server.init();
    return await fn(server);
  } finally {
    server.close();
  }
}

async function listModels() {
  return withServer(async (server) => {
    const result = await server.request("model/list", { limit: 100, includeHidden: false });
    const rows = (result.data || [])
      .filter((model) => !model.hidden)
      .map((model) => [
        model.isDefault ? `${model.id} *` : model.id,
        model.displayName || model.model || model.id,
        (model.supportedReasoningEfforts || []).map((effort) => effort.reasoningEffort).filter(Boolean).join(", "),
      ]);
    return `## Native Codex Models\n\n${table(["Model", "Name", "Effort"], rows)}`;
  });
}

async function listMcp() {
  return withServer(async (server) => {
    const result = await server.request("mcpServerStatus/list", { limit: 200, detail: "toolsAndAuthOnly" });
    const rows = (result.data || []).map((item) => [
      item.name,
      item.authStatus || "unknown",
      item.tools && typeof item.tools === "object" ? Object.keys(item.tools).length : 0,
    ]);
    return `## Native Codex MCP Servers\n\n${table(["Server", "Auth", "Tools"], rows)}`;
  });
}

async function listApps() {
  return withServer(async (server) => {
    const result = await server.request("app/list", { limit: 200, forceRefetch: false });
    const rows = (result.data || []).map((item) => [
      item.name || item.id || "(unknown)",
      item.displayName || item.title || "",
      item.status || item.authStatus || "",
    ]);
    return `## Native Codex Apps\n\n${table(["App", "Name", "Status"], rows)}`;
  });
}

async function listPlugins(cwd) {
  return withServer(async (server) => {
    const result = await server.request("plugin/list", {
      cwds: [cwd],
      marketplaceKinds: ["local", "workspace-directory", "shared-with-me"],
    }, 30000);
    const rows = [];
    for (const marketplace of result.marketplaces || []) {
      for (const plugin of marketplace.plugins || []) {
        rows.push([
          plugin.name || "(unknown)",
          marketplace.name,
          plugin.installed ? "installed" : "",
          plugin.description || plugin.displayName || "",
        ]);
      }
    }
    return `## Native Codex Plugins\n\n${table(["Plugin", "Marketplace", "State", "Description"], rows.slice(0, 80))}`;
  });
}

async function listExperimental(rest) {
  return withServer(async (server) => {
    const [verb, feature] = rest.split(/\s+/).filter(Boolean);
    if ((verb === "enable" || verb === "disable") && feature) {
      await server.request("experimentalFeature/enablement/set", { enablement: { [feature]: verb === "enable" } });
    }
    const result = await server.request("experimentalFeature/list", { limit: 200 });
    const rows = (result.data || []).map((item) => [
      item.name,
      item.enabled ? "on" : "off",
      item.stage,
      item.description || item.displayName || "",
    ]);
    const prefix = (verb === "enable" || verb === "disable") && feature
      ? `Updated \`${feature}\` to ${verb === "enable" ? "enabled" : "disabled"}.\n\n`
      : "";
    return `${prefix}## Native Codex Experimental Features\n\n${table(["Feature", "Enabled", "Stage", "Description"], rows)}`;
  });
}

async function goal(args) {
  if (!args.threadId) return "No native Codex thread exists yet. Send one normal Codex message first, then use `/goal`.";
  return withServer(async (server) => {
    await server.request("thread/resume", {
      threadId: args.threadId,
      cwd: args.cwd,
      excludeTurns: true,
      persistExtendedHistory: true,
    });
    const rest = args.rest.trim();
    if (!rest) {
      const result = await server.request("thread/goal/get", { threadId: args.threadId });
      if (!result.goal) return "No native Codex goal is set.";
      return `## Native Codex Goal\n\nStatus: \`${result.goal.status || "active"}\`\n\n${result.goal.objective || ""}`;
    }
    if (rest === "clear" || rest === "reset") {
      await server.request("thread/goal/clear", { threadId: args.threadId });
      return "Native Codex goal cleared.";
    }
    if (["pause", "paused"].includes(rest)) {
      const result = await server.request("thread/goal/set", { threadId: args.threadId, status: "paused" });
      return `Native Codex goal paused: ${result.goal?.objective || ""}`;
    }
    if (["resume", "active"].includes(rest)) {
      const result = await server.request("thread/goal/set", { threadId: args.threadId, status: "active" });
      return `Native Codex goal resumed: ${result.goal?.objective || ""}`;
    }
    const result = await server.request("thread/goal/set", { threadId: args.threadId, objective: rest, status: "active" });
    return `Native Codex goal set:\n\n${result.goal?.objective || rest}`;
  });
}

async function status(args) {
  return withServer(async (server) => {
    const config = await server.request("config/read", { includeLayers: false, cwd: args.cwd }).catch(() => null);
    const models = await server.request("model/list", { limit: 20, includeHidden: false }).catch(() => ({ data: [] }));
    const current = (models.data || []).find((m) => m.isDefault) || (models.data || [])[0];
    const mcp = await server.request("mcpServerStatus/list", { limit: 200, detail: "toolsAndAuthOnly" }).catch(() => ({ data: [] }));
    const lines = [
      "## Native Codex Status",
      "",
      `Thread: ${args.threadId ? `\`${args.threadId}\`` : "_none yet_"}`,
      `Working directory: \`${args.cwd}\``,
      `Default model: \`${current?.id || config?.config?.model || "unknown"}\``,
      `MCP servers: ${(mcp.data || []).length}`,
    ];
    return lines.join("\n");
  });
}

async function debugConfig(args) {
  return withServer(async (server) => {
    const [config, requirements] = await Promise.all([
      server.request("config/read", { includeLayers: true, cwd: args.cwd }).catch((error) => ({ error: error.message })),
      server.request("configRequirements/read").catch((error) => ({ error: error.message })),
    ]);
    return `## Native Codex Config\n\n\`\`\`json\n${JSON.stringify({ config, requirements }, null, 2)}\n\`\`\``;
  });
}

async function listThreads(args) {
  return withServer(async (server) => {
    const result = await server.request("thread/list", {
      limit: 20,
      sortKey: "updatedAt",
      sortDirection: "descending",
      cwd: args.cwd,
      archived: false,
      modelProviders: [],
      sourceKinds: [],
    });
    const rows = (result.data || []).map((thread) => [
      thread.id,
      thread.name || thread.preview || "",
      new Date((thread.updatedAt || thread.createdAt || 0) * 1000).toISOString(),
    ]);
    return `## Native Codex Sessions\n\n${table(["Thread", "Title", "Updated"], rows)}`;
  });
}

async function forkThread(args) {
  if (!args.threadId) return "No native Codex thread exists yet. Send one normal Codex message first, then use `/fork`.";
  return withServer(async (server) => {
    const result = await server.request("thread/fork", {
      threadId: args.threadId,
      cwd: args.cwd,
      excludeTurns: true,
      persistExtendedHistory: true,
    });
    return `Forked native Codex thread:\n\n\`${result.thread?.id || "(unknown)"}\`\n\nUse the Sessions UI to open or resume it.`;
  });
}

async function compact(args) {
  if (!args.threadId) return "No native Codex thread exists yet. Send one normal Codex message first, then use `/compact`.";
  return withServer(async (server) => {
    await server.request("thread/resume", {
      threadId: args.threadId,
      cwd: args.cwd,
      excludeTurns: true,
      persistExtendedHistory: true,
    });
    await server.request("thread/compact/start", { threadId: args.threadId }, 60000);
    return "Native Codex conversation compacted.";
  });
}

async function review(args) {
  if (!args.threadId) return "No native Codex thread exists yet. Send one normal Codex message first, then use `/review`.";
  return withServer(async (server) => {
    await server.request("thread/resume", {
      threadId: args.threadId,
      cwd: args.cwd,
      excludeTurns: true,
      persistExtendedHistory: true,
    });
    const target = args.rest ? { type: "custom", instructions: args.rest } : { type: "uncommittedChanges" };
    const result = await server.request("review/start", { threadId: args.threadId, target, delivery: "inline" }, 180000);
    const text = (result.turn?.items || [])
      .filter((item) => item.type === "agentMessage" || item.type === "agent_message")
      .map((item) => item.text)
      .filter(Boolean)
      .join("\n\n");
    return text || `Native Codex review started on thread \`${result.reviewThreadId || args.threadId}\`.`;
  });
}

function latestOutput(args) {
  try {
    const meta = JSON.parse(fs.readFileSync(args.meta, "utf8"));
    const latest = [...(meta.turns || [])].reverse().find((turn) => turn.final_text && turn.user_message !== `/${args.command}`);
    return latest?.final_text || "No previous assistant output found in this Saturn chat.";
  } catch {
    return "No previous assistant output found in this Saturn chat.";
  }
}

function initInstructions(args) {
  const file = path.join(args.cwd, "AGENTS.md");
  if (fs.existsSync(file)) {
    return `\`AGENTS.md\` already exists at \`${file}\`.`;
  }
  const content = `# Agent Instructions\n\n## Project\n\nAdd project-specific architecture, test, style, and workflow notes here.\n\n## Commands\n\n- Build: \n- Test: \n- Lint: \n\n## Notes\n\n- Keep changes focused and verify them before finishing.\n`;
  fs.writeFileSync(file, content, { flag: "wx" });
  return `Created native agent instruction file:\n\n\`${file}\``;
}

async function logout() {
  return withServer(async (server) => {
    await server.request("account/logout");
    return "Signed out of native Codex auth.";
  });
}

function settingsOnly(command) {
  return `/${command} is available in the native Codex CLI as an interactive UI command. Saturn now lists it so the slash surface matches Codex, but this specific command needs a dedicated Saturn control before it can safely mutate UI state from chat.`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "model": return listModels();
    case "mcp": return listMcp();
    case "apps": return listApps();
    case "plugins": return listPlugins(args.cwd);
    case "experimental": return listExperimental(args.rest);
    case "goal": return goal(args);
    case "status": return status(args);
    case "debug-config": return debugConfig(args);
    case "resume": return listThreads(args);
    case "fork": return forkThread(args);
    case "compact": return compact(args);
    case "review": return review(args);
    case "diff": {
      const status = run("git", ["status", "--short", "--branch"], args.cwd);
      const unstaged = run("git", ["diff", "--"], args.cwd);
      const staged = run("git", ["diff", "--cached", "--"], args.cwd);
      return `## Native Workspace Diff\n\n\`\`\`text\n${status.output || "(clean)"}\n\`\`\`\n\n### Unstaged\n\n\`\`\`diff\n${unstaged.output || "(none)"}\n\`\`\`\n\n### Staged\n\n\`\`\`diff\n${staged.output || "(none)"}\n\`\`\``;
    }
    case "copy": return latestOutput(args);
    case "init": return initInstructions(args);
    case "logout": return logout();
    case "clear":
    case "new":
    case "exit":
    case "quit":
      return "Started a fresh native Codex context for the next Saturn chat turn.";
    case "permissions":
    case "approvals":
      return "Native Codex permissions are currently governed by Saturn's app-server turn policy. The slash command is listed; approval dialogs are the next bridge piece.";
    case "stop":
    case "clean":
    case "ps":
      return "Saturn manages background terminals through its existing session controls. Native Codex background-terminal controls are listed here and will be wired to the session UI controls next.";
    default:
      return settingsOnly(args.command);
  }
}

main()
  .then((text) => {
    process.stdout.write(`${text}\n`);
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
