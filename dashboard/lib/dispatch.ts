import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { automationsRoot, runsRoot } from "./paths";
import { qrSvgDataUri } from "./qr";
import { listSessions, type SessionMeta } from "./runs";
import {
  cleanTelegramBotUsername,
  telegramAppBotLink,
  telegramBotUsernameIssue,
  telegramWebBotLink,
} from "./telegram-links";

const execFileAsync = promisify(execFile);

export const DISPATCH_SERVICE_LABEL = "com.zachrizzo.saturn-telegram-dispatch";

export type DispatchChat = {
  chatId: string;
  sessionId?: string;
  pendingSessionId?: string;
  queueLength: number;
  agentId?: string;
  model?: string;
  reasoningEffort?: string;
  verbose?: boolean;
  session?: SessionMeta;
};

export type DispatchOverview = {
  service: {
    label: string;
    loaded: boolean;
    running: boolean;
    pid?: number;
    lastExitStatus?: number;
    error?: string;
  };
  plist: {
    path?: string;
    installed: boolean;
    tokenConfigured: boolean;
    allowedChatCount: number;
    allowAll: boolean;
    baseUrl?: string;
    defaultAgentId?: string;
    botUsername?: string;
    adhocCli?: string;
    adhocModel?: string;
  };
  telegram: {
    startParameter: string;
    botUsername?: string;
    deepLink?: string;
    qrDataUri?: string;
  };
  state: {
    path: string;
    exists: boolean;
    offset: number;
    chats: DispatchChat[];
  };
  logs: {
    outPath: string;
    errPath: string;
    outExists: boolean;
    errExists: boolean;
    outTail: string;
    errTail: string;
  };
};

type TelegramState = {
  offset?: number;
  bot?: {
    username?: string;
    first_name?: string;
    updated_at?: string;
  };
  chats?: Record<string, {
    session_id?: string;
    pending_session_id?: string;
    queue?: unknown[];
    agent_id?: string;
    model?: string;
    reasoningEffort?: string;
    verbose?: boolean;
  }>;
};

function xmlValue(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  return raw
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function keyStringMap(xml: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /<key>([^<]+)<\/key>\s*<string>([\s\S]*?)<\/string>/g;
  for (const match of xml.matchAll(re)) {
    const key = xmlValue(match[1]);
    const value = xmlValue(match[2]);
    if (key && value !== undefined) out[key] = value;
  }
  return out;
}

function configuredValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.includes("replace-") || value.includes("your_") || value.includes("123456789")) return undefined;
  return value;
}

async function readFirstExisting(paths: string[]): Promise<{ path: string; raw: string } | null> {
  for (const candidate of paths) {
    try {
      return { path: candidate, raw: await fs.readFile(candidate, "utf8") };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
    }
  }
  return null;
}

