import type { SessionMeta } from "@/lib/runs";
import { toInboxSessions } from "@/lib/chat-inbox";
import type { RecentChatItem } from "./Sidebar";
import { SIDEBAR_RECENT_CHAT_LIMIT } from "./recent-chat-limit";

function hasSidebarActivity(session: SessionMeta): boolean {
  return !session.archived && ((session.turns ?? []).length > 0 || session.status === "running");
}

export function sessionsToRecentChatItems(sessions: SessionMeta[]): RecentChatItem[] {
  return toInboxSessions(sessions.filter(hasSidebarActivity))
    .slice(0, SIDEBAR_RECENT_CHAT_LIMIT)
    .map((session) => ({
      id: session.id,
      title: session.title,
      agent: session.agent,
      preview: session.preview,
      relTime: session.relTime,
      projectName: session.projectName,
      projectPath: session.projectPath,
      isMultiCli: session.multi,
      isSwarm: session.isSwarm,
      isRunning: session.status === "running",
      lastReplyAt: session.lastFinishedAt ?? null,
    }));
}
