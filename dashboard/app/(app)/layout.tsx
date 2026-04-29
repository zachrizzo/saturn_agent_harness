import { listSessions } from "@/lib/runs";
import { toInboxSessions } from "@/lib/chat-inbox";
import { Header } from "@/app/components/shell/Header";
import { Sidebar, type RecentChatItem } from "@/app/components/shell/Sidebar";
import { RouteContainer } from "./RouteContainer";

export const dynamic = "force-dynamic";

async function getRecents(): Promise<RecentChatItem[]> {
  const sessions = await listSessions();
  const active = sessions.filter(
    (s) => !s.archived && ((s.turns ?? []).length > 0 || s.status === "running"),
  );
  return toInboxSessions(active).slice(0, 8).map((s) => ({
    id: s.id,
    title: s.title,
    agent: s.agent,
    preview: s.preview,
    relTime: s.relTime,
    projectName: s.projectName,
    projectPath: s.projectPath,
    isMultiCli: s.multi,
    isSwarm: s.isSwarm,
    lastReplyAt: s.lastFinishedAt ?? null,
  }));
}

export default async function AppShellLayout({ children }: { children: React.ReactNode }) {
  const recents = await getRecents();

  return (
    <div className="min-h-screen flex flex-col">
      <Header recents={recents} />
      <div className="flex-1 flex min-h-0">
        {/* Desktop sidebar */}
        <aside className="hidden md:flex md:w-60 shrink-0 border-r border-border bg-bg-subtle sticky top-12 self-start h-[calc(100vh-3rem)] overflow-y-auto">
          <Sidebar recents={recents} />
        </aside>
        {/* Main */}
        <main className="flex-1 min-w-0">
          <RouteContainer>{children}</RouteContainer>
        </main>
      </div>
    </div>
  );
}
