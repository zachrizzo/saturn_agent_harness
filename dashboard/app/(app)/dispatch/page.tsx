import Link from "next/link";
import type { ReactNode } from "react";
import { DispatchConnectionActions } from "./DispatchConnectionActions";
import { DispatchQrCard } from "./DispatchQrCard";
import { getDispatchOverview, type DispatchOverview } from "@/lib/dispatch";
import { listAgents, type Agent, type SessionMeta } from "@/lib/runs";

export const revalidate = 0;
export const dynamic = "force-dynamic";

type SetupKey = "bot" | "token" | "chat" | "service";
type WizardStepState = "complete" | "active" | "locked";

type WizardStep = {
  key: SetupKey;
  number: string;
  title: string;
  summary: string;
  detail: string;
  state: WizardStepState;
};

type CommandSet = {
  discovery: string;
  install: string;
  restart: string;
};

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

function setupStep(step: WizardStep): JSX.Element {
  return (
    <div className={`dispatch-step ${step.state}`}>
      <span className="dispatch-step-marker" aria-hidden="true">
        {step.state === "complete" ? "Done" : step.number}
      </span>
      <div className="min-w-0">
        <div className="dispatch-step-label">{step.title}</div>
        <div className="dispatch-step-detail">{step.summary}</div>
      </div>
    </div>
  );
}

function commandBlock(command: string): JSX.Element {
  return (
    <pre className="dispatch-command mono">
      <code>{command}</code>
    </pre>
  );
}

function WizardAction({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className="dispatch-wizard-action">
      <div>
        <div className="dispatch-wizard-action-title">{title}</div>
        <p>{body}</p>
      </div>
      {children}
    </div>
  );
}

function SetupCheck({
  done,
  label,
  detail,
}: {
  done: boolean;
  label: string;
  detail: string;
}): JSX.Element {
  return (
    <div className="dispatch-check-row">
      <span className={done ? "dispatch-check-dot done" : "dispatch-check-dot"} />
      <div className="min-w-0">
        <div className="dispatch-check-label">{label}</div>
        <div className="dispatch-check-detail">{detail}</div>
      </div>
    </div>
  );
}

function DashboardStat({
  label,
  value,
  detail,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  detail: string;
  tone?: "default" | "good" | "warn";
}): JSX.Element {
  return (
    <div className={`dispatch-dashboard-stat ${tone}`}>
      <div className="dispatch-dashboard-stat-label">{label}</div>
      <div className="dispatch-dashboard-stat-value">{value}</div>
      <div className="dispatch-dashboard-stat-detail">{detail}</div>
    </div>
  );
}

function setupActions(activeKey: SetupKey, overview: DispatchOverview, commands: CommandSet): JSX.Element {
  if (activeKey === "bot") {
    return (
      <WizardAction
        title="Create the Telegram bot"
        body="Open BotFather, send /newbot, choose a username ending in bot, and keep the token for the install step."
      >
        <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="btn btn-primary text-[12px] py-1.5 px-3">
          Open BotFather
        </a>
      </WizardAction>
    );
  }

  if (activeKey === "token") {
    return (
      <WizardAction
        title="Install the Dispatch bridge"
        body="Run this from the repo root with the token BotFather gave you. Use allow-all only long enough to discover your private chat id."
      >
        {commandBlock(commands.install)}
      </WizardAction>
    );
  }

  if (activeKey === "chat") {
    return (
      <>
        <WizardAction
          title="Discover your chat id"
          body="Run the bridge once in discovery mode, send /start to the bot, then read telegram/state.json for the chat id."
        >
          {commandBlock(commands.discovery)}
        </WizardAction>
        <WizardAction
          title="Lock Dispatch to your chat"
          body="Reinstall the LaunchAgent with TELEGRAM_ALLOWED_CHAT_IDS so only the expected Telegram chats can create sessions."
        >
          {commandBlock(commands.install)}
        </WizardAction>
      </>
    );
  }

  return (
    <WizardAction
      title={overview.service.loaded ? "Start the LaunchAgent" : "Install and start the LaunchAgent"}
      body={overview.service.loaded
        ? "The service is loaded but not running. Restart it, then refresh this page."
        : "The service is not loaded yet. Run the installer command first."}
    >
      {overview.service.loaded ? commandBlock(commands.restart) : commandBlock(commands.install)}
    </WizardAction>
  );
}

