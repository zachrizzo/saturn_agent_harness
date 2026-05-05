"use client";

import { useEffect, useId, useState } from "react";
import { Portal } from "../Portal";

type MermaidTheme = "default" | "dark";
type MermaidSvgState = { cacheKey: string; svg: string };
type MermaidCacheEntry = {
  cacheId: string;
  svg?: string;
  promise?: Promise<string>;
};

const MERMAID_CACHE_LIMIT = 48;
const mermaidSvgCache = new Map<string, MermaidCacheEntry>();

function currentMermaidTheme(): MermaidTheme {
  if (typeof document === "undefined") return "default";
  return document.documentElement.dataset.theme === "dark" ? "dark" : "default";
}

function mermaidCacheKey(chart: string): string {
  return `${currentMermaidTheme()}\0${chart}`;
}

function mermaidThemeFromCacheKey(cacheKey: string): MermaidTheme {
  return cacheKey.startsWith("dark\0") ? "dark" : "default";
}

function hashMermaidKey(input: string): string {
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function rememberMermaidEntry(cacheKey: string, entry: MermaidCacheEntry) {
  mermaidSvgCache.delete(cacheKey);
  mermaidSvgCache.set(cacheKey, entry);
  while (mermaidSvgCache.size > MERMAID_CACHE_LIMIT) {
    const oldest = mermaidSvgCache.keys().next().value;
    if (!oldest) break;
    mermaidSvgCache.delete(oldest);
  }
}

function materializeMermaidSvg(svg: string, cacheId: string, instanceId: string): string {
  return cacheId === instanceId ? svg : svg.split(cacheId).join(instanceId);
}

function cachedMermaidSvg(chart: string, instanceId: string, cacheKey = mermaidCacheKey(chart)): string | null {
  const entry = mermaidSvgCache.get(cacheKey);
  if (!entry?.svg) return null;
  rememberMermaidEntry(cacheKey, entry);
  return materializeMermaidSvg(entry.svg, entry.cacheId, instanceId);
}

async function renderMermaidSvg(
  chart: string,
  instanceId: string,
  cacheKey = mermaidCacheKey(chart),
): Promise<MermaidSvgState> {
  let entry = mermaidSvgCache.get(cacheKey);
  if (!entry) {
    entry = { cacheId: `saturn-mermaid-cache-${hashMermaidKey(cacheKey)}` };
    rememberMermaidEntry(cacheKey, entry);
  }

  if (entry.svg) {
    rememberMermaidEntry(cacheKey, entry);
    return {
      cacheKey,
      svg: materializeMermaidSvg(entry.svg, entry.cacheId, instanceId),
    };
  }

  if (!entry.promise) {
    const cacheId = entry.cacheId;
    const theme = mermaidThemeFromCacheKey(cacheKey);
    entry.promise = renderMermaidTemplate(chart, cacheId, theme)
      .then((svg) => {
        entry!.svg = svg;
        entry!.promise = undefined;
        rememberMermaidEntry(cacheKey, entry!);
        return svg;
      })
      .catch((err) => {
        entry!.promise = undefined;
        if (!entry!.svg) mermaidSvgCache.delete(cacheKey);
        throw err;
      });
  }

  const templateSvg = await entry.promise;
  return {
    cacheKey,
    svg: materializeMermaidSvg(templateSvg, entry.cacheId, instanceId),
  };
}

async function renderMermaidTemplate(chart: string, id: string, theme: MermaidTheme): Promise<string> {
  const mermaid = (await import("mermaid")).default;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme,
  });
  const result = await mermaid.render(id, chart);
  return result.svg;
}

