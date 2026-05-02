"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ThemeToggle } from "../ThemeToggle";
import { Kbd } from "../ui";
import { IconSearch, IconMenu, IconX } from "./icons";
import { Sidebar } from "./Sidebar";
import { CommandPalette } from "./CommandPalette";

/**
 * Top app-shell header. Handles:
 * - ⌘K command palette mount + keyboard shortcut
 * - Mobile hamburger drawer (visible below `md`)
 * - Theme toggle + logo
 */
export function Header() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerRendered, setDrawerRendered] = useState(false);
  const drawerRootRef = useRef<HTMLDivElement>(null);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);

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
    const media = window.matchMedia("(min-width: 768px)");
    function closeIfDesktop() {
      if (media.matches) setDrawerOpen(false);
    }
    closeIfDesktop();
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", closeIfDesktop);
      return () => media.removeEventListener("change", closeIfDesktop);
    }
    media.addListener(closeIfDesktop);
    return () => media.removeListener(closeIfDesktop);
  }, []);

  useEffect(() => {
    if (!drawerOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") closeDrawer();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeDrawer, drawerOpen]);

  useEffect(() => {
    const node = drawerRootRef.current;
    if (!node) return;
    if (drawerOpen) {
      node.removeAttribute("inert");
    } else {
      node.setAttribute("inert", "");
    }
  }, [drawerOpen]);

  useEffect(() => {
    if (drawerOpen) {
      setDrawerRendered(true);
      return;
    }
    const timeout = setTimeout(() => setDrawerRendered(false), 220);
    return () => clearTimeout(timeout);
  }, [drawerOpen]);

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
        ref={drawerRootRef}
        className={[
          "md:hidden fixed inset-0 z-40 transition-opacity",
          drawerOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
        ].join(" ")}
        aria-hidden={!drawerOpen}
      >
        <div
          className="absolute inset-0 bg-black/40"
          onClick={closeDrawer}
        />
        <aside
          role="dialog"
          aria-modal="true"
          aria-label="Navigation menu"
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
              onClick={closeDrawer}
            >
              <IconX />
            </button>
          </div>
          {drawerRendered && <Sidebar onNavigate={closeDrawer} recentsScrollable />}
        </aside>
      </div>

      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </>
  );
}
