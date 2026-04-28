"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

type ThemeCtx = {
  mode: ThemeMode;
  resolved: ResolvedTheme;
  setMode: (m: ThemeMode) => void;
  cycle: () => void;
};

const Ctx = createContext<ThemeCtx | null>(null);

function resolveMode(mode: ThemeMode): ResolvedTheme {
  if (mode !== "system") return mode;
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyAttr(theme: ResolvedTheme) {
  document.documentElement.setAttribute("data-theme", theme);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>("system");
  const [resolved, setResolved] = useState<ResolvedTheme>("dark");

  // On mount, read the mode persisted by the no-flash script
  useEffect(() => {
    const stored = (localStorage.getItem("theme") as ThemeMode | null) ?? "system";
    setModeState(stored);
    const r = resolveMode(stored);
    setResolved(r);
    applyAttr(r);

    // Watch OS-level changes while in system mode
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const cur = (localStorage.getItem("theme") as ThemeMode | null) ?? "system";
      if (cur === "system") {
        const r2 = mql.matches ? "dark" : "light";
        setResolved(r2);
        applyAttr(r2);
      }
    };
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const setMode = useCallback((m: ThemeMode) => {
    setModeState(m);
    localStorage.setItem("theme", m);
    const r = resolveMode(m);
    setResolved(r);
    applyAttr(r);
  }, []);

  const cycle = useCallback(() => {
    const order: ThemeMode[] = ["system", "light", "dark"];
    const next = order[(order.indexOf(mode) + 1) % order.length];
    setMode(next);
  }, [mode, setMode]);

  return <Ctx.Provider value={{ mode, resolved, setMode, cycle }}>{children}</Ctx.Provider>;
}

export function useTheme() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTheme outside ThemeProvider");
  return ctx;
}

// Inline script to run before React hydrates — prevents theme flash on first paint.
export const themeScript = `
(function() {
  try {
    var s = localStorage.getItem('theme');
    var mode = s || 'system';
    var resolved = mode;
    if (mode === 'system') {
      resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', resolved);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
`;
