"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { IDisposable } from "@xterm/xterm";
import type { TerminalGroup, TerminalListResponse, TerminalProject, TerminalRecord } from "@/lib/terminal-types";
import { groupTerminalRecords } from "@/lib/terminal-types";

type StreamPayload =
  | { type: "data"; data: string }
  | { type: "meta"; terminal: TerminalRecord }
  | { type: "end"; terminal: TerminalRecord }
  | { type: "error"; message: string };

type WorkspaceProps = {
  initialData: TerminalListResponse;
};

const STATUS_LABEL: Record<TerminalRecord["status"], string> = {
  running: "running",
  success: "done",
  failed: "failed",
};

function statusClass(status: TerminalRecord["status"]): string {
  if (status === "running") return "terminal-status running";
  if (status === "failed") return "terminal-status failed";
  return "terminal-status success";
}

function isDocumentVisible(): boolean {
  return typeof document === "undefined" || document.visibilityState === "visible";
}

function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(isDocumentVisible);

  useEffect(() => {
    const update = () => setVisible(isDocumentVisible());
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  return visible;
}

function sameJsonValue(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function shortPath(path: string | null | undefined): string {
  if (!path) return "No project";
  const parts = path.split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

function upsertTerminal(list: TerminalRecord[], terminal: TerminalRecord): TerminalRecord[] {
  const existing = list.find((item) => item.id === terminal.id);
  if (existing && sameJsonValue(existing, terminal)) return list;

  const next = existing
    ? list.map((item) => item.id === terminal.id ? terminal : item)
    : [terminal, ...list];
  return next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function terminalSubtitle(terminal: TerminalRecord): string {
  if (terminal.source === "pty") return terminal.cwd ?? "Interactive shell";
  return terminal.command ?? "Agent Bash transcript";
}

function terminalProjectPath(terminal: TerminalRecord): string | null {
  return terminal.projectPath?.trim() || terminal.cwd?.trim() || null;
}

function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  return fetch(url, init).then(async (res) => {
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(data?.error ?? `HTTP ${res.status}`);
    }
    return data as T;
  });
}

export function TerminalsWorkspace({ initialData }: WorkspaceProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pageVisible = useDocumentVisible();
  const [allTerminals, setAllTerminals] = useState<TerminalRecord[]>(initialData.terminals);
  const [projects, setProjects] = useState<TerminalProject[]>(initialData.projects ?? []);
  const [totalTerminalCount, setTotalTerminalCount] = useState(
    initialData.totalTerminalCount ?? initialData.terminals.length,
  );
  const [filteredTerminalCount, setFilteredTerminalCount] = useState(
    initialData.filteredTerminalCount ?? initialData.terminals.length,
  );
  const [selectedProjectPath, setSelectedProjectPath] = useState<string | null>(
    searchParams.get("project") || null,
  );
  const [defaultCwd, setDefaultCwd] = useState<string | null>(initialData.defaultCwd);
  const [selectedId, setSelectedId] = useState<string | null>(
    searchParams.get("terminal") ?? initialData.terminals[0]?.id ?? null,
  );
  const [cwdDraft, setCwdDraft] = useState(initialData.defaultCwd ?? initialData.groups[0]?.projectPath ?? "");
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [streamError, setStreamError] = useState<string | null>(null);

  const xtermHostRef = useRef<HTMLDivElement | null>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const dataListenerRef = useRef<IDisposable | null>(null);
  const resizeListenerRef = useRef<IDisposable | null>(null);
  const pendingPtyDataRef = useRef("");

  const filteredTerminals = useMemo(
    () => selectedProjectPath
      ? allTerminals.filter((terminal) => terminalProjectPath(terminal) === selectedProjectPath)
      : allTerminals,
    [allTerminals, selectedProjectPath],
  );
  const groups = useMemo<TerminalGroup[]>(() => groupTerminalRecords(filteredTerminals), [filteredTerminals]);
  const selectedProject = useMemo(
    () => selectedProjectPath ? projects.find((project) => project.path === selectedProjectPath) ?? null : null,
    [projects, selectedProjectPath],
  );
  const selected = useMemo(
    () => filteredTerminals.find((terminal) => terminal.id === selectedId) ?? filteredTerminals[0] ?? null,
    [selectedId, filteredTerminals],
  );
  const activeProjectPath = selectedProjectPath ?? selected?.projectPath ?? groups[0]?.projectPath ?? defaultCwd ?? null;

  const applyTerminalData = useCallback((data: TerminalListResponse, projectPath: string | null) => {
    setAllTerminals((current) => sameJsonValue(current, data.terminals) ? current : data.terminals);
    setProjects((current) => {
      const nextProjects = data.projects ?? [];
      return sameJsonValue(current, nextProjects) ? current : nextProjects;
    });
    setTotalTerminalCount(data.totalTerminalCount ?? data.terminals.length);
    setFilteredTerminalCount(data.filteredTerminalCount ?? data.terminals.length);
    setDefaultCwd(data.defaultCwd);
    setCwdDraft((current) => current || data.defaultCwd || data.groups[0]?.projectPath || "");
    setSelectedId((current) => {
      const visible = projectPath
        ? data.terminals.filter((terminal) => terminalProjectPath(terminal) === projectPath)
        : data.terminals;
      if (current && visible.some((terminal) => terminal.id === current)) return current;
      return visible[0]?.id ?? null;
    });
  }, []);

  const refreshProject = useCallback(async (projectPath: string | null, signal?: AbortSignal) => {
    const params = new URLSearchParams();
    if (projectPath) params.set("project", projectPath);
    const url = params.size > 0 ? `/api/terminals?${params.toString()}` : "/api/terminals";
    const data = await fetchJson<TerminalListResponse>(url, { signal });
    if (signal?.aborted) return;

    applyTerminalData(data, projectPath);
  }, [applyTerminalData]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    await refreshProject(selectedProjectPath, signal);
  }, [refreshProject, selectedProjectPath]);

  useEffect(() => {
    const id = searchParams.get("terminal");
    const project = searchParams.get("project");
    setSelectedProjectPath(project || null);
    if (id) setSelectedId(id);
  }, [searchParams]);

  useEffect(() => {
    if (!pageVisible) return;

    const controller = new AbortController();
    let inFlight = false;
    const poll = () => {
      if (inFlight || controller.signal.aborted) return;
      inFlight = true;
      refresh(controller.signal)
        .catch(() => {})
        .finally(() => {
          inFlight = false;
        });
    };

    poll();
    const timer = window.setInterval(poll, 5000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [pageVisible, refresh]);

  const selectTerminal = useCallback((terminal: TerminalRecord) => {
    setSelectedId(terminal.id);
    setCwdDraft(terminal.projectPath ?? terminal.cwd ?? defaultCwd ?? "");
    const params = new URLSearchParams();
    params.set("terminal", terminal.id);
    if (selectedProjectPath) params.set("project", selectedProjectPath);
    router.replace(`/terminals?${params.toString()}`, { scroll: false });
  }, [defaultCwd, router, selectedProjectPath]);

  const selectProject = useCallback((path: string | null) => {
    setSelectedProjectPath(path);
    setCwdDraft(path ?? defaultCwd ?? "");
    const visible = path
      ? allTerminals.filter((terminal) => terminalProjectPath(terminal) === path)
      : allTerminals;
    const nextTerminal = visible[0] ?? null;
    setSelectedId(nextTerminal?.id ?? null);

    const params = new URLSearchParams();
    if (path) params.set("project", path);
    if (nextTerminal) params.set("terminal", nextTerminal.id);
    router.replace(params.size > 0 ? `/terminals?${params.toString()}` : "/terminals", { scroll: false });
    refreshProject(path).catch(() => {});
  }, [allTerminals, defaultCwd, refreshProject, router]);

  useEffect(() => {
    dataListenerRef.current?.dispose();
    resizeListenerRef.current?.dispose();
    xtermRef.current?.dispose();
    dataListenerRef.current = null;
    resizeListenerRef.current = null;
    xtermRef.current = null;
    fitAddonRef.current = null;
    pendingPtyDataRef.current = "";

    if (!pageVisible || !selected || selected.source !== "pty" || !xtermHostRef.current) return;

    const term = new XTerm({
      cursorBlink: selected.status === "running",
      convertEol: true,
      fontFamily: "var(--font-geist-mono), ui-monospace, SFMono-Regular, Menlo, monospace",
      fontSize: 12,
      lineHeight: 1.18,
      theme: {
        background: "#0b1114",
        foreground: "#d5e5e0",
        cursor: "#6ee7b7",
        selectionBackground: "#2a4b54",
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(xtermHostRef.current);
    fitAddon.fit();
    term.focus();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;
    if (pendingPtyDataRef.current) {
      term.write(pendingPtyDataRef.current);
      pendingPtyDataRef.current = "";
    }

    const postResize = () => {
      const dims = fitAddon.proposeDimensions();
      if (!dims) return;
      fetch(`/api/terminals/${encodeURIComponent(selected.id)}/resize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cols: dims.cols, rows: dims.rows }),
      }).catch(() => {});
    };

    dataListenerRef.current = term.onData((data) => {
      fetch(`/api/terminals/${encodeURIComponent(selected.id)}/input`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data }),
      }).catch(() => {});
    });
    resizeListenerRef.current = term.onResize(({ cols, rows }) => {
      fetch(`/api/terminals/${encodeURIComponent(selected.id)}/resize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cols, rows }),
      }).catch(() => {});
    });

    postResize();
    let resizeFrame: number | null = null;
    const onWindowResize = () => {
      if (resizeFrame !== null) return;
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        fitAddon.fit();
      });
    };
    window.addEventListener("resize", onWindowResize);

    return () => {
      window.removeEventListener("resize", onWindowResize);
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      dataListenerRef.current?.dispose();
      resizeListenerRef.current?.dispose();
      term.dispose();
      dataListenerRef.current = null;
      resizeListenerRef.current = null;
      if (xtermRef.current === term) xtermRef.current = null;
      if (fitAddonRef.current === fitAddon) fitAddonRef.current = null;
    };
  }, [pageVisible, selected?.id, selected?.source]);

  useEffect(() => {
    if (!pageVisible || !selected) return;
    setTranscript("");
    setStreamError(null);
    pendingPtyDataRef.current = "";
    if (selected.source === "pty") xtermRef.current?.reset();

    const source = new EventSource(`/api/terminals/${encodeURIComponent(selected.id)}/stream`);
    source.onmessage = (event) => {
      let payload: StreamPayload;
      try {
        payload = JSON.parse(event.data) as StreamPayload;
      } catch {
        setStreamError("Received malformed terminal stream data.");
        source.close();
        return;
      }
      if (payload.type === "data") {
        if (selected.source === "pty") {
          if (xtermRef.current) xtermRef.current.write(payload.data);
          else pendingPtyDataRef.current += payload.data;
        } else {
          setTranscript((current) => current + payload.data);
        }
      } else if (payload.type === "meta" || payload.type === "end") {
        setAllTerminals((current) => upsertTerminal(current, payload.terminal));
      } else if (payload.type === "error") {
        setStreamError(payload.message);
      }
    };
    source.onerror = () => {
      source.close();
    };

    return () => source.close();
  }, [pageVisible, selected?.id, selected?.source]);

  const createTerminal = async () => {
    const cwd = cwdDraft.trim() || activeProjectPath || defaultCwd || "";
    if (!cwd) {
      setNotice("Choose a working directory first.");
      return;
    }
    setCreating(true);
    setNotice(null);
    try {
      const data = await fetchJson<{ terminal: TerminalRecord }>("/api/terminals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, cols: 100, rows: 28 }),
      });
      setAllTerminals((current) => upsertTerminal(current, data.terminal));
      selectTerminal(data.terminal);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Failed to create terminal.");
    } finally {
      setCreating(false);
    }
  };

  const killTerminal = async () => {
    if (!selected || selected.source !== "pty") return;
    try {
      const data = await fetchJson<{ terminal: TerminalRecord }>(
        `/api/terminals/${encodeURIComponent(selected.id)}`,
        { method: "DELETE" },
      );
      setAllTerminals((current) => current.filter((terminal) => terminal.id !== data.terminal.id));
      setSelectedId((current) => current === data.terminal.id ? filteredTerminals.find((t) => t.id !== data.terminal.id)?.id ?? null : current);
      setNotice("Terminal closed.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Failed to close terminal.");
    }
  };

  return (
    <main className="terminals-page">
      <aside className="terminals-sidebar">
        <div className="terminals-create">
          <div>
            <h1>Terminals</h1>
            <p>Project shells and agent Bash transcripts.</p>
          </div>
          <label className="terminal-cwd-label" htmlFor="terminal-cwd">Working directory</label>
          <input
            id="terminal-cwd"
            className="terminal-cwd-input"
            value={cwdDraft}
            onChange={(event) => setCwdDraft(event.target.value)}
            placeholder={defaultCwd ?? activeProjectPath ?? "/path/to/project"}
          />
          <button
            type="button"
            className="terminal-primary-button"
            onClick={createTerminal}
            disabled={creating}
          >
            {creating ? "Starting..." : "New terminal"}
          </button>
          {notice && <div className="terminal-notice">{notice}</div>}
        </div>

        <div className="terminal-projects">
          <div className="terminal-projects-header">
            <span>Projects</span>
            <span>{projects.length}</span>
          </div>
          <div className="terminal-project-list">
            <button
              type="button"
              className={`terminal-project-row ${selectedProjectPath === null ? "active" : ""}`}
              onClick={() => selectProject(null)}
            >
              <span className="terminal-project-name">All projects</span>
              <span className="terminal-project-count">{totalTerminalCount}</span>
            </button>
            {projects.map((project) => (
              <button
                key={project.path}
                type="button"
                className={`terminal-project-row ${selectedProjectPath === project.path ? "active" : ""}`}
                onClick={() => selectProject(project.path)}
                title={project.path}
              >
                <span className="terminal-project-name">{project.label}</span>
                <span className="terminal-project-count">{project.terminalCount}</span>
                <span className="terminal-project-path">{project.path}</span>
                {project.runningCount > 0 && (
                  <span className="terminal-project-running">{project.runningCount} running</span>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="terminal-groups">
          <div className="terminal-groups-title">
            <span>{selectedProject ? selectedProject.label : "All terminals"}</span>
            <span>{selectedProject ? filteredTerminalCount : totalTerminalCount}</span>
          </div>
          {groups.length === 0 ? (
            <div className="terminal-empty-list">
              No terminals{selectedProject ? " for this project" : ""} yet.
            </div>
          ) : (
            groups.map((group) => (
              <section key={group.key} className="terminal-group">
                <div className="terminal-group-header" title={group.projectPath ?? undefined}>
                  <span className="terminal-project-dot" />
                  <span>{group.label}</span>
                  <span>{group.terminals.length}</span>
                </div>
                <div className="terminal-list">
                  {group.terminals.map((terminal) => (
                    <button
                      key={terminal.id}
                      type="button"
                      className={`terminal-row ${selected?.id === terminal.id ? "active" : ""}`}
                      onClick={() => selectTerminal(terminal)}
                    >
                      <div className="terminal-row-top">
                        <span className="terminal-row-title">{terminal.title}</span>
                        <span className={statusClass(terminal.status)}>{STATUS_LABEL[terminal.status]}</span>
                      </div>
                      <div className="terminal-row-bottom">
                        <span>{terminal.source === "pty" ? "shell" : "agent Bash"}</span>
                        <span>{shortPath(terminal.cwd)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      </aside>

      <section className="terminal-main">
        {!selected ? (
          <div className="terminal-empty-main">
            <h2>No terminal selected</h2>
            <p>Create a terminal or run an agent Bash command to see it here.</p>
          </div>
        ) : (
          <>
            <header className="terminal-main-header">
              <div className="terminal-title-block">
                <div className="terminal-title-line">
                  <h2>{selected.title}</h2>
                  <span className={statusClass(selected.status)}>{STATUS_LABEL[selected.status]}</span>
                  {selected.readOnly && <span className="terminal-readonly">read-only</span>}
                </div>
                <p title={terminalSubtitle(selected)}>{terminalSubtitle(selected)}</p>
              </div>
              <div className="terminal-actions">
                <button type="button" className="terminal-secondary-button" onClick={() => refresh().catch(() => {})}>
                  Refresh
                </button>
                {selected.source === "pty" && (
                  <button type="button" className="terminal-danger-button" onClick={killTerminal}>
                    Close
                  </button>
                )}
              </div>
            </header>

            {streamError && <div className="terminal-stream-error">{streamError}</div>}

            {selected.source === "pty" ? (
              <div className="terminal-xterm-shell">
                <div ref={xtermHostRef} className="terminal-xterm-host" />
              </div>
            ) : (
              <pre className="terminal-transcript" aria-label="Agent Bash transcript">
                {transcript || "$ loading transcript...\n"}
              </pre>
            )}
          </>
        )}
      </section>
    </main>
  );
}
