import { notFound } from "next/navigation";
import { ChatView } from "@/app/chats/[id]/ChatView";
import { getSession } from "@/lib/runs";
import type { SessionReadOptions, SessionMeta } from "@/lib/runs";
import { readAppSettings } from "@/lib/settings";
import { MergeRequestsWorkspace, type MrWorkspaceSettings } from "../MergeRequestsWorkspace";

export const revalidate = 0;
export const dynamic = "force-dynamic";

const SESSION_READ_RETRY_DELAYS_MS = [75, 125, 200, 300, 400, 500];
const MR_URL_PATTERN = /https?:\/\/[^\s<>")]+\/(?:-\/)?merge_requests\/\d+[^\s<>")]*/i;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getSessionWithCreateRaceRetry(id: string, options?: SessionReadOptions): ReturnType<typeof getSession> {
  let session = await getSession(id, options);
  for (const delay of SESSION_READ_RETRY_DELAYS_MS) {
    if (session) return session;
    await sleep(delay);
    session = await getSession(id, options);
  }
  return session;
}

function workspaceSettings(settings: Awaited<ReturnType<typeof readAppSettings>>): MrWorkspaceSettings {
  const defaultModel = settings.defaultModels[settings.defaultCli];
  return {
    defaultCli: settings.defaultCli,
    defaultMcpTools: settings.defaultMcpTools,
    defaultModel,
    defaultReasoningEffort: settings.defaultReasoningEfforts[settings.defaultCli],
    defaultCwd: settings.defaultCwd,
  };
}

function mrUrlFromSession(meta: SessionMeta): string | undefined {
  for (const item of meta.pinned_context ?? []) {
    const match = item.text.match(MR_URL_PATTERN);
    if (match?.[0]) return match[0].replace(/[.,;:!?]+$/, "");
  }
  for (const turn of meta.turns) {
    const match = turn.user_message.match(MR_URL_PATTERN);
    if (match?.[0]) return match[0].replace(/[.,;:!?]+$/, "");
  }
  return undefined;
}

export default async function MergeRequestSessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ sessionId: string }>;
  searchParams: Promise<Record<string, string>>;
}) {
  const [{ sessionId }, sp] = await Promise.all([params, searchParams]);
  const [session, settings] = await Promise.all([
    getSessionWithCreateRaceRetry(sessionId, { eventMode: "recent", compactEvents: true }),
    readAppSettings(),
  ]);
  if (!session) notFound();

  const pendingMessage = sp.m ? String(sp.m) : undefined;
  const selectedMrUrl = sp.mr ? String(sp.mr) : mrUrlFromSession(session.meta);

  return (
    <MergeRequestsWorkspace
      settings={workspaceSettings(settings)}
      selectedSessionId={sessionId}
      selectedMrUrl={selectedMrUrl}
    >
      <ChatView
        key={sessionId}
        sessionId={sessionId}
        initialMeta={session.meta}
        initialEvents={session.events}
        initialEventsPartial={session.eventsPartial}
        initialVisibleEventsPartial={session.visibleEventsPartial}
        pendingMessage={pendingMessage}
        hiddenMcpImageServers={settings.hiddenMcpImageServers}
        initialInspectorTab="mr"
        initialMrUrl={selectedMrUrl}
      />
    </MergeRequestsWorkspace>
  );
}