function SetupWizard({
  overview,
  steps,
  activeStep,
  progress,
  commands,
}: {
  overview: DispatchOverview;
  steps: WizardStep[];
  activeStep: WizardStep;
  progress: number;
  commands: CommandSet;
}): JSX.Element {
  return (
    <div className="dispatch-page space-y-6">
      <header className="dispatch-header">
        <div>
          <p className="dispatch-eyebrow">Telegram Dispatch</p>
          <h1 className="text-[24px] font-semibold tracking-tight">Setup wizard</h1>
          <p className="text-[13px] text-muted mt-1">
            Connect a private Telegram bot to Saturn before opening the Dispatch dashboard.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {statusChip(overview.service.running, overview.service.running ? "Running" : "Stopped")}
          {statusChip(progress === 100, progress === 100 ? "Ready" : "Needs setup")}
        </div>
      </header>

      <section className="dispatch-setup-wizard" aria-label="Dispatch setup wizard">
        <aside className="dispatch-setup-rail">
          <div className="dispatch-progress-head">
            <div>
              <div className="dispatch-wizard-kicker">Progress</div>
              <div className="dispatch-progress-value">{progress}%</div>
            </div>
            <span className="chip">{steps.filter((step) => step.state === "complete").length}/{steps.length}</span>
          </div>
          <div className="dispatch-progress-track" aria-hidden="true">
            <span style={{ width: `${progress}%` }} />
          </div>
          <div className="dispatch-setup-list">
            {steps.map((step) => (
              <div key={step.key} className="dispatch-step-wrap">
                {setupStep(step)}
              </div>
            ))}
          </div>
        </aside>

        <main className="dispatch-setup-stage">
          <div className="dispatch-next-label">Step {activeStep.number}</div>
          <h2>{activeStep.title}</h2>
          <p>{activeStep.detail}</p>
          <div className="dispatch-wizard-actions">
            {setupActions(activeStep.key, overview, commands)}
          </div>
        </main>

        <aside className="dispatch-setup-sidecar">
          <DispatchQrCard
            initialBotUsername={overview.telegram.botUsername}
            startParameter={overview.telegram.startParameter}
          />
          <div className="dispatch-setup-checks">
            <div className="sect-head">
              <h2>Live checks</h2>
              <span className="right">setup only</span>
            </div>
            <div className="space-y-3">
              <SetupCheck
                done={Boolean(overview.telegram.botUsername)}
                label="Bot username"
                detail={overview.telegram.botUsername ? `@${overview.telegram.botUsername}` : "Waiting for TELEGRAM_BOT_USERNAME"}
              />
              <SetupCheck
                done={overview.plist.tokenConfigured}
                label="Bot token"
                detail={overview.plist.tokenConfigured ? "Saved in LaunchAgent" : "Token has not been installed"}
              />
              <SetupCheck
                done={overview.plist.allowedChatCount > 0}
                label="Chat access"
                detail={overview.plist.allowAll
                  ? "Discovery mode enabled; add an allowlist to finish"
                  : `${overview.plist.allowedChatCount} allowed chat${overview.plist.allowedChatCount === 1 ? "" : "s"}`}
              />
              <SetupCheck
                done={overview.service.running}
                label="Bridge service"
                detail={overview.service.running
                  ? `Running${overview.service.pid ? ` as pid ${overview.service.pid}` : ""}`
                  : overview.service.error ?? "Not running"}
              />
            </div>
          </div>
        </aside>
      </section>
    </div>
  );
}

