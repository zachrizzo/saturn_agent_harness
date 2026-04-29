import Link from "next/link";
import { DispatchQrCard } from "./DispatchQrCard";
import { getDispatchOverview } from "@/lib/dispatch";
import { listAgents, type Agent, type SessionMeta } from "@/lib/runs";

export const revalidate = 0;
export const dynamic = "force-dynamic";

function statusChip(ok: boolean, label: string): JSX.Element {
  return (
    <span className={[
      "chip",
      ok ? "text-[var(--success)]" : "text-[var(--fail)]",
    ].join(" ")}>
      {label}
    </span>
  );
}

function formatDate(value?: string): string {
  if (!value) return "none";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function lastTurn(meta?: SessionMeta): string {
  const turn = meta?.turns?.[meta.turns.length - 1];
  if (!turn) return "No turns yet";
  const text = turn.final_text?.trim() || turn.user_message || "Turn started";
  return text.replace(/\s+/g, " ").slice(0, 130);
}

function agentKind(agent: Agent): string {
  return agent.kind === "orchestrator" ? "Swarm" : "Chat";
}

function setupStep(ok: boolean, label: string, detail: string): JSX.Element {
  return (
    <div className={ok ? "dispatch-step done" : "dispatch-step"}>
      <span className="dispatch-step-marker" aria-hidden="true">
        {ok ? "✓" : ""}
      </span>
      <div className="min-w-0">
        <div className="dispatch-step-label">{label}</div>
        <div className="dispatch-step-detail">{detail}</div>
      </div>
    </div>
  );
}

const TELEGRAM_COMMANDS = [
  ["/new <task>", "Start a fresh Saturn session from Telegram."],
  ["/reset", "Clear the current Telegram chat's session mapping."],
  ["/status", "Show session status, turn count, and queue depth."],
  ["/session", "Return the Saturn session id for the active Telegram chat."],
  ["/agent <id|off>", "Route new sessions through a saved dashboard agent."],
  ["/model <id>", "Override the model for this Telegram chat."],
  ["/think low|medium|high|xhigh", "Set reasoning effort for future turns."],
  ["/verbose on|off", "Toggle dashboard links and extra run details."],
];

export default async function DispatchPage() {
  const [overview, agents] = await Promise.all([
    getDispatchOverview(),
    listAgents().catch(() => []),
  ]);

  const configured = overview.plist.tokenConfigured
    && (overview.plist.allowAll || overview.plist.allowedChatCount > 0);
  const nextStep = !overview.telegram.botUsername
    ? {
        label: "Start here",
        title: "Create or enter a bot username",
        body: "Use BotFather to create the bot, then paste the username to generate the phone link and QR code.",
      }
    : !overview.plist.tokenConfigured
      ? {
          label: "Needs bridge token",
          title: "Install the Telegram bridge",
          body: "The bot username is known, but the local LaunchAgent still needs the token before Saturn can receive messages.",
        }
      : !configured
        ? {
            label: "Needs allowed chat",
            title: "Allow a chat id",
            body: "Add at least one allowed Telegram chat id, or configure the bridge to allow all chats.",
          }
        : !overview.service.running
          ? {
              label: "Ready to start",
              title: "Start the LaunchAgent",
              body: "The bot is configured. Start the bridge so Telegram messages can create Saturn chats.",
            }
          : {
              label: "Ready",
              title: "Dispatch is listening",
              body: "Open the bot on your phone and send a task. Saturn will route it into Chats.",
            };

  return (
    <div className="dispatch-page space-y-6">
      <header className="dispatch-header">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Dispatch</h1>
          <p className="text-[13px] text-muted mt-1">
            Connect Telegram to Saturn so phone messages can start and continue dashboard chats.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {statusChip(overview.service.running, overview.service.running ? "Running" : "Stopped")}
          {statusChip(configured, configured ? "Configured" : "Needs setup")}
        </div>
      </header>

      <section className="dispatch-command-center">
        <div className="dispatch-next-card">
          <div className="dispatch-next-label">{nextStep.label}</div>
          <h2>{nextStep.title}</h2>
          <p>{nextStep.body}</p>
          <div className="dispatch-setup-list" aria-label="Telegram setup checklist">
            {setupStep(Boolean(overview.telegram.botUsername), "Bot username", overview.telegram.botUsername ? `@${overview.telegram.botUsername}` : "Paste it below")}
            {setupStep(overview.plist.tokenConfigured, "Bot token", overview.plist.tokenConfigured ? "Saved in LaunchAgent" : "Missing from bridge")}
            {setupStep(overview.plist.allowAll || overview.plist.allowedChatCount > 0, "Allowed chats", overview.plist.allowAll ? "All chats allowed" : `${overview.plist.allowedChatCount} chat${overview.plist.allowedChatCount === 1 ? "" : "s"}`)}
            {setupStep(overview.service.running, "Bridge service", overview.service.running ? `Running${overview.service.pid ? ` as pid ${overview.service.pid}` : ""}` : "Stopped")}
          </div>
        </div>

        <div className="dispatch-metrics-grid">
          <div className="kpi">
            <span className="accent-line" />
            <div className="kpi-label">LaunchAgent</div>
            <div className="kpi-value text-[20px]">{overview.service.loaded ? "Loaded" : "Missing"}</div>
            <div className="kpi-delta">{overview.service.pid ? `pid ${overview.service.pid}` : overview.service.error ?? "not running"}</div>
          </div>
          <div className="kpi">
            <span className="accent-line" />
            <div className="kpi-label">Telegram chats</div>
            <div className="kpi-value">{overview.state.chats.length}</div>
            <div className="kpi-delta">{overview.state.exists ? `offset ${overview.state.offset}` : "no state file"}</div>
          </div>
          <div className="kpi">
            <span className="accent-line" />
            <div className="kpi-label">Allowed chats</div>
            <div className="kpi-value">{overview.plist.allowAll ? "All" : overview.plist.allowedChatCount}</div>
            <div className="kpi-delta">{overview.plist.tokenConfigured ? "bot token set" : "bot token missing"}</div>
          </div>
          <div className="kpi">
            <span className="accent-line" />
            <div className="kpi-label">Default route</div>
            <div className="kpi-value text-[20px]">{overview.plist.defaultAgentId ?? "Ad-hoc"}</div>
            <div className="kpi-delta">{overview.plist.adhocModel ?? overview.plist.adhocCli ?? "dashboard defaults"}</div>
          </div>
        </div>
      </section>

      <section className="dispatch-connect-grid">
        <DispatchQrCard
          initialBotUsername={overview.telegram.botUsername}
          startParameter={overview.telegram.startParameter}
        />

        <div className="card p-5 space-y-4">
          <div className="sect-head">
            <h2>Phone workflow</h2>
            <span className="right">OpenClaw-style</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg border border-border bg-bg-subtle p-4">
              <div className="text-[13px] font-medium">1. Create bot</div>
              <div className="text-[12px] text-muted mt-1">
                Open <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="text-accent hover:underline">@BotFather</a>, send <code className="mono text-fg">/newbot</code>, choose a username ending in <code className="mono text-fg">bot</code>, and copy the token.
              </div>
            </div>
            <div className="rounded-lg border border-border bg-bg-subtle p-4">
              <div className="text-[13px] font-medium">2. Configure bridge</div>
              <div className="text-[12px] text-muted mt-1">
                Install with <code className="mono text-fg">TELEGRAM_BOT_TOKEN</code>, <code className="mono text-fg">TELEGRAM_BOT_USERNAME</code>, and allowed chat ids.
              </div>
            </div>
            <div className="rounded-lg border border-border bg-bg-subtle p-4">
              <div className="text-[13px] font-medium">3. Start</div>
              <div className="text-[12px] text-muted mt-1">Scan the QR or open the bot link, then press Start. Telegram sends <code className="mono text-fg">/start {overview.telegram.startParameter}</code>.</div>
            </div>
            <div className="rounded-lg border border-border bg-bg-subtle p-4">
              <div className="text-[13px] font-medium">4. Message</div>
              <div className="text-[12px] text-muted mt-1">Send a normal task. Follow-ups queue while Saturn is working.</div>
            </div>
          </div>
          <div className="text-[12px] text-muted">
            Telegram sessions show up in <Link href="/chats" className="text-accent hover:underline">Chats</Link>. Use <code className="mono text-fg">/agent research-deep-dive</code> or another saved agent id to change routing from Telegram.
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(360px,0.9fr)]">
        <div className="card p-5 space-y-4">
          <div className="sect-head">
            <h2>Telegram bridge</h2>
            <span className="right">{overview.service.label}</span>
          </div>

          <div className="grid gap-3 md:grid-cols-2 text-[12px]">
            <div>
              <div className="text-muted mb-1">Service</div>
              <div className="text-fg">
                {overview.service.running
                  ? `Running${overview.service.pid ? ` as pid ${overview.service.pid}` : ""}`
                  : overview.service.loaded
                    ? `Loaded, exit ${overview.service.lastExitStatus ?? "unknown"}`
                    : "Not loaded into launchd"}
              </div>
            </div>
            <div>
              <div className="text-muted mb-1">Base URL</div>
              <div className="mono truncate" title={overview.plist.baseUrl}>{overview.plist.baseUrl ?? "http://127.0.0.1:3737"}</div>
            </div>
            <div>
              <div className="text-muted mb-1">LaunchAgent plist</div>
              <div className="mono truncate" title={overview.plist.path}>{overview.plist.path ?? "not found"}</div>
            </div>
            <div>
              <div className="text-muted mb-1">State file</div>
              <div className="mono truncate" title={overview.state.path}>{overview.state.path}</div>
            </div>
          </div>

          {!overview.service.loaded && (
            <div className="rounded-lg border border-border bg-bg-subtle p-4 text-[12px] text-muted space-y-2">
              <div className="text-fg font-medium">Install the Telegram Dispatch LaunchAgent</div>
              <pre className="mono text-[11px] whitespace-pre-wrap overflow-x-auto">{`TELEGRAM_BOT_TOKEN="123:abc" TELEGRAM_BOT_USERNAME="your_saturn_bot" TELEGRAM_ALLOWED_CHAT_IDS="123456789" bin/install-telegram-service.sh`}</pre>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Link href="/chats" className="btn btn-primary text-[12px] py-1 px-2.5">Open chats</Link>
            <Link href="/agents" className="btn text-[12px] py-1 px-2.5">Manage agents</Link>
            <Link href="/settings" className="btn text-[12px] py-1 px-2.5">Settings</Link>
          </div>
        </div>

        <div className="card p-5 space-y-4">
          <div className="sect-head">
            <h2>Telegram controls</h2>
            <span className="right">send to bot</span>
          </div>
          <div className="space-y-2">
            {TELEGRAM_COMMANDS.map(([command, help]) => (
              <div key={command} className="grid grid-cols-[170px_minmax(0,1fr)] gap-3 text-[12px]">
                <code className="mono text-fg">{command}</code>
                <span className="text-muted">{help}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section>
        <div className="sect-head">
          <h2>Active Telegram sessions</h2>
          <span className="right">{overview.state.chats.length} mapped chats</span>
        </div>

        {overview.state.chats.length === 0 ? (
          <div className="card p-6 text-[13px] text-muted">
            No Telegram chat has connected yet. After setup, send <code className="mono text-fg">/start</code> to the bot, then send a normal task.
          </div>
        ) : (
          <div className="grid gap-3">
            {overview.state.chats.map((chat) => (
              <Link
                key={chat.chatId}
                href={chat.sessionId ? `/chats/${encodeURIComponent(chat.sessionId)}` : "/chats"}
                className="card p-4 hover:border-accent/40 transition-colors"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium truncate">Telegram chat {chat.chatId}</div>
                    <div className="text-[11px] text-subtle truncate">
                      {chat.sessionId ? `session ${chat.sessionId}` : "no session yet"}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <span className="chip">{chat.session?.status ?? "idle"}</span>
                    {chat.queueLength > 0 && <span className="chip text-[var(--warn)]">{chat.queueLength} queued</span>}
                    {chat.pendingSessionId && <span className="chip text-accent">working</span>}
                  </div>
                </div>
                <div className="mt-3 grid gap-2 md:grid-cols-[170px_minmax(0,1fr)_150px] text-[12px]">
                  <div className="text-muted">Route: <span className="text-fg">{chat.agentId ?? chat.session?.agent_snapshot?.name ?? "Ad-hoc"}</span></div>
                  <div className="truncate text-muted">Last: <span className="text-fg">{lastTurn(chat.session)}</span></div>
                  <div className="text-muted md:text-right">{formatDate(chat.session?.started_at)}</div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="sect-head">
          <h2>Agent routes</h2>
          <span className="right">use /agent &lt;id&gt;</span>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {agents.map((agent) => (
            <Link
              key={agent.id}
              href={`/agents/${encodeURIComponent(agent.id)}/edit`}
              className="card p-4 hover:border-accent/40 transition-colors"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[13px] font-medium truncate">{agent.name}</div>
                  <div className="text-[11px] text-subtle truncate">{agent.id}</div>
                </div>
                <span className="chip">{agentKind(agent)}</span>
              </div>
              <div className="mt-3 text-[12px] text-muted">
                Telegram command: <code className="mono text-fg">/agent {agent.id}</code>
              </div>
            </Link>
          ))}
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <div className="card p-5 space-y-3">
          <div className="sect-head">
            <h2>Stdout</h2>
            <span className="right mono truncate" title={overview.logs.outPath}>{overview.logs.outExists ? "log found" : "no log"}</span>
          </div>
          <pre className="mono text-[11px] text-muted whitespace-pre-wrap max-h-[260px] overflow-auto">{overview.logs.outTail || "No stdout yet."}</pre>
        </div>
        <div className="card p-5 space-y-3">
          <div className="sect-head">
            <h2>Stderr</h2>
            <span className="right mono truncate" title={overview.logs.errPath}>{overview.logs.errExists ? "log found" : "no log"}</span>
          </div>
          <pre className="mono text-[11px] text-muted whitespace-pre-wrap max-h-[260px] overflow-auto">{overview.logs.errTail || "No stderr yet."}</pre>
        </div>
      </section>
    </div>
  );
}
