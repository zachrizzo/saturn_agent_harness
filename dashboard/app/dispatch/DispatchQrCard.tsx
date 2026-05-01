"use client";

import { useMemo, useState } from "react";
import { qrSvgDataUri } from "@/lib/qr";
import {
  cleanTelegramBotUsername,
  telegramAppBotLink,
  telegramBotUsernameIssue,
  telegramWebBotLink,
} from "@/lib/telegram-links";

type Props = {
  initialBotUsername?: string;
  startParameter: string;
};

export function DispatchQrCard({ initialBotUsername, startParameter }: Props): JSX.Element {
  const [botUsername, setBotUsername] = useState(initialBotUsername ?? "");
  const clean = cleanTelegramBotUsername(botUsername);
  const usernameIssue = telegramBotUsernameIssue(clean);
  const webDeepLink = usernameIssue ? "" : telegramWebBotLink(clean, startParameter);
  const qrDeepLink = usernameIssue ? "" : telegramAppBotLink(clean, startParameter);
  const qrDataUri = useMemo(() => {
    if (!qrDeepLink) return "";
    try {
      return qrSvgDataUri(qrDeepLink);
    } catch {
      return "";
    }
  }, [qrDeepLink]);

  return (
    <div className="card dispatch-qr-card p-5 space-y-4">
      <div className="sect-head">
        <h2>Open bot on phone</h2>
        <span className="right">{clean ? `@${clean}` : "username needed"}</span>
      </div>

      <label className="block space-y-1.5">
        <span className="text-[11px] text-muted uppercase tracking-wider">Telegram bot username</span>
        <input
          className="input w-full"
          value={botUsername}
          onChange={(event) => setBotUsername(event.target.value)}
          placeholder="@your_bot_username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        <span className="block text-[11px] text-muted">
          Create it with <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-accent hover:underline">@BotFather</a> using <code className="mono text-fg">/newbot</code>. This field only needs the username, not the token.
        </span>
      </label>

      {qrDataUri && webDeepLink && qrDeepLink ? (
        <div className="space-y-4">
          <a
            href={webDeepLink}
            target="_blank"
            rel="noreferrer"
            className="block rounded-lg border border-border bg-white p-4 w-fit"
            aria-label="Open Saturn Dispatch bot in Telegram"
          >
            <img
              src={qrDataUri}
              alt={`QR code for ${qrDeepLink}`}
              width={264}
              height={264}
              className="block"
            />
          </a>
          <div className="space-y-2">
            <a
              href={webDeepLink}
              target="_blank"
              rel="noreferrer"
              className="btn btn-primary w-full"
            >
              Open in Telegram
            </a>
            <div className="mono text-[11px] text-subtle break-all">
              QR: {qrDeepLink}
            </div>
            <div className="mono text-[11px] text-subtle break-all">
              Link: {webDeepLink}
            </div>
          </div>
        </div>
      ) : (
        <div className="dispatch-qr-empty">
          <div className="dispatch-qr-empty-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" rx="1" />
              <rect x="14" y="3" width="7" height="7" rx="1" />
              <rect x="3" y="14" width="7" height="7" rx="1" />
              <path d="M14 14h3v3h-3zM20 14v7M14 20h3" />
            </svg>
          </div>
          <div>
            <div className="dispatch-qr-empty-title">QR link appears here</div>
            <div className="dispatch-qr-empty-copy">{usernameIssue}</div>
          </div>
        </div>
      )}
    </div>
  );
}
