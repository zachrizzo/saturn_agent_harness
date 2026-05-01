"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

const FULL_BLEED_PREFIXES = ["/chats", "/memory", "/terminals"];

/**
 * Wraps page content in the default centered/padded container, unless the
 * current route opts into full-bleed layout (e.g. the chats inbox and chat
 * view, which own their own horizontal rhythm).
 */
export function RouteContainer({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const fullBleed = FULL_BLEED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
  if (fullBleed) return <>{children}</>;
  return <div className="max-w-6xl mx-auto px-6 py-6">{children}</div>;
}