function ActiveConnections({ overview }: { overview: DispatchOverview }): JSX.Element {
  return (
    <section className="card p-5 space-y-4">
      <div className="sect-head">
        <h2>Active Telegram sessions</h2>
        <span className="right">{overview.state.chats.length} mapped chats</span>
      </div>

      {overview.state.chats.length === 0 ? (
        <div className="dispatch-empty-state">
          No Telegram chat has connected yet. Send /start to the bot, then send a normal task.
        </div>
      ) : (
        <div className="grid gap-3">
          {overview.state.chats.map((chat) => {
            const href = chat.sessionId ? `/chats/${encodeURIComponent(chat.sessionId)}` : "/chats";
            return (
              <div key={chat.chatId} className="dispatch-session-row">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium truncate">Telegram chat {chat.chatId}</div>
                    <div className="text-[11px] text-subtle truncate">
                      {chat.sessionId ? `session ${chat.sessionId}` : "no session yet"}
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    <span className="chip">{chat.session?.status ?? "idle"}</span>
                    {chat.queueLength > 0 && <span className="chip text-[var(--warn)]">{chat.queueLength} queued</span>}
                    {chat.pendingSessionId && <span className="chip text-accent">working</span>}
                    <Link href={href} className="btn btn-primary text-[12px] py-1 px-2.5">
                      Open
                    </Link>
                    <DispatchConnectionActions chatId={chat.chatId} />
                  </div>
                </div>
                <div className="mt-3 grid gap-2 md:grid-cols-[170px_minmax(0,1fr)_150px] text-[12px]">
                  <div className="text-muted">Route: <span className="text-fg">{chat.agentId ?? chat.session?.agent_snapshot?.name ?? "Ad-hoc"}</span></div>
                  <div className="truncate text-muted">Last: <span className="text-fg">{lastTurn(chat.session)}</span></div>
                  <div className="text-muted md:text-right">{formatDate(chat.session?.started_at)}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function BridgeHealth({ overview }: { overview: DispatchOverview }): JSX.Element {
  return (
    <section className="card p-5 space-y-4">
      <div className="sect-head">
        <h2>Bridge health</h2>
        <span className="right">{overview.service.label}</span>
      </div>

      <div className="grid gap-3 text-[12px]">
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
    </section>
  );
}

function CommandReference(): JSX.Element {
  return (
    <section className="card p-5 space-y-4">
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
    </section>
  );
}

function AgentRoutes({ agents }: { agents: Agent[] }): JSX.Element {
  return (
    <section>
      <div className="sect-head">
        <h2>Agent routes</h2>
        <span className="right">use /agent &lt;id&gt;</span>
      </div>
      {agents.length === 0 ? (
        <div className="card p-6 text-[13px] text-muted">
          No saved dashboard agents yet.
        </div>
      ) : (
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
      )}
    </section>
  );
}

function DispatchLogs({ overview }: { overview: DispatchOverview }): JSX.Element {
  return (
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
  );
}

function DispatchDashboard({
  overview,
  agents,
}: {
  overview: DispatchOverview;
  agents: Agent[];
}): JSX.Element {
  const queueTotal = overview.state.chats.reduce((total, chat) => total + chat.queueLength, 0);
  const activeChatCount = overview.state.chats.filter((chat) => chat.sessionId || chat.pendingSessionId).length;

  return (
    <div className="dispatch-page space-y-6">
      <header className="dispatch-dashboard-hero">
        <div>
          <p className="dispatch-eyebrow">Telegram Dispatch</p>
          <h1 className="text-[24px] font-semibold tracking-tight">Dispatch dashboard</h1>
          <p className="text-[13px] text-muted mt-1">
            Telegram is connected. Monitor live chats, queue pressure, routing, and bridge health from here.
          </p>
        </div>
        <div className="dispatch-dashboard-actions">
          {statusChip(true, "Ready")}
          <Link href="/chats" className="btn btn-primary text-[12px] py-1.5 px-3">Open chats</Link>
          <Link href="/agents" className="btn text-[12px] py-1.5 px-3">Manage agents</Link>
        </div>
      </header>

      <section className="dispatch-dashboard-stats">
        <DashboardStat
          label="Bridge"
          value="Running"
          detail={overview.service.pid ? `pid ${overview.service.pid}` : overview.service.label}
          tone="good"
        />
        <DashboardStat
          label="Connected chats"
          value={overview.state.chats.length}
          detail={`${activeChatCount} active or mapped`}
        />
        <DashboardStat
          label="Queued messages"
          value={queueTotal}
          detail={queueTotal === 0 ? "No backlog" : "Waiting for agent turns"}
          tone={queueTotal > 0 ? "warn" : "default"}
        />
        <DashboardStat
          label="Default route"
          value={overview.plist.defaultAgentId ?? "Ad-hoc"}
          detail={overview.plist.adhocModel ?? overview.plist.adhocCli ?? "dashboard defaults"}
        />
      </section>

      <section className="dispatch-dashboard-layout">
        <div className="dispatch-dashboard-primary">
          <ActiveConnections overview={overview} />
          <AgentRoutes agents={agents} />
        </div>
        <aside className="dispatch-dashboard-secondary">
          <DispatchQrCard
            initialBotUsername={overview.telegram.botUsername}
            startParameter={overview.telegram.startParameter}
          />
          <BridgeHealth overview={overview} />
          <CommandReference />
        </aside>
      </section>

      <DispatchLogs overview={overview} />
    </div>
  );
}

export default async function DispatchPage() {
  const [overview, agents] = await Promise.all([
    getDispatchOverview(),
    listAgents().catch(() => []),
  ]);

  const setupChecks = [
    Boolean(overview.telegram.botUsername),
    overview.plist.tokenConfigured,
    overview.plist.allowedChatCount > 0,
    overview.service.running,
  ];
  const firstIncomplete = setupChecks.findIndex((done) => !done);
  const activeIndex = firstIncomplete === -1 ? setupChecks.length - 1 : firstIncomplete;
  const completeCount = setupChecks.filter(Boolean).length;
  const progress = Math.round((completeCount / setupChecks.length) * 100);
  const botUsername = overview.telegram.botUsername ?? "your_saturn_bot";
  const baseUrl = overview.plist.baseUrl ?? "http://127.0.0.1:3737";
  const commands: CommandSet = {
    discovery: [
      `TELEGRAM_BOT_TOKEN="123:abc"`,
      `TELEGRAM_BOT_USERNAME="${botUsername}"`,
      `TELEGRAM_ALLOW_ALL=1`,
      `SATURN_BASE_URL="${baseUrl}"`,
      `node bin/telegram-dispatch.mjs`,
    ].join(" \\\n  "),
    install: [
      `TELEGRAM_BOT_TOKEN="123:abc"`,
      `TELEGRAM_BOT_USERNAME="${botUsername}"`,
      `TELEGRAM_ALLOWED_CHAT_IDS="123456789"`,
      `SATURN_BASE_URL="${baseUrl}"`,
      `bin/install-telegram-service.sh`,
    ].join(" \\\n  "),
    restart: `launchctl kickstart -k gui/$(id -u)/${overview.service.label}`,
  };
  const stepState = (index: number): WizardStepState => {
    if (setupChecks[index]) return "complete";
    return index === activeIndex ? "active" : "locked";
  };
  const steps: WizardStep[] = [
    {
      key: "bot",
      number: "1",
      title: "Create bot",
      summary: overview.telegram.botUsername ? `@${overview.telegram.botUsername}` : "BotFather username needed",
      detail: "Create the Telegram bot and give Saturn the bot username. The token is only used in the local install command.",
      state: stepState(0),
    },
    {
      key: "token",
      number: "2",
      title: "Install bridge",
      summary: overview.plist.tokenConfigured ? "Token saved" : "Token not installed",
      detail: "Install the local LaunchAgent so Dispatch can receive Telegram updates while the dashboard is running.",
      state: stepState(1),
    },
    {
      key: "chat",
      number: "3",
      title: "Allow chat",
      summary: overview.plist.allowedChatCount > 0
        ? `${overview.plist.allowedChatCount} chat${overview.plist.allowedChatCount === 1 ? "" : "s"} allowed`
        : overview.plist.allowAll
          ? "Discovery mode active"
          : "No chat allowed yet",
      detail: "Discover the Telegram chat id, then reinstall the bridge with an explicit allowlist.",
      state: stepState(2),
    },
    {
      key: "service",
      number: "4",
      title: "Send test",
      summary: overview.service.running ? "Bridge running" : "Bridge stopped",
      detail: "Start the bridge and send a normal task from Telegram. Once this check passes, Dispatch opens the dashboard.",
      state: stepState(3),
    },
  ];
  const activeStep = steps[activeIndex] ?? steps[steps.length - 1];

  if (setupChecks.every(Boolean)) {
    return <DispatchDashboard overview={overview} agents={agents} />;
  }

  return (
    <SetupWizard
      overview={overview}
      steps={steps}
      activeStep={activeStep}
      progress={progress}
      commands={commands}
    />
  );
}
