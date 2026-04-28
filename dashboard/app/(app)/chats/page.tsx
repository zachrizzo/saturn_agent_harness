import { listSessions } from "@/lib/runs";
import { folderCounts, toInboxSessions } from "@/lib/chat-inbox";
import { ChatsInbox } from "./ChatsInbox";

export const dynamic = "force-dynamic";

export default async function ChatsPage() {
  const sessions = await listSessions();
  const now = Date.now();
  const inboxSessions = toInboxSessions(sessions, now);
  const counts = folderCounts(inboxSessions);
  return <ChatsInbox initialSessions={inboxSessions} counts={counts} />;
}
