"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

type Variant = "open" | "service";
type InstallMode = "open" | "locked";

type Props = {
  variant: Variant;
  botUsername?: string;
  initialBotToken?: string;
  initialBaseUrl: string;
  initialAllowedChatIds?: string;
  discoveredChatIds: string[];
  serviceLabel: string;
  tokenAvailable: boolean;
};

type SaveResponse = {
  botToken?: string;
  baseUrl?: string;
  allowedChatIds?: string;
  error?: string;
};

type InstallResponse = SaveResponse & {
  stdout?: string;
  stderr?: string;
};

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function envLine(name: string, value: string): string {
  return `${name}=${shellQuote(value)}`;
}

function commandFrom(lines: string[]): string {
  return lines.join(" \\\n  ");
}

function normalizeDiscoveredChatIds(chatIds: string[]): string {
  return [...new Set(chatIds.map((chatId) => chatId.trim()).filter(Boolean))].join(",");
}

function ManualCommand({ title, command }: { title: string; command: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <details className="dispatch-install-manual">
      <summary>{title}</summary>
      <div className="dispatch-install-manual-body">
        <button type="button" className="btn text-[12px] py-1.5 px-2.5" onClick={copy}>
          {copied ? "Copied" : "Copy command"}
        </button>
        <pre className="dispatch-command mono">
          <code>{command}</code>
        </pre>
      </div>
    </details>
  );
}

