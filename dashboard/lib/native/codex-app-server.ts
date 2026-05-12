import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

type RequestId = number;

type JsonRpcError = {
  code?: number;
  message?: string;
};

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type AppServerMessage = {
  id?: RequestId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
};

export type CodexNativeModel = {
  id: string;
  model?: string;
  displayName?: string;
  description?: string;
  hidden?: boolean;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: Array<{ reasoningEffort?: string; description?: string }>;
  inputModalities?: string[];
};

export type CodexNativeSkill = {
  name: string;
  description: string;
  shortDescription?: string | null;
  path: string;
  enabled: boolean;
  scope?: string;
};

export type CodexNativeMcpServer = {
  name: string;
  authStatus: string;
  tools?: Record<string, unknown>;
  resources?: unknown[];
  resourceTemplates?: unknown[];
};

export type CodexNativePluginMarketplace = {
  name: string;
  plugins?: Array<{ name?: string; displayName?: string; description?: string; installed?: boolean }>;
};

const DEFAULT_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseModel(value: unknown): CodexNativeModel | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  if (!id) return null;
  return {
    id,
    model: asString(value.model),
    displayName: asString(value.displayName),
    description: asString(value.description),
    hidden: asBoolean(value.hidden),
    isDefault: asBoolean(value.isDefault),
    defaultReasoningEffort: asString(value.defaultReasoningEffort),
    supportedReasoningEfforts: asArray(value.supportedReasoningEfforts)
      .filter(isRecord)
      .map((entry) => ({
        reasoningEffort: asString(entry.reasoningEffort),
        description: asString(entry.description),
      })),
    inputModalities: asArray(value.inputModalities).flatMap((entry) => {
      const text = asString(entry);
      return text ? [text] : [];
    }),
  };
}

function parseSkill(value: unknown): CodexNativeSkill | null {
  if (!isRecord(value)) return null;
  const name = asString(value.name);
  const path = asString(value.path);
  if (!name || !path) return null;
  const interfaceData = isRecord(value.interface) ? value.interface : {};
  return {
    name,
    path,
    description: asString(value.description) ?? asString(interfaceData.shortDescription) ?? "",
    shortDescription: asString(value.shortDescription) ?? asString(interfaceData.shortDescription) ?? null,
    enabled: value.enabled !== false,
    scope: asString(value.scope),
  };
}

function parseMcpServer(value: unknown): CodexNativeMcpServer | null {
  if (!isRecord(value)) return null;
  const name = asString(value.name);
  if (!name) return null;
  return {
    name,
    authStatus: asString(value.authStatus) ?? "unknown",
    tools: isRecord(value.tools) ? value.tools : undefined,
    resources: asArray(value.resources),
    resourceTemplates: asArray(value.resourceTemplates),
  };
}

function parseMarketplace(value: unknown): CodexNativePluginMarketplace | null {
  if (!isRecord(value)) return null;
  const name = asString(value.name);
  if (!name) return null;
  const plugins = asArray(value.plugins)
    .filter(isRecord)
    .map((plugin) => ({
      name: asString(plugin.name),
      displayName: asString(plugin.displayName),
      description: asString(plugin.description),
      installed: asBoolean(plugin.installed),
    }));
  return { name, plugins };
}

export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams;
  private rl: readline.Interface;
  private nextId = 1;
  private pending = new Map<RequestId, PendingRequest>();
  private closed = false;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.rl = readline.createInterface({ input: child.stdout });
    this.rl.on("line", (line) => this.handleLine(line));
    child.on("exit", (code, signal) => {
      this.closed = true;
      const error = new Error(`codex app-server exited (${signal ?? code ?? "unknown"})`);
      for (const [id, waiter] of this.pending) {
        clearTimeout(waiter.timer);
        waiter.reject(error);
        this.pending.delete(id);
      }
    });
  }

  static async start(): Promise<CodexAppServerClient> {
    const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.resume();
    const client = new CodexAppServerClient(child);
    await client.request("initialize", {
      clientInfo: {
        name: "saturn_dashboard",
        title: "Saturn Dashboard",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized", {});
    return client;
  }

  async request<T = unknown>(method: string, params?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    if (this.closed) throw new Error("codex app-server is closed");
    const id = this.nextId;
    this.nextId += 1;
    const message = params === undefined ? { id, method } : { id, method, params };
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    const message = params === undefined ? { method } : { method, params };
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  close(): void {
    this.closed = true;
    this.rl.close();
    this.child.stdin.end();
    this.child.kill();
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: AppServerMessage;
    try {
      message = JSON.parse(line) as AppServerMessage;
    } catch {
      return;
    }

    if (message.id !== undefined && !message.method) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) {
        waiter.reject(new Error(`${waiter.method}: ${message.error.message ?? "request failed"}`));
      } else {
        waiter.resolve(message.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) {
      this.child.stdin.write(`${JSON.stringify({
        id: message.id,
        error: {
          code: -32601,
          message: `Saturn metadata client does not handle ${message.method}`,
        },
      })}\n`);
    }
  }
}

export async function withCodexAppServer<T>(
  fn: (client: CodexAppServerClient) => Promise<T>,
): Promise<T> {
  const client = await CodexAppServerClient.start();
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

export async function listCodexModels(): Promise<CodexNativeModel[]> {
  return withCodexAppServer(async (client) => {
    const models: CodexNativeModel[] = [];
    let cursor: string | null | undefined = null;
    do {
      const result: Record<string, unknown> = await client.request("model/list", {
        cursor,
        limit: 100,
        includeHidden: false,
      });
      models.push(...asArray(result.data).flatMap((item) => {
        const model = parseModel(item);
        return model ? [model] : [];
      }));
      cursor = asString(result.nextCursor) ?? null;
    } while (cursor);
    return models;
  });
}

export async function listCodexSkills(cwd: string, forceReload = false): Promise<CodexNativeSkill[]> {
  return withCodexAppServer(async (client) => {
    const result = await client.request<Record<string, unknown>>("skills/list", {
      cwds: [cwd],
      forceReload,
    });
    return asArray(result.data)
      .filter(isRecord)
      .flatMap((entry) => asArray(entry.skills))
      .flatMap((item) => {
        const skill = parseSkill(item);
        return skill && skill.enabled ? [skill] : [];
      });
  });
}

export async function listCodexMcpServers(): Promise<CodexNativeMcpServer[]> {
  return withCodexAppServer(async (client) => {
    const result = await client.request<Record<string, unknown>>("mcpServerStatus/list", {
      limit: 200,
      detail: "toolsAndAuthOnly",
    });
    return asArray(result.data).flatMap((item) => {
      const server = parseMcpServer(item);
      return server ? [server] : [];
    });
  });
}

export async function listCodexPluginMarketplaces(cwd: string): Promise<CodexNativePluginMarketplace[]> {
  return withCodexAppServer(async (client) => {
    const result = await client.request<Record<string, unknown>>("plugin/list", {
      cwds: [cwd],
      marketplaceKinds: ["local", "workspace-directory", "shared-with-me"],
    }, 20_000);
    return asArray(result.marketplaces).flatMap((item) => {
      const marketplace = parseMarketplace(item);
      return marketplace ? [marketplace] : [];
    });
  });
}
