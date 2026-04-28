"use client";

import { useMemo, useState } from "react";
import { qrSvgDataUri } from "@/lib/qr";

type Props = {
  initialBotUsername?: string;
  startParameter: string;
};

function cleanUsername(value: string): string {
  return value.trim().replace(/^@/, "").replace(/^https:\/\/t\.me\//i, "").split(/[/?#]/)[0] ?? "";
}

export function DispatchQrCard({ initialBotUsername, startParameter }: Props): JSX.Element {
  const [botUsername, setBotUsername] = useState(initialBotUsername ?? "");
  const clean = cleanUsername(botUsername);
  const deepLink = clean ? `https://t.me/${clean}?start=${startParameter}` : "";
  const qrDataUri = useMemo(() => {
    if (!deepLink) return "";
    try {
      return qrSvgDataUri(deepLink);
    } catch {
      return "";
    }
  }, [deepLink]);

  return (
    <div className="card p-5 space-y-4">
      <div className="sect-head">
        <h2>Add to Telegram</h2>
        <span className="right">{clean ? `@${clean}` : "paste bot username"}</span>
      </div>

      <label className="block space-y-1.5">
        <span className="text-[11px] text-muted uppercase tracking-wider">Bot username</span>
        <input
          className="input w-full"
          value={botUsername}
          onChange={(event) => setBotUsername(event.target.value)}
          placeholder="@your_bot_username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
      </label>

      {qrDataUri && deepLink ? (
        <div className="space-y-4">
          <a
            href={deepLink}
            target="_blank"
            rel="noreferrer"
            className="block rounded-lg border border-border bg-white p-4 w-fit"
            aria-label="Open Saturn Dispatch bot in Telegram"
          >
            <img
              src={qrDataUri}
              alt={`QR code for ${deepLink}`}
              width={264}
              height={264}
              className="block"
            />
          </a>
          <div className="space-y-2">
            <a
              href={deepLink}
              target="_blank"
              rel="noreferrer"
              className="btn btn-primary w-full"
            >
              Open in Telegram
            </a>
            <div className="mono text-[11px] text-subtle break-all">
              {deepLink}
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-bg-subtle p-4 text-[12px] text-muted">
          Paste the bot username from BotFather and the QR code appears here.
        </div>
      )}
    </div>
  );
}
