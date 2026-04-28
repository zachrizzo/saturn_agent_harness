"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ThemeToggle } from "../ThemeToggle";
import { Kbd } from "../ui";
import { IconSearch, IconMenu, IconX } from "./icons";
import { Sidebar, type RecentChatItem } from "./Sidebar";
import { CommandPalette } from "./CommandPalette";

/**
 * Top app-shell header. Handles:
 * - ⌘K command palette mount + keyboard shortcut
 * - Mobile hamburger drawer (visible below `md`)
 * - Theme toggle + logo
 */
export function Header({ recents }: { recents: RecentChatItem[] }) {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Global ⌘K / Ctrl+K
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Close drawer whenever viewport crosses md.
  useEffect(() => {
    function onResize() {
      if (window.innerWidth >= 768) setDrawerOpen(false);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  return (
    <>
      <header
        className="sticky top-0 z-30 h-12 flex items-center gap-2 px-4 border-b border-border bg-bg/80 backdrop-blur"
        data-shell="header"
      >
        {/* Mobile hamburger */}
        <button
          type="button"
          aria-label="Open menu"
          className="btn btn-ghost btn-icon md:hidden"
          onClick={() => setDrawerOpen(true)}
        >
          <IconMenu />
        </button>

        {/* Logo / wordmark */}
        <Link
          href="/"
          className="flex items-center gap-2 font-medium tracking-tight text-[14px] hover:opacity-80 transition-opacity"
        >
          <img src="/icon.svg" alt="" className="w-5 h-5 rounded" aria-hidden="true" />
          <span>Saturn</span>
        </Link>

        <div className="flex-1" />

        {/* ⌘K trigger */}
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          aria-label="Open command palette"
          className="btn btn-ghost hidden sm:inline-flex items-center gap-2 text-muted"
        >
          <IconSearch className="w-3.5 h-3.5" />
          <span className="text-[12px]">Search</span>
          <Kbd>⌘K</Kbd>
        </button>
        <button
          type="button"
          onClick={() => setPaletteOpen(true)}
          aria-label="Open command palette"
          className="btn btn-ghost btn-icon sm:hidden"
        >
          <IconSearch />
        </button>

        <ThemeToggle />
      </header>

      {/* Mobile drawer */}
      <div
        className={[
          "md:hidden fixed inset-0 z-40 transition-opacity",
          drawerOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
        ].join(" ")}
        aria-hidden={!drawerOpen}
      >
        <div
          className="absolute inset-0 bg-black/40"
          onClick={() => setDrawerOpen(false)}
        />
        <aside
          className={[
            "absolute left-0 top-0 bottom-0 w-[260px] bg-bg border-r border-border shadow-lg",
            "transform transition-transform duration-200",
            drawerOpen ? "translate-x-0" : "-translate-x-full",
          ].join(" ")}
        >
          <div className="h-12 flex items-center justify-between px-3 border-b border-border">
            <span className="flex items-center gap-1.5 font-medium tracking-tight text-[13px]">
              <img src="/icon.svg" alt="" className="w-4 h-4 rounded" aria-hidden="true" />
              Saturn
            </span>
            <button
              type="button"
              aria-label="Close menu"
              className="btn btn-ghost btn-icon"
              onClick={() => setDrawerOpen(false)}
            >
              <IconX />
            </button>
          </div>
          <Sidebar recents={recents} onNavigate={() => setDrawerOpen(false)} />
        </aside>
      </div>

      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </>
  );
}
