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
export const DEFAULT_DISPATCH_BASE_URL = "http://127.0.0.1:3737";

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
    allowedChatIds?: string;
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
  setup: DispatchSetupSettings & {
    tokenAvailable: boolean;
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

export type DispatchSetupSettings = {
  botToken?: string;
  baseUrl: string;
  allowedChatIds?: string;
};

export type DispatchInstallMode = "open" | "locked";

type TelegramState = {
  offset?: number;
  bot?: {
    username?: string;
    first_name?: string;
    updated_at?: string;
  };
  setup?: {
    bot_token?: string;
    base_url?: string;
    allowed_chat_ids?: string;
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

function cleanSetupToken(value: unknown, strict: boolean): string | undefined {
  if (typeof value !== "string") return undefined;
  const token = value.trim();
  if (!token) return undefined;
  if (/\s/.test(token)) {
    if (strict) throw new Error("Telegram bot token cannot contain spaces or newlines.");
    return undefined;
  }
  if (!token.includes(":")) {
    if (strict) throw new Error("Telegram bot token should look like the BotFather token, for example 123456789:abc.");
    return undefined;
  }
  return token;
}

function cleanSetupBaseUrl(value: unknown, strict: boolean): string {
  if (typeof value !== "string" || !value.trim()) return DEFAULT_DISPATCH_BASE_URL;
  const raw = value.trim();
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("SATURN_BASE_URL must start with http:// or https://.");
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch (err) {
    if (strict) {
      throw err instanceof Error ? err : new Error("SATURN_BASE_URL must be a valid URL.");
    }
    return DEFAULT_DISPATCH_BASE_URL;
  }
}

function cleanSetupAllowedChatIds(value: unknown, strict: boolean): string | undefined {
  if (typeof value !== "string") return undefined;
  const parts = value
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const invalid = parts.find((part) => !/^-?\d+$/.test(part));
  if (invalid) {
    if (strict) throw new Error(`Telegram chat id "${invalid}" must be numeric.`);
    return undefined;
  }
  return parts.length > 0 ? [...new Set(parts)].join(",") : undefined;
}

function normalizeDispatchSetupSettings(input: unknown, strict: boolean): DispatchSetupSettings {
  const rec = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  return {
    botToken: cleanSetupToken(rec.botToken ?? rec.bot_token, strict),
    baseUrl: cleanSetupBaseUrl(rec.baseUrl ?? rec.base_url, strict),
    allowedChatIds: cleanSetupAllowedChatIds(rec.allowedChatIds ?? rec.allowed_chat_ids, strict),
  };
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
    allowedChatIds: allowed || undefined,
    allowedChatCount: allowed.split(",").map((s) => s.trim()).filter(Boolean).length,
    allowAll: values.TELEGRAM_ALLOW_ALL === "1",
    baseUrl: values.SATURN_BASE_URL,
    defaultAgentId: configuredValue(values.SATURN_AGENT_ID),
    botUsername: configuredValue(values.TELEGRAM_BOT_USERNAME),
    adhocCli: values.SATURN_ADHOC_CLI,
    adhocModel: configuredValue(values.SATURN_ADHOC_MODEL),
  };
}

async function readInstalledBotToken(): Promise<string | undefined> {
  const installed = path.join(os.homedir(), "Library", "LaunchAgents", `${DISPATCH_SERVICE_LABEL}.plist`);
  const found = await readFirstExisting([installed]);
  if (!found) return undefined;
  return configuredValue(keyStringMap(found.raw).TELEGRAM_BOT_TOKEN);
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

async function readState(): Promise<DispatchOverview["state"] & { botUsername?: string; setup?: TelegramState["setup"] }> {
  const statePath = dispatchStatePath();
  const { state: parsed, exists } = await readDispatchState();

  const sessions = await listSessions({ compactMeta: true }).catch(() => []);
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
    setup: parsed.setup,
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
  const setup = normalizeDispatchSetupSettings({
    bot_token: state.setup?.bot_token,
    base_url: state.setup?.base_url ?? plist.baseUrl ?? DEFAULT_DISPATCH_BASE_URL,
    allowed_chat_ids: state.setup?.allowed_chat_ids ?? plist.allowedChatIds,
  }, false);

  return {
    service,
    plist,
    telegram: {
      startParameter,
      botUsername: botUsername || undefined,
      deepLink,
      qrDataUri: qrLink ? qrSvgDataUri(qrLink) : undefined,
    },
    setup: {
      ...setup,
      tokenAvailable: Boolean(setup.botToken || plist.tokenConfigured),
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

function dispatchStatePath(): string {
  return path.join(automationsRoot(), "telegram", "state.json");
}

async function readDispatchState(): Promise<{ state: TelegramState; exists: boolean }> {
  try {
    return {
      state: JSON.parse(await fs.readFile(dispatchStatePath(), "utf8")) as TelegramState,
      exists: true,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      return { state: { offset: 0, chats: {} }, exists: false };
    }
    return { state: { offset: 0, chats: {} }, exists: false };
  }
}

async function writeDispatchState(state: TelegramState): Promise<void> {
  const statePath = dispatchStatePath();
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(state, null, 2), "utf8");
}

async function restartDispatchServiceIfLoaded(): Promise<{ restarted: boolean; error?: string }> {
  const service = await readServiceStatus();
  if (!service.loaded) return { restarted: false };

  try {
    const uid = process.getuid?.() ?? os.userInfo().uid;
    await execFileAsync("launchctl", ["kickstart", "-k", `gui/${uid}/${DISPATCH_SERVICE_LABEL}`], { timeout: 2500 });
    return { restarted: true };
  } catch (err) {
    return {
      restarted: false,
      error: err instanceof Error ? err.message.split("\n")[0] : "failed to restart service",
    };
  }
}

export async function removeDispatchConnection(chatId: string): Promise<{
  removed: boolean;
  restarted: boolean;
  restartError?: string;
}> {
  const cleanChatId = chatId.trim();
  if (!cleanChatId) return { removed: false, restarted: false };

  const { state } = await readDispatchState();
  if (!state.chats?.[cleanChatId]) return { removed: false, restarted: false };

  delete state.chats[cleanChatId];
  await writeDispatchState(state);

  const restart = await restartDispatchServiceIfLoaded();
  return {
    removed: true,
    restarted: restart.restarted,
    restartError: restart.error,
  };
}

export async function saveDispatchBotUsername(username: string): Promise<{ botUsername: string }> {
  const botUsername = cleanTelegramBotUsername(username);
  const issue = telegramBotUsernameIssue(botUsername);
  if (issue) throw new Error(issue);

  const { state } = await readDispatchState();
  state.bot = {
    ...(state.bot ?? {}),
    username: botUsername,
    updated_at: new Date().toISOString(),
  };
  await writeDispatchState(state);

  return { botUsername };
}

export async function saveDispatchSetupSettings(input: unknown): Promise<DispatchSetupSettings> {
  const settings = normalizeDispatchSetupSettings(input, true);
  const { state } = await readDispatchState();
  const botToken = settings.botToken ?? state.setup?.bot_token;
  state.setup = {
    ...(botToken ? { bot_token: botToken } : {}),
    base_url: settings.baseUrl,
    ...(settings.allowedChatIds ? { allowed_chat_ids: settings.allowedChatIds } : {}),
    updated_at: new Date().toISOString(),
  };
  await writeDispatchState(state);
  return {
    ...settings,
    botToken,
  };
}

export async function installDispatchBridge(input: unknown): Promise<{
  mode: DispatchInstallMode;
  stdout: string;
  stderr: string;
} & DispatchSetupSettings> {
  const rec = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const mode: DispatchInstallMode = rec.mode === "locked" ? "locked" : "open";
  const botUsername = cleanTelegramBotUsername(typeof rec.botUsername === "string" ? rec.botUsername : "");
  const usernameIssue = telegramBotUsernameIssue(botUsername);
  if (usernameIssue) throw new Error(usernameIssue);

  let settings = await saveDispatchSetupSettings(rec);
  if (!settings.botToken) {
    const installedToken = await readInstalledBotToken();
    if (installedToken) settings = { ...settings, botToken: installedToken };
  }
  if (!settings.botToken) throw new Error("Add the BotFather token before installing the bridge.");
  if (mode === "locked" && !settings.allowedChatIds) {
    throw new Error("Add at least one allowed Telegram chat id before installing the locked bridge.");
  }

  const root = automationsRoot();
  const installer = path.join(root, "bin", "install-telegram-service.sh");
  const { stdout, stderr } = await execFileAsync(installer, [], {
    cwd: root,
    env: {
      ...process.env,
      TELEGRAM_BOT_TOKEN: settings.botToken,
      TELEGRAM_BOT_USERNAME: botUsername,
      TELEGRAM_ALLOWED_CHAT_IDS: mode === "locked" ? settings.allowedChatIds ?? "" : "",
      TELEGRAM_ALLOW_ALL: mode === "open" ? "1" : "0",
      SATURN_BASE_URL: settings.baseUrl,
    },
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });

  return {
    mode,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    ...settings,
  };
}
