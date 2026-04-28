"use client";

import { useEffect, useState, useCallback } from "react";
import type { BundledLanguage } from "shiki";

type Props = {
  filePath: string;
  sessionId: string;
  onClose: () => void;
};

type FileState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ok"; html: string; truncated: boolean; size: number };

const EXT_TO_LANG: Record<string, BundledLanguage> = {
  ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
  py: "python", rb: "ruby", go: "go", rs: "rust", java: "java",
  c: "c", cpp: "cpp", cs: "csharp", php: "php", swift: "swift",
  kt: "kotlin", scala: "scala", sh: "bash", zsh: "bash", bash: "bash",
  fish: "fish", ps1: "powershell", json: "json", jsonc: "jsonc",
  yaml: "yaml", yml: "yaml", toml: "toml", xml: "xml", html: "html",
  css: "css", scss: "scss", sass: "sass", less: "less", sql: "sql",
  graphql: "graphql", gql: "graphql", md: "markdown", mdx: "mdx",
  vue: "vue", svelte: "svelte", r: "r", lua: "lua", ex: "elixir",
  exs: "elixir", clj: "clojure", hs: "haskell", ml: "ocaml",
  tf: "hcl", dockerfile: "dockerfile", prisma: "prisma",
};

function extOf(p: string): string {
  const base = p.split("/").pop() ?? p;
  if (base.toLowerCase() === "dockerfile") return "dockerfile";
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function langOf(p: string): BundledLanguage {
  return EXT_TO_LANG[extOf(p)] ?? "plaintext";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function highlight(code: string, lang: BundledLanguage, theme: "dark" | "light"): Promise<string> {
  const { codeToHtml } = await import("shiki");
  // Shiki renders static pre/code/span markup — no user-controlled input reaches this call.
  // The `code` string comes from reading a local file on the server, returned as JSON text.
  return codeToHtml(code, {
    lang,
    theme: theme === "dark" ? "github-dark-dimmed" : "github-light",
  });
}

function getTheme(): "dark" | "light" {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

export function FileViewer({ filePath, sessionId, onClose }: Props) {
  const [state, setState] = useState<FileState>({ status: "loading" });

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/file-content?path=${encodeURIComponent(filePath)}`
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "failed" })) as { error?: string };
        setState({ status: "error", message: err.error ?? `HTTP ${res.status}` });
        return;
      }
      const data = await res.json() as { content: string; truncated: boolean; size: number };
      const lang = langOf(filePath);
      const theme = getTheme();
      const html = await highlight(data.content, lang, theme);
      setState({ status: "ok", html, truncated: data.truncated, size: data.size });
    } catch (e) {
      setState({ status: "error", message: e instanceof Error ? e.message : "unknown error" });
    }
  }, [filePath, sessionId]);

  useEffect(() => { load(); }, [load]);

  const parts = filePath.split("/");
  const fileName = parts.pop() ?? filePath;
  const dirPart = parts.join("/");

  return (
    <div className="file-viewer">
      <div className="file-viewer-header">
        <button
          type="button"
          className="file-viewer-back"
          onClick={onClose}
          aria-label="Back to file list"
          title="Back"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 5l-7 7 7 7" />
          </svg>
        </button>
        <div className="file-viewer-title">
          <span className="file-viewer-filename">{fileName}</span>
          {dirPart && <span className="file-viewer-dir">{dirPart}</span>}
        </div>
        {state.status === "ok" && (
          <span className="file-viewer-meta">
            {formatBytes(state.size)}{state.truncated && " · truncated"}
          </span>
        )}
      </div>

      <div className="file-viewer-body">
        {state.status === "loading" && (
          <div className="file-viewer-status">
            <svg className="animate-spin" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" strokeOpacity="0.2"/>
              <path d="M21 12a9 9 0 00-9-9"/>
            </svg>
            Loading…
          </div>
        )}
        {state.status === "error" && (
          <div className="file-viewer-status file-viewer-err">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            {state.message}
          </div>
        )}
        {state.status === "ok" && (
          /* Shiki output: static pre/code/span with inline styles — no user script content */
          /* eslint-disable-next-line react/no-danger */
          <div className="file-viewer-code" dangerouslySetInnerHTML={{ __html: state.html }} />
        )}
      </div>
    </div>
  );
}
