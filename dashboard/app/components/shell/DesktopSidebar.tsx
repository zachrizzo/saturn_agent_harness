"use client";

import { useEffect, useState } from "react";
import { Sidebar } from "./Sidebar";

const SIDEBAR_COLLAPSED_KEY = "saturn:sidebar-collapsed";

function getStoredSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

function setStoredSidebarCollapsed(collapsed: boolean) {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {}
}

export function DesktopSidebar(): JSX.Element {
  const [loaded, setLoaded] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setCollapsed(getStoredSidebarCollapsed());
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    setStoredSidebarCollapsed(collapsed);
  }, [collapsed, loaded]);

  return (
    <aside
      className={[
        "app-sidebar hidden md:flex shrink-0 border-r border-border bg-bg-subtle h-full overflow-hidden",
        collapsed ? "app-sidebar-collapsed" : "app-sidebar-expanded",
      ].join(" ")}
      data-sidebar-collapsed={collapsed ? "true" : "false"}
    >
      <Sidebar
        sidebarCollapsed={collapsed}
        onSidebarCollapsedChange={setCollapsed}
        showDesktopControls
      />
    </aside>
  );
}