async function readServiceStatus(): Promise<DispatchOverview["service"]> {
  try {
    const { stdout } = await execFileAsync("launchctl", ["list", DISPATCH_SERVICE_LABEL], { timeout: 1500 });
    const pidMatch = stdout.match(/"PID"\s*=\s*(\d+)/) ?? stdout.match(/\bPID\s*=\s*(\d+)/);
    const exitMatch = stdout.match(/"LastExitStatus"\s*=\s*(-?\d+)/) ?? stdout.match(/\bLastExitStatus\s*=\s*(-?\d+)/);
    const pid = pidMatch ? Number(pidMatch[1]) : undefined;
    return {
      label: DISPATCH_SERVICE_LABEL,
      loaded: true,
      running: Boolean(pid),
      pid,
      lastExitStatus: exitMatch ? Number(exitMatch[1]) : undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "service not loaded";
    return {
      label: DISPATCH_SERVICE_LABEL,
      loaded: false,
      running: false,
      error: message.split("\n")[0],
    };
  }
}

async function readPlist(): Promise<DispatchOverview["plist"]> {
  const root = automationsRoot();
  const installed = path.join(os.homedir(), "Library", "LaunchAgents", `${DISPATCH_SERVICE_LABEL}.plist`);
  const bundled = path.join(root, "launchd", `${DISPATCH_SERVICE_LABEL}.plist`);
  const found = await readFirstExisting([installed, bundled]);
  if (!found) {
    return {
      installed: false,
      tokenConfigured: false,
      allowedChatCount: 0,
      allowAll: false,
    };
  }

  const values = keyStringMap(found.raw);
  const token = configuredValue(values.TELEGRAM_BOT_TOKEN);
  const allowed = configuredValue(values.TELEGRAM_ALLOWED_CHAT_IDS) ?? "";
  return {
    path: found.path,
    installed: found.path === installed,
    tokenConfigured: Boolean(token),
    allowedChatCount: allowed.split(",").map((s) => s.trim()).filter(Boolean).length,
    allowAll: values.TELEGRAM_ALLOW_ALL === "1",
    baseUrl: values.SATURN_BASE_URL,
    defaultAgentId: configuredValue(values.SATURN_AGENT_ID),
    botUsername: configuredValue(values.TELEGRAM_BOT_USERNAME),
    adhocCli: values.SATURN_ADHOC_CLI,
    adhocModel: configuredValue(values.SATURN_ADHOC_MODEL),
  };
}

async function tailFile(filePath: string, maxBytes = 6000): Promise<{ exists: boolean; text: string }> {
  try {
    const stat = await fs.stat(filePath);
    const handle = await fs.open(filePath, "r");
    try {
      const length = Math.min(stat.size, maxBytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
      return { exists: true, text: buffer.toString("utf8").trim() };
    } finally {
      await handle.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return { exists: false, text: "" };
    return { exists: false, text: err instanceof Error ? err.message : "failed to read log" };
  }
}

async function readState(): Promise<DispatchOverview["state"] & { botUsername?: string }> {
  const statePath = path.join(automationsRoot(), "telegram", "state.json");
  let parsed: TelegramState = { offset: 0, chats: {} };
  let exists = false;
  try {
    parsed = JSON.parse(await fs.readFile(statePath, "utf8")) as TelegramState;
    exists = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      parsed = { offset: 0, chats: {} };
    }
  }

  const sessions = await listSessions().catch(() => []);
  const byId = new Map(sessions.map((session) => [session.session_id, session]));
  const chats = Object.entries(parsed.chats ?? {}).map(([chatId, chat]) => {
    const sessionId = chat.session_id;
    return {
      chatId,
      sessionId,
      pendingSessionId: chat.pending_session_id,
      queueLength: Array.isArray(chat.queue) ? chat.queue.length : 0,
      agentId: chat.agent_id,
      model: chat.model,
      reasoningEffort: chat.reasoningEffort,
      verbose: chat.verbose,
      session: sessionId ? byId.get(sessionId) : undefined,
    };
  });

  chats.sort((a, b) => {
    const aTime = a.session?.started_at ?? "";
    const bTime = b.session?.started_at ?? "";
    return aTime < bTime ? 1 : -1;
  });

  return {
    path: statePath,
    exists,
    offset: parsed.offset ?? 0,
    botUsername: parsed.bot?.username,
    chats,
  };
}

export async function getDispatchOverview(): Promise<DispatchOverview> {
  const outPath = path.join(runsRoot(), "telegram-dispatch.log");
  const errPath = path.join(runsRoot(), "telegram-dispatch.err.log");
  const [service, plist, state, outLog, errLog] = await Promise.all([
    readServiceStatus(),
    readPlist(),
    readState(),
    tailFile(outPath),
    tailFile(errPath),
  ]);

  const startParameter = "saturn";
  const botUsername = cleanTelegramBotUsername(plist.botUsername ?? state.botUsername ?? "");
  const validBotUsername = botUsername && !telegramBotUsernameIssue(botUsername) ? botUsername : undefined;
  const deepLink = validBotUsername ? telegramWebBotLink(validBotUsername, startParameter) : undefined;
  const qrLink = validBotUsername ? telegramAppBotLink(validBotUsername, startParameter) : undefined;

  return {
    service,
    plist,
    telegram: {
      startParameter,
      botUsername: botUsername || undefined,
      deepLink,
      qrDataUri: qrLink ? qrSvgDataUri(qrLink) : undefined,
    },
    state,
    logs: {
      outPath,
      errPath,
      outExists: outLog.exists,
      errExists: errLog.exists,
      outTail: outLog.text,
      errTail: errLog.text,
    },
  };
}
