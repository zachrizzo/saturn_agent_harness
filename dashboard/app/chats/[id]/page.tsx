import { notFound } from "next/navigation";
import { getSession } from "@/lib/runs";
import type { SessionReadOptions } from "@/lib/runs";
import { readAppSettings } from "@/lib/settings";
import { ChatView } from "./ChatView";
import { SwarmView } from "./SwarmView";

export const revalidate = 0;
export const dynamic = "force-dynamic";

const SESSION_READ_RETRY_DELAYS_MS = [75, 125, 200, 300, 400, 500];

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

export default async function ChatSessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string>>;
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  let [session, settings] = await Promise.all([
    getSessionWithCreateRaceRetry(id, { eventMode: "recent" }),
    readAppSettings(),
  ]);
  if (!session) notFound();

  // ?m= carries the first user message when navigating immediately after
  // session creation, before run-turn.sh has had time to write the turn stub.
  const pendingMessage = sp.m ? String(sp.m) : undefined;

  if (session.meta.agent_snapshot?.kind === "orchestrator") {
    if (session.eventsPartial) {
      session = await getSession(id);
      if (!session) notFound();
    }
    return (
      <SwarmView
        key={id}
        sessionId={id}
        initialMeta={session.meta}
        initialEvents={session.events}
        hiddenMcpImageServers={settings.hiddenMcpImageServers}
      />
    );
  }

  return (
    <ChatView
      key={id}
      sessionId={id}
      initialMeta={session.meta}
      initialEvents={session.events}
      initialEventsPartial={session.eventsPartial}
      pendingMessage={pendingMessage}
      hiddenMcpImageServers={settings.hiddenMcpImageServers}
    />
  );
}
