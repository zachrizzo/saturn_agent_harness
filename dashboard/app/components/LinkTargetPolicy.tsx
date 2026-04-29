"use client";

import { useEffect } from "react";

const SAFE_REL = ["noopener", "noreferrer"];
const PROSE = ".prose-dashboard";

function applyToLink(anchor: HTMLAnchorElement) {
  const href = anchor.getAttribute("href");
  if (
    !href ||
    href.startsWith("#") ||
    href.startsWith("/") ||
    href.trim().toLowerCase().startsWith("javascript:") ||
    anchor.hasAttribute("download")
  ) return;
  if (!anchor.target) anchor.target = "_blank";
  if (anchor.target !== "_blank") return;
  const rel = new Set(anchor.rel.split(/\s+/).filter(Boolean));
  for (const v of SAFE_REL) rel.add(v);
  anchor.rel = Array.from(rel).join(" ");
}

function processContainer(root: ParentNode) {
  if (root instanceof HTMLAnchorElement) applyToLink(root);
  root.querySelectorAll("a[href]").forEach((a) => applyToLink(a as HTMLAnchorElement));
}

export function LinkTargetPolicy() {
  useEffect(() => {
    document.querySelectorAll(PROSE).forEach((el) => processContainer(el));

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof HTMLElement)) continue;
          if (node.closest(PROSE)) {
            processContainer(node);
          } else {
            node.querySelectorAll(`${PROSE} a[href]`).forEach((a) => applyToLink(a as HTMLAnchorElement));
          }
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return null;
}
