import "./globals.css";
import "@xterm/xterm/css/xterm.css";
import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { ThemeProvider, themeScript } from "./components/ThemeProvider";
import { LinkTargetPolicy } from "./components/LinkTargetPolicy";
import { listSessions } from "@/lib/runs";
import { toInboxSessions } from "@/lib/chat-inbox";
import { Header } from "@/app/components/shell/Header";
import { DesktopSidebar } from "@/app/components/shell/DesktopSidebar";
import type { RecentChatItem } from "@/app/components/shell/Sidebar";
import { RouteContainer } from "./RouteContainer";

export const metadata: Metadata = {
  title: "Saturn",
  description: "Scheduled agent runs + interactive CLI chat",
  icons: {
    icon: "/icon.svg",
  },
};

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

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const recents = await getRecents();

  return (
    <html lang="en" suppressHydrationWarning className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <head>
        {/*
          Inline theme-init script. Content is a module-level constant compiled from
          our own source code — no untrusted input — and must run before React hydrates
          so the page paints with the correct theme (no white flash in dark mode).
          This is the pattern recommended by the Next.js docs and next-themes.
        */}
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="antialiased">
        <ThemeProvider>
          <LinkTargetPolicy />
          <div className="app-shell">
            <Header recents={recents} />
            <div className="flex-1 flex min-h-0 overflow-hidden">
              <DesktopSidebar recents={recents} />
              <main className="flex-1 min-w-0 min-h-0 overflow-y-auto overscroll-contain" data-shell="main-scroll">
                <RouteContainer>{children}</RouteContainer>
              </main>
            </div>
          </div>
        </ThemeProvider>
      </body>
    </html>
  );
}