export function MermaidDiagram({ chart }: { chart: string }) {
  const renderId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const cacheKey = mermaidCacheKey(chart);
  const inlineInstanceId = `saturn-mermaid-${renderId}`;
  const modalInstanceId = `saturn-mermaid-${renderId}-expanded`;
  const [svgState, setSvgState] = useState<MermaidSvgState>(() => ({
    cacheKey,
    svg: cachedMermaidSvg(chart, inlineInstanceId, cacheKey) ?? "",
  }));
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [modalSvg, setModalSvg] = useState("");
  const [modalError, setModalError] = useState<string | null>(null);
  const svg = svgState.cacheKey === cacheKey
    ? svgState.svg
    : cachedMermaidSvg(chart, inlineInstanceId, cacheKey) ?? "";

  useEffect(() => {
    let cancelled = false;
    setError(null);
    const cachedSvg = cachedMermaidSvg(chart, inlineInstanceId, cacheKey);
    if (cachedSvg) {
      setSvgState({ cacheKey, svg: cachedSvg });
      return;
    }
    setSvgState({ cacheKey, svg: "" });

    async function renderMermaid() {
      try {
        const nextSvg = await renderMermaidSvg(chart, inlineInstanceId, cacheKey);
        if (!cancelled) setSvgState(nextSvg);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Unable to render Mermaid diagram.");
        }
      }
    }

    void renderMermaid();
    return () => {
      cancelled = true;
    };
  }, [cacheKey, chart, inlineInstanceId]);

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded]);

  useEffect(() => {
    if (!expanded) {
      setModalSvg("");
      setModalError(null);
      return;
    }

    let cancelled = false;
    setModalError(null);
    const cachedSvg = cachedMermaidSvg(chart, modalInstanceId, cacheKey);
    if (cachedSvg) {
      setModalSvg(cachedSvg);
      return;
    }
    setModalSvg("");

    async function renderExpandedMermaid() {
      try {
        const nextSvg = await renderMermaidSvg(chart, modalInstanceId, cacheKey);
        if (!cancelled) setModalSvg(nextSvg.svg);
      } catch (err) {
        if (!cancelled) {
          setModalError(err instanceof Error ? err.message : "Unable to render Mermaid diagram.");
        }
      }
    }

    void renderExpandedMermaid();
    return () => {
      cancelled = true;
    };
  }, [cacheKey, chart, expanded, modalInstanceId]);

  if (error) {
    return (
      <div className="mermaid-diagram mermaid-diagram-error">
        <div className="mermaid-diagram-error-title">Unable to render Mermaid diagram</div>
        <pre><code>{chart}</code></pre>
        <div className="mermaid-diagram-error-message">{error}</div>
      </div>
    );
  }

  if (!svg) {
    return <div className="mermaid-diagram mermaid-diagram-loading">Rendering diagram...</div>;
  }

  return (
    <>
      <div className="mermaid-diagram-shell">
        <button
          type="button"
          className="mermaid-expand-button"
          aria-label="Expand Mermaid map"
          title="Expand map"
          onClick={() => setExpanded(true)}
        >
          <IconExpand />
        </button>
        <div
          className="mermaid-diagram"
          aria-label="Mermaid diagram"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>

      {expanded && (
        <Portal>
          <div
            className="mermaid-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`mermaid-modal-title-${renderId}`}
          >
            <div
              className="mermaid-modal-backdrop"
              onClick={() => setExpanded(false)}
            />
            <div className="mermaid-modal-panel">
              <div className="mermaid-modal-header">
                <div id={`mermaid-modal-title-${renderId}`} className="mermaid-modal-title">
                  Mermaid map
                </div>
                <button
                  type="button"
                  className="mermaid-modal-close"
                  aria-label="Close Mermaid map"
                  title="Close"
                  onClick={() => setExpanded(false)}
                >
                  <IconClose />
                </button>
              </div>
              <div className="mermaid-modal-body">
                {modalError ? (
                  <div className="mermaid-diagram mermaid-diagram-error">
                    <div className="mermaid-diagram-error-title">Unable to render Mermaid diagram</div>
                    <pre><code>{chart}</code></pre>
                    <div className="mermaid-diagram-error-message">{modalError}</div>
                  </div>
                ) : modalSvg ? (
                  <div
                    className="mermaid-modal-diagram"
                    aria-label="Expanded Mermaid diagram"
                    dangerouslySetInnerHTML={{ __html: modalSvg }}
                  />
                ) : (
                  <div className="mermaid-diagram mermaid-diagram-loading">Rendering diagram...</div>
                )}
              </div>
            </div>
          </div>
        </Portal>
      )}
    </>
  );
}

function IconExpand() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 3H3v5" />
      <path d="M3 3l7 7" />
      <path d="M16 3h5v5" />
      <path d="M21 3l-7 7" />
      <path d="M8 21H3v-5" />
      <path d="M3 21l7-7" />
      <path d="M16 21h5v-5" />
      <path d="M21 21l-7-7" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 6l12 12M6 18 18 6" />
    </svg>
  );
}
