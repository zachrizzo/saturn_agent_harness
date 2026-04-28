"use client";

import { useEffect } from "react";

const SAME_TAB_ATTR = "data-same-tab";
const SAFE_REL_VALUES = ["noopener", "noreferrer"];

function shouldUseSameTab(anchor: HTMLAnchorElement) {
  const href = anchor.getAttribute("href");
  return (
    !href ||
    href.startsWith("#") ||
    href.trim().toLowerCase().startsWith("javascript:") ||
    anchor.hasAttribute("download") ||
    anchor.hasAttribute(SAME_TAB_ATTR)
  );
}

function applyNewTabPolicy(anchor: HTMLAnchorElement) {
  if (shouldUseSameTab(anchor)) return;
  if (!anchor.target) anchor.target = "_blank";
  if (anchor.target !== "_blank") return;

  const rel = new Set(anchor.rel.split(/\s+/).filter(Boolean));
  for (const value of SAFE_REL_VALUES) rel.add(value);
  anchor.rel = Array.from(rel).join(" ");
}

function applyNewTabPolicyWithin(root: ParentNode) {
  if (root instanceof HTMLAnchorElement) applyNewTabPolicy(root);
  root.querySelectorAll?.("a[href]").forEach((anchor) => {
    applyNewTabPolicy(anchor as HTMLAnchorElement);
  });
}

export function LinkTargetPolicy() {
  useEffect(() => {
    applyNewTabPolicyWithin(document.body);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLElement) applyNewTabPolicyWithin(node);
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    const handleClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest<HTMLAnchorElement>("a[href]");
      if (!anchor) return;
      applyNewTabPolicy(anchor);
    };

    document.addEventListener("click", handleClick, true);
    return () => {
      observer.disconnect();
      document.removeEventListener("click", handleClick, true);
    };
  }, []);

  return null;
}
