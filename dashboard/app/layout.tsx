import "./globals.css";
import "@xterm/xterm/css/xterm.css";
import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { ThemeProvider, themeScript } from "./components/ThemeProvider";
import { LinkTargetPolicy } from "./components/LinkTargetPolicy";
import { listSessions } from "@/lib/runs";
import { Header } from "@/app/components/shell/Header";
import { DesktopSidebar } from "@/app/components/shell/DesktopSidebar";
import { ShellRecentsProvider } from "@/app/components/shell/ShellRecentsProvider";
import type { RecentChatItem } from "@/app/components/shell/Sidebar";
import { sessionsToRecentChatItems } from "@/app/components/shell/recent-chat-items";
import { RouteContainer } from "./RouteContainer";

export const metadata: Metadata = {
  title: "Saturn",
  description: "Scheduled agent runs + interactive CLI chat",
  icons: {
    icon: "/icon.svg",
  },
};

export const dynamic = "force-dynamic";

const uiPrefsScript = `
(function () {
  try {
    var root = document.documentElement;
    if (localStorage.getItem("saturn:sidebar-collapsed") === "1") {
      root.setAttribute("data-sidebar-collapsed", "1");
    }
    if (localStorage.getItem("saturn.inspectorCollapsed") === "1") {
      root.setAttribute("data-chat-inspector-collapsed", "1");
    }
    var width = Number(localStorage.getItem("saturn.inspectorWidth"));
    if (Number.isFinite(width) && width >= 320 && width <= 1100) {
      root.style.setProperty("--persisted-inspector-width", width + "px");
    }
  } catch (e) {}
})();
`;

async function getRecents(): Promise<RecentChatItem[]> {
  const sessions = await listSessions({ compactMeta: true });
  return sessionsToRecentChatItems(sessions);
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
        <script dangerouslySetInnerHTML={{ __html: uiPrefsScript }} />
      </head>
      <body className="antialiased">
        <ThemeProvider>
          <LinkTargetPolicy />
          <ShellRecentsProvider initialRecents={recents}>
            <div className="app-shell">
              <Header />
              <div className="flex-1 flex min-h-0 overflow-hidden">
                <DesktopSidebar />
                <main className="flex-1 min-w-0 min-h-0 overflow-y-auto overscroll-contain" data-shell="main-scroll">
                  <RouteContainer>{children}</RouteContainer>
                </main>
              </div>
            </div>
          </ShellRecentsProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
