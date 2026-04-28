import { notFound } from "next/navigation";
import { getSession } from "@/lib/runs";
import { readAppSettings } from "@/lib/settings";
import { ChatView } from "./ChatView";
import { SwarmView } from "./SwarmView";

export const revalidate = 0;
export const dynamic = "force-dynamic";

export default async function ChatSessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string>>;
}) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const [session, settings] = await Promise.all([
    getSession(id),
    readAppSettings(),
  ]);
  if (!session) notFound();

  // ?m= carries the first user message when navigating immediately after
  // session creation, before run-turn.sh has had time to write the turn stub.
  const pendingMessage = sp.m ? String(sp.m) : undefined;

  if (session.meta.agent_snapshot?.kind === "orchestrator") {
    return (
      <SwarmView
        sessionId={id}
        initialMeta={session.meta}
        initialEvents={session.events}
        hiddenMcpImageServers={settings.hiddenMcpImageServers}
      />
    );
  }

  return (
    <ChatView
      sessionId={id}
      initialMeta={session.meta}
      initialEvents={session.events}
      pendingMessage={pendingMessage}
      hiddenMcpImageServers={settings.hiddenMcpImageServers}
    />
  );
}