export function DispatchSetupInstallPanel({
  variant,
  botUsername,
  initialBotToken,
  initialBaseUrl,
  initialAllowedChatIds,
  discoveredChatIds,
  serviceLabel,
  tokenAvailable,
}: Props): JSX.Element {
  const router = useRouter();
  const [isRefreshing, startTransition] = useTransition();
  const [botToken, setBotToken] = useState(initialBotToken ?? "");
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [allowedChatIds, setAllowedChatIds] = useState(initialAllowedChatIds ?? normalizeDiscoveredChatIds(discoveredChatIds));
  const [pendingAction, setPendingAction] = useState("");
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"good" | "warn">("good");

  const cleanBotUsername = botUsername?.trim() || "your_saturn_bot";
  const commandToken = botToken.trim() || "<paste-token-in-ui>";
  const commandBaseUrl = baseUrl.trim() || "http://127.0.0.1:3737";
  const commandAllowedChatIds = allowedChatIds.trim() || normalizeDiscoveredChatIds(discoveredChatIds) || "<allowed-chat-id>";
  const isBusy = Boolean(pendingAction) || isRefreshing;
  const canInstallOpen = Boolean(botUsername && (botToken.trim() || tokenAvailable));
  const canInstallLocked = Boolean(botUsername && (botToken.trim() || tokenAvailable) && allowedChatIds.trim());
  const discovered = normalizeDiscoveredChatIds(discoveredChatIds);

  const openInstallCommand = useMemo(() => commandFrom([
    envLine("TELEGRAM_BOT_TOKEN", commandToken),
    envLine("TELEGRAM_BOT_USERNAME", cleanBotUsername),
    envLine("TELEGRAM_ALLOW_ALL", "1"),
    envLine("SATURN_BASE_URL", commandBaseUrl),
    "bin/install-telegram-service.sh",
  ]), [cleanBotUsername, commandBaseUrl, commandToken]);

  const lockedInstallCommand = useMemo(() => commandFrom([
    envLine("TELEGRAM_BOT_TOKEN", commandToken),
    envLine("TELEGRAM_BOT_USERNAME", cleanBotUsername),
    envLine("TELEGRAM_ALLOWED_CHAT_IDS", commandAllowedChatIds),
    envLine("SATURN_BASE_URL", commandBaseUrl),
    "bin/install-telegram-service.sh",
  ]), [cleanBotUsername, commandAllowedChatIds, commandBaseUrl, commandToken]);

  const restartCommand = `launchctl kickstart -k gui/$(id -u)/${serviceLabel}`;

  async function postJson<T extends SaveResponse>(url: string, body: Record<string, string>): Promise<T> {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null) as T | null;
    if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
    return data ?? ({} as T);
  }

  async function install(mode: InstallMode) {
    setPendingAction(mode);
    setMessage("");
    try {
      const data = await postJson<InstallResponse>("/api/dispatch/setup/install", {
        mode,
        botToken,
        baseUrl,
        allowedChatIds,
        botUsername: botUsername ?? "",
      });
      setBotToken(data.botToken ?? botToken);
      setBaseUrl(data.baseUrl ?? baseUrl);
      setAllowedChatIds(data.allowedChatIds ?? allowedChatIds);
      setMessage(data.stdout || (mode === "open" ? "Bridge installed. All Telegram chats can now reach Saturn." : "Locked bridge installed."));
      setMessageTone("good");
      startTransition(() => router.refresh());
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not install Dispatch bridge.");
      setMessageTone("warn");
    } finally {
      setPendingAction("");
    }
  }

  return (
    <div className="dispatch-install-panel">
      <div className="dispatch-install-intro">
        <div className="dispatch-install-intro-title">Open access mode</div>
        <div className="dispatch-install-intro-copy">
          Saturn will accept messages from any Telegram chat that can reach this bot. You can restrict it later from the advanced section.
        </div>
      </div>

      <div className="dispatch-install-form">
        <label className="block space-y-1.5">
          <span className="text-[11px] text-muted uppercase tracking-wider">Telegram bot token</span>
          <input
            className="input w-full mono"
            value={botToken}
            onChange={(event) => setBotToken(event.target.value)}
            placeholder={tokenAvailable ? "Saved token is available; paste a new token only to replace it" : "Paste BotFather token"}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-[11px] text-muted uppercase tracking-wider">Saturn base URL</span>
          <input
            className="input w-full mono"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="http://127.0.0.1:3737"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        </label>
      </div>

      <div className="dispatch-install-primary">
        <div className="text-[11px] text-subtle">
          This writes a LaunchAgent with <code className="mono">TELEGRAM_ALLOW_ALL=1</code> and restarts the bridge.
        </div>
        <button
          type="button"
          className="btn btn-primary text-[12px] py-1.5 px-3"
          onClick={() => install("open")}
          disabled={isBusy || !canInstallOpen}
          title={!botUsername ? "Enter the bot username first" : !canInstallOpen ? "Paste the BotFather token first" : "Install the bridge"}
        >
          {pendingAction === "open" ? "Installing..." : variant === "service" ? "Reinstall for all chats" : "Install bridge"}
        </button>
      </div>

      {message && (
        <div className={`dispatch-install-status ${messageTone}`}>
          {message}
        </div>
      )}

      <ManualCommand title="Manual install command" command={openInstallCommand} />

      <details className="dispatch-install-advanced">
        <summary>Advanced: restrict to selected chats</summary>
        <div className="dispatch-install-advanced-body">
          <label className="block space-y-1.5">
            <span className="text-[11px] text-muted uppercase tracking-wider">Allowed chat IDs</span>
            <div className="dispatch-chat-id-input-row">
              <input
                className="input w-full mono"
                value={allowedChatIds}
                onChange={(event) => setAllowedChatIds(event.target.value)}
                placeholder={discovered || "Paste numeric chat id"}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
              {discovered && (
                <button
                  type="button"
                  className="btn text-[12px] px-2.5"
                  onClick={() => setAllowedChatIds(discovered)}
                >
                  Use found
                </button>
              )}
            </div>
          </label>
          <div className="dispatch-install-primary">
            <div className="text-[11px] text-subtle">
              Only use this when you want Telegram access limited to specific chat ids.
            </div>
            <button
              type="button"
              className="btn text-[12px] py-1.5 px-3"
              onClick={() => install("locked")}
              disabled={isBusy || !canInstallLocked}
            >
              {pendingAction === "locked" ? "Installing..." : "Install restricted bridge"}
            </button>
          </div>
          <ManualCommand title="Manual restricted command" command={lockedInstallCommand} />
        </div>
      </details>

      {variant === "service" && (
        <ManualCommand title="Manual restart command" command={restartCommand} />
      )}
    </div>
  );
}
