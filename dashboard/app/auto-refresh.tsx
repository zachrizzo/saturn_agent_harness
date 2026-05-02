"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useTransition } from "react";

export function AutoRefresh({ intervalMs = 10000 }: { intervalMs?: number }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const pendingRef = useRef(false);
  const lastRefreshRef = useRef(0);

  useEffect(() => {
    pendingRef.current = isPending;
  }, [isPending]);

  useEffect(() => {
    if (intervalMs <= 0) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const refresh = () => {
      if (pendingRef.current || document.visibilityState !== "visible" || !navigator.onLine) {
        return;
      }
      lastRefreshRef.current = Date.now();
      startTransition(() => {
        router.refresh();
      });
    };

    const schedule = (delayMs = intervalMs) => {
      clearTimer();
      timer = setTimeout(() => {
        if (cancelled) return;
        refresh();
        schedule();
      }, delayMs);
    };

    const refreshWhenVisible = () => {
      if (
        document.visibilityState === "visible"
        && Date.now() - lastRefreshRef.current >= intervalMs
      ) {
        refresh();
        schedule();
      }
    };

    schedule();
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("online", refreshWhenVisible);

    return () => {
      cancelled = true;
      clearTimer();
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("online", refreshWhenVisible);
    };
  }, [intervalMs, router, startTransition]);

  return null;
}
