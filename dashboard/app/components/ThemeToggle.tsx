"use client";

import { useTheme } from "./ThemeProvider";

const LABELS = { system: "System", light: "Light", dark: "Dark" } as const;

export function ThemeToggle() {
  const { mode, cycle } = useTheme();

  const label = LABELS[mode];

  return (
    <button
      type="button"
      onClick={cycle}
      title={`Theme: ${label} (click to cycle)`}
      aria-label={`Theme: ${label}`}
      className="btn btn-ghost btn-icon"
    >
      {mode === "system" && (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24" aria-hidden>
          <rect x="3" y="4" width="18" height="14" rx="2" />
          <path d="M8 20h8" />
        </svg>
      )}
      {mode === "light" && (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24" aria-hidden>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
        </svg>
      )}
      {mode === "dark" && (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.75} viewBox="0 0 24 24" aria-hidden>
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}
