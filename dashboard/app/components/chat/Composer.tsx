"use client";

import {
  forwardRef, useCallback, useEffect, useImperativeHandle,
  useRef, useState,
} from "react";
import type { CLI } from "@/lib/runs";
import type { Model } from "@/lib/models";
import {
  formatModelOption,
  formatReasoningEffort,
  normalizeReasoningEffortForCli,
  reasoningEffortOptionsForCli,
  type ModelReasoningEffort,
} from "@/lib/models";
import type { SlashCommand } from "@/app/api/slash-commands/route";
import { CLI_SHORT_LABELS, CLI_VALUES, normalizeCli } from "@/lib/clis";

type Props = {
  currentCli: CLI;
  currentModel?: string;
  currentReasoningEffort?: ModelReasoningEffort;
  currentMcpTools?: boolean;
  availableClis?: CLI[];
  agentCliModels?: Partial<Record<CLI, string>>;
  agentCliReasoningEfforts?: Partial<Record<CLI, ModelReasoningEffort>>;
  disabled?: boolean;
  onSend: (msg: string, cli: CLI, model?: string, mcpTools?: boolean, reasoningEffort?: ModelReasoningEffort) => void;
  onStop?: () => void;
  placeholder?: string;
  /** "sticky" (default) pins to bottom with gradient; "inline" renders without sticky wrapper */
  variant?: "sticky" | "inline";
  sendLabel?: string;
  header?: React.ReactNode;
  /** If provided, enables attachment upload (drag/drop, paste, file picker) against this session */
  sessionId?: string;
  attachmentsEnabled?: boolean;
  /** Working directory for this session — displayed in the toolbar */
  cwd?: string;
};

type Attachment = {
  localId: string;
  name: string;
  size: number;
  type: string;
  uploading: boolean;
  error?: string;
  /** absolute path on disk once upload finishes */
  path?: string;
  /** object URL for image preview */
  previewUrl?: string;
  /** original File object — kept for deferred upload when no sessionId at drop time */
  file?: File;
};

type QueuedMessage = {
  text: string;
  cli: CLI;
  model?: string;
  mcpTools?: boolean;
  reasoningEffort?: ModelReasoningEffort;
};

function readQueuedMessages(queueStorageKey: string | null): QueuedMessage[] {
  if (!queueStorageKey || typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(queueStorageKey) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed as QueuedMessage[] : [];
  } catch {
    return [];
  }
}

export type ComposerHandle = {
  focus: () => void;
  setDraft: (text: string) => void;
  insertText: (text: string) => void;
  /** Returns files queued locally when no sessionId was provided at drop time */
  getPendingFiles: () => File[];
  clearPendingFiles: () => void;
};

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  { currentCli, currentModel, currentReasoningEffort, currentMcpTools, availableClis, agentCliModels, agentCliReasoningEfforts, disabled, onSend, onStop, placeholder, variant = "sticky", sendLabel, header, sessionId, attachmentsEnabled = true, cwd },
  ref
) {
  const storageKey = sessionId ? `composer:${sessionId}` : null;
  const queueStorageKey = sessionId ? `composer-queue:${sessionId}` : null;

  const [loadedPrefs, setLoadedPrefs] = useState<{
    cli?: CLI;
    model?: string;
    mcpTools?: boolean;
    reasoningEffort?: ModelReasoningEffort;
  } | null>(null);

  const [message, setMessage] = useState("");
  const [cli, setCli] = useState<CLI>(normalizeCli(currentCli));
  const [model, setModel] = useState<string>(currentModel ?? "");
  const [reasoningEffort, setReasoningEffort] = useState<ModelReasoningEffort | "">(
    currentReasoningEffort ?? ""
  );
  const [mcpTools, setMcpTools] = useState<boolean>(currentMcpTools ?? false);
  const [models, setModels] = useState<Model[]>([]);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashIdx, setSlashIdx] = useState(0);
  const [cliPickerOpen, setCliPickerOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const cliPickerRef = useRef<HTMLDivElement>(null);
  const overflowRef = useRef<HTMLDivElement>(null);
  const initialQueueRef = useRef<QueuedMessage[] | null>(null);
  if (initialQueueRef.current === null) {
    initialQueueRef.current = readQueuedMessages(queueStorageKey);
  }
  const [queued, setQueued] = useState<QueuedMessage[]>(() => initialQueueRef.current ?? []);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const attachmentsRef = useRef<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [sttSupported, setSttSupported] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const slashRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const onSendRef = useRef(onSend);
  // If we restored queued messages, pretend we were previously disabled so the
  // release effect fires immediately when disabled is false on mount.
  const prevDisabledRef = useRef((initialQueueRef.current?.length ?? 0) > 0 ? true : Boolean(disabled));
  const prevSessionIdRef = useRef(sessionId);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [waveformBars, setWaveformBars] = useState<number[]>(() => Array(20).fill(2));
  const recordingNonceRef = useRef(0);
  const didUserChoose = useRef(false);
  const selectableClis = availableClis?.length ? availableClis : CLI_VALUES;

  useEffect(() => {
    setSttSupported("SpeechRecognition" in window || "webkitSpeechRecognition" in window);
  }, []);

  useEffect(() => {
    const close = (e: MouseEvent) => {
      if (cliPickerRef.current && !cliPickerRef.current.contains(e.target as Node)) setCliPickerOpen(false);
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) setOverflowOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  useEffect(() => {
    onSendRef.current = onSend;
  }, [onSend]);

  // Persist queue to sessionStorage so it survives page refresh
  useEffect(() => {
    if (!queueStorageKey) return;
    if (queued.length === 0) sessionStorage.removeItem(queueStorageKey);
    else sessionStorage.setItem(queueStorageKey, JSON.stringify(queued));
  }, [queued, queueStorageKey]);

  useEffect(() => {
    if (prevSessionIdRef.current === sessionId) return;
    prevSessionIdRef.current = sessionId;
    attachmentsRef.current.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
    setQueued([]);
    setMessage("");
    setAttachments([]);
    setSlashOpen(false);
    setSlashQuery("");
  }, [sessionId]);

  useEffect(() => {
    if (!storageKey) return;
    let prefs: typeof loadedPrefs = null;
    try {
      prefs = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    } catch {
      prefs = null;
    }
    setLoadedPrefs(prefs);
    if (!prefs) return;
    didUserChoose.current = true;
    if (prefs.cli) setCli(normalizeCli(prefs.cli));
    if (prefs.model) setModel(prefs.model);
    if (prefs.reasoningEffort) setReasoningEffort(prefs.reasoningEffort);
    if (typeof prefs.mcpTools === "boolean") setMcpTools(prefs.mcpTools);
  }, [storageKey]);

  // Persist cli/model/mcpTools/reasoningEffort to localStorage whenever they change
  useEffect(() => {
    if (!storageKey) return;
    localStorage.setItem(storageKey, JSON.stringify({ cli, model, mcpTools, reasoningEffort: reasoningEffort || undefined }));
  }, [cli, model, mcpTools, reasoningEffort, storageKey]);

  // Sync cli/model from parent when they arrive (e.g. first turn completes and meta updates)
  // Only update if user hasn't already made an explicit choice this session
  useEffect(() => {
    if (didUserChoose.current || loadedPrefs) return;
    if (currentCli) setCli(normalizeCli(currentCli));
    if (currentModel) setModel(currentModel);
    if (currentReasoningEffort) setReasoningEffort(currentReasoningEffort);
    if (typeof currentMcpTools === "boolean") setMcpTools(currentMcpTools);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCli, currentModel, currentReasoningEffort, currentMcpTools]);

  useEffect(() => {
    if (selectableClis.includes(cli)) return;
    const nextCli = selectableClis[0] ?? normalizeCli(currentCli);
    setCli(nextCli);
    if (agentCliModels?.[nextCli]) setModel(agentCliModels[nextCli]!);
    if (agentCliReasoningEfforts?.[nextCli]) setReasoningEffort(agentCliReasoningEfforts[nextCli]!);
  }, [agentCliModels, agentCliReasoningEfforts, cli, currentCli, selectableClis]);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  // Revoke object URLs when attachments unmount
  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
    };
  }, []);

  const uploadsEnabled = attachmentsEnabled && Boolean(sessionId);

  const uploadFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    if (!sessionId) {
      // No session yet — hold files locally so the chip UI renders; parent grabs them via ref on submit
      setAttachments((prev) => [
        ...prev,
        ...files.map((f) => ({
          localId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: f.name,
          size: f.size,
          type: f.type,
          uploading: false,
          previewUrl: f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined,
          file: f,
        })),
      ]);
      return;
    }
    const draftAttachments: Attachment[] = files.map((f) => ({
      localId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: f.name,
      size: f.size,
      type: f.type,
      uploading: true,
      previewUrl: f.type.startsWith("image/") ? URL.createObjectURL(f) : undefined,
    }));
    setAttachments((prev) => [...prev, ...draftAttachments]);

    const form = new FormData();
    files.forEach((f) => form.append("files", f));
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/uploads`, {
        method: "POST",
        body: form,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "upload failed");
      const saved: { name: string; path: string; size: number; type: string }[] = data.files ?? [];
      setAttachments((prev) => {
        // Match each draft (in order) to the saved paths
        const draftIds = draftAttachments.map((d) => d.localId);
        return prev.map((a) => {
          const idx = draftIds.indexOf(a.localId);
          if (idx < 0 || !saved[idx]) return a;
          return { ...a, uploading: false, path: saved[idx].path };
        });
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "upload failed";
      setAttachments((prev) =>
        prev.map((a) =>
          draftAttachments.find((d) => d.localId === a.localId)
            ? { ...a, uploading: false, error: msg }
            : a
        )
      );
    }
  }, [sessionId]);

  const removeAttachment = (localId: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.localId === localId);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((a) => a.localId !== localId);
    });
  };

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    setDraft: (text: string) => {
      setMessage(text);
      setTimeout(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(text.length, text.length);
      }, 0);
    },
    insertText: (text: string) => {
      setMessage((current) => {
        const el = textareaRef.current;
        const start = el?.selectionStart ?? current.length;
        const end = el?.selectionEnd ?? start;
        const needsLeadBreak = current.trim() && start > 0 && !current.slice(0, start).endsWith("\n");
        const insert = `${needsLeadBreak ? "\n\n" : ""}${text}`;
        const next = `${current.slice(0, start)}${insert}${current.slice(end)}`;
        const cursor = start + insert.length;
        setTimeout(() => {
          textareaRef.current?.focus();
          textareaRef.current?.setSelectionRange(cursor, cursor);
        }, 0);
        return next;
      });
    },
    getPendingFiles: () => attachments.filter((a) => a.file && !a.error).map((a) => a.file!),
    clearPendingFiles: () => setAttachments((prev) => prev.filter((a) => !a.file)),
  }));

  const handleCliChange = (newCli: CLI) => {
    didUserChoose.current = true;
    setCli(newCli);
    if (agentCliModels?.[newCli]) {
      setModel(agentCliModels[newCli]!);
    }
    if (agentCliReasoningEfforts?.[newCli]) {
      setReasoningEffort(agentCliReasoningEfforts[newCli]!);
    }
  };

  // Fetch models when CLI changes; auto-select first if current model isn't in list
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/models?cli=${cli}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        const list: Model[] = data.models ?? [];
        setModels(list);
        if (list.length > 0 && (!model || !list.find((m) => m.id === model))) {
          setModel(list[0].id);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cli]);

  // Fetch slash commands when CLI changes
  useEffect(() => {
    fetch(`/api/slash-commands?cli=${cli}`)
      .then((r) => r.json())
      .then((data) => setCommands(data.commands ?? []))
      .catch(() => {});
  }, [cli]);

  useEffect(() => {
    if (!reasoningEffort) return;
    const selected = models.find((m) => m.id === model);
    const normalized = normalizeReasoningEffortForCli(cli, reasoningEffort);
    const available = reasoningEffortOptionsForCli(cli, selected).map((option) => option.value);
    if (!normalized || normalized !== reasoningEffort || !available.includes(normalized)) {
      setReasoningEffort(normalized && available.includes(normalized) ? normalized : "");
    }
  }, [cli, model, models, reasoningEffort]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [message]);

  // Filtered slash commands
  const filteredCommands = slashQuery
    ? commands.filter(
        (c) =>
          c.name.includes(slashQuery.toLowerCase()) ||
          c.description.toLowerCase().includes(slashQuery.toLowerCase())
      )
    : commands;

  const openClaudePersonalLogin = useCallback(async () => {
    setNotice(null);
    try {
      const res = await fetch("/api/claude-personal/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "claudeai" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "failed to open Claude login");
      setNotice("Claude login opened in Terminal.");
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "failed to open Claude login");
    }
  }, []);

  const applyCommand = useCallback(
    (cmd: SlashCommand) => {
      if (cmd.action === "claude-personal-login") {
        setMessage("/login");
        setSlashOpen(false);
        setSlashQuery("");
        setTimeout(() => textareaRef.current?.focus(), 0);
        return;
      }

      if (cmd.transform === "replace") {
        setMessage(cmd.instruction);
      } else if (cmd.transform === "literal") {
        const afterSlash = message.replace(/^\/\S*\s*/, "").trimStart();
        setMessage(afterSlash ? `${cmd.instruction} ${afterSlash}` : cmd.instruction);
      } else {
        // "prefix" — keep any text after the /command token
        const afterSlash = message.replace(/^\/\S*\s*/, "");
        setMessage(cmd.instruction + afterSlash);
      }
      setSlashOpen(false);
      setSlashQuery("");
      setTimeout(() => {
        const el = textareaRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        }
      }, 0);
    },
    [message]
  );

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setMessage(val);

    // Detect slash command trigger: starts with / and cursor is right after
    const cursor = e.target.selectionStart ?? 0;
    const textBefore = val.slice(0, cursor);
    const slashMatch = textBefore.match(/(?:^|\n)\/([\w-]*)$/);
    if (slashMatch) {
      setSlashQuery(slashMatch[1]);
      setSlashOpen(true);
      setSlashIdx(0);
    } else {
      setSlashOpen(false);
      setSlashQuery("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Slash menu navigation
    if (slashOpen && filteredCommands.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIdx((i) => Math.min(i + 1, filteredCommands.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        applyCommand(filteredCommands[slashIdx]);
        return;
      }
      if (e.key === "Escape") {
        setSlashOpen(false);
        return;
      }
    }

    // Enter sends; Shift+Enter inserts a newline. Ignore IME composition.
    const composing = (e.nativeEvent as KeyboardEvent).isComposing;
    if (e.key === "Enter" && !e.shiftKey && !composing) {
      e.preventDefault();
      submit();
    }
  };

  const buildMessageWithAttachments = (base: string): string => {
    const ready = attachments.filter((a) => a.path && !a.error);
    if (ready.length === 0) return base;
    const lines = ready.map((a) => `- ${a.path}  (${a.name})`);
    return `${base}\n\n[Attached files — read them with the Read tool]\n${lines.join("\n")}`;
  };

  const anyUploading = attachments.some((a) => a.uploading);

  const submit = () => {
    const trimmed = message.trim();
    if (!trimmed && attachments.filter((a) => !a.error).length === 0) return;
    if (anyUploading) return;
    if (trimmed === "/login") {
      if (cli === "claude-personal") {
        void openClaudePersonalLogin();
        setMessage("");
        setSlashOpen(false);
        return;
      }
      setNotice("Switch to Personal to use /login.");
      return;
    }
    const full = buildMessageWithAttachments(trimmed);
    if (disabled) {
      setQueued((prev) => [...prev, {
        text: full,
        cli,
        model: model || undefined,
        mcpTools: cli === "claude-local" ? mcpTools : undefined,
        reasoningEffort: reasoningEffort || undefined,
      }]);
    } else {
      onSend(
        full,
        cli,
        model || undefined,
        cli === "claude-local" ? mcpTools : undefined,
        reasoningEffort || undefined,
      );
    }
    setMessage("");
    setNotice(null);
    setSlashOpen(false);
    // Clean up previews and clear attachments — they're now part of the sent message.
    attachments.forEach((a) => a.previewUrl && URL.revokeObjectURL(a.previewUrl));
    setAttachments([]);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  };

  const removeQueued = (index: number) => {
    setQueued((prev) => prev.filter((_, i) => i !== index));
  };

  const steerWithQueued = (index: number) => {
    setQueued((prev) => {
      const item = prev[index];
      if (!item) return prev;
      return [item, ...prev.filter((_, i) => i !== index)];
    });
    onStop?.();
  };

  // When the current turn finishes, release the next queued message.
  useEffect(() => {
    const wasDisabled = prevDisabledRef.current;
    prevDisabledRef.current = Boolean(disabled);
    if (!disabled && wasDisabled && queued.length > 0) {
      const [next, ...rest] = queued;
      setQueued(rest);
      onSendRef.current(next.text, next.cli, next.model, next.mcpTools, next.reasoningEffort);
    }
  }, [disabled, queued]);

  const stopAudioAnalysis = useCallback(() => {
    recordingNonceRef.current = 0;
    if (animFrameRef.current !== null) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    audioContextRef.current?.close();
    audioContextRef.current = null;
    analyserRef.current = null;
    setWaveformBars(Array(20).fill(2));
  }, []);

  // Stop recognition when the component unmounts
  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
      stopAudioAnalysis();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleSTT = useCallback(() => {
    if (isRecording) {
      recognitionRef.current?.stop();
      setIsRecording(false);
      stopAudioAnalysis();
      return;
    }
    // Guard against double-click / stale onend orphaning sessions
    if (recognitionRef.current) {
      recognitionRef.current.onend = null;
      recognitionRef.current.onerror = null;
      recognitionRef.current.stop();
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SpeechRecognitionCtor: any =
      (typeof window !== "undefined" && ((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition));
    if (!SpeechRecognitionCtor) return;
    const recognition = new SpeechRecognitionCtor();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (event: any) => {
      const transcript: string = event.results[0]?.[0]?.transcript ?? "";
      if (transcript) {
        setMessage((prev) => (prev ? prev + " " + transcript : transcript));
      }
    };
    recognition.onerror = (e: SpeechRecognitionErrorEvent) => {
      stopAudioAnalysis();
      setIsRecording(false);
      recognitionRef.current = null;
      if ((e as any).error === 'not-allowed') {
        setMessage((prev) => prev ? prev : "[Microphone access denied]");
      }
    };
    recognition.onend = () => {
      stopAudioAnalysis();
      setIsRecording(false);
    };
    recognitionRef.current = recognition;
    setIsRecording(true);
    try {
      recognition.start();
    } catch {
      setIsRecording(false);
      recognitionRef.current = null;
      return;
    }

    recordingNonceRef.current += 1;
    const myNonce = recordingNonceRef.current;
    const startAudioAnalysis = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (recordingNonceRef.current !== myNonce) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const ctx = new AudioContext();
        await ctx.resume();
        audioContextRef.current = ctx;
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 64;
        source.connect(analyser);
        analyserRef.current = analyser;

        const dataArray = new Uint8Array(analyser.frequencyBinCount); // 32 bins
        const tick = () => {
          analyser.getByteFrequencyData(dataArray);
          // Sample 20 evenly-spaced bins from the 32 available
          const bars = Array.from({ length: 20 }, (_, i) => {
            const bin = Math.floor((i / 20) * dataArray.length);
            return Math.max(2, (dataArray[bin] / 255) * 24);
          });
          setWaveformBars(bars);
          animFrameRef.current = requestAnimationFrame(tick);
        };
        animFrameRef.current = requestAnimationFrame(tick);
      } catch {
        // getUserMedia failed — waveform won't show but STT still works
      }
    };
    startAudioAnalysis();
  }, [isRecording, stopAudioAnalysis]);

  const readyAttachmentCount = attachments.filter((a) => (a.path || a.file) && !a.error).length;
  const canSend = (!!message.trim() || readyAttachmentCount > 0) && !anyUploading;

  const inner = (
    <div
      className="relative rounded-2xl border border-border overflow-visible"
      style={{ background: "var(--bg-elev)", boxShadow: "var(--shadow-lg)" }}
    >
        {/* Slash command popup */}
        {slashOpen && filteredCommands.length > 0 && (
          <div
            ref={slashRef}
            className="absolute bottom-full left-0 right-0 mb-2 rounded-xl border border-border overflow-hidden"
            style={{
              background: "var(--bg-elev)",
              boxShadow: "var(--shadow-lg)",
              maxHeight: 320,
            }}
          >
            <div className="px-3 pt-2 pb-1 text-[10px] text-subtle uppercase tracking-wider border-b border-border">
              Commands
            </div>
            <div className="overflow-y-auto" style={{ maxHeight: 272 }}>
              {filteredCommands.map((cmd, i) => (
                <button
                  key={cmd.name}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applyCommand(cmd);
                  }}
                  className={[
                    "w-full text-left px-3 py-2 flex items-start gap-3 transition-colors",
                    i === slashIdx ? "bg-bg-hover" : "hover:bg-bg-hover",
                  ].join(" ")}
                >
                  <span
                    className="shrink-0 mt-0.5 px-1.5 py-0.5 rounded text-[10px] font-mono font-medium"
                    style={{
                      background: cmd.kind === "skill"
                        ? "color-mix(in srgb, var(--success) 15%, transparent)"
                        : "var(--accent-soft)",
                      color: cmd.kind === "skill"
                        ? "var(--success)"
                        : "var(--accent)",
                    }}
                  >
                    {cmd.label}
                  </span>
                  <span className="flex flex-col min-w-0">
                    <span className="text-[12px] text-fg font-medium truncate">{cmd.label.slice(1)}</span>
                    <span className="text-[11px] text-muted leading-snug line-clamp-2">{cmd.description}</span>
                  </span>
                </button>
              ))}
            </div>
            <div className="px-3 py-1.5 border-t border-border flex items-center gap-3 text-[10px] text-subtle">
              <span>↑↓ navigate</span>
              <span>↵ / Tab apply</span>
              <span>Esc close</span>
            </div>
          </div>
        )}

        {/* Attachment chips */}
        {attachments.length > 0 && (
          <div className="px-4 pt-3 flex flex-wrap gap-2">
            {attachments.map((a) => (
              <div
                key={a.localId}
                className={[
                  "group relative flex items-center gap-2 pl-2 pr-6 py-1 rounded-lg border text-[11px]",
                  a.error ? "border-fail/40 bg-fail/10" : "border-border bg-bg-subtle",
                ].join(" ")}
                title={a.error ?? a.path ?? a.name}
              >
                {a.previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={a.previewUrl} alt={a.name} className="w-6 h-6 rounded object-cover" />
                ) : (
                  <svg className="w-3.5 h-3.5 text-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                  </svg>
                )}
                <span className="max-w-[160px] truncate">{a.name}</span>
                {a.uploading && (
                  <svg className="animate-spin w-3 h-3 text-subtle" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                )}
                {a.error && <span className="text-fail text-[10px]">failed</span>}
                <button
                  type="button"
                  onClick={() => removeAttachment(a.localId)}
                  aria-label="Remove attachment"
                  className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-bg-hover text-subtle hover:text-fg"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Textarea */}
        <div
          className={[
            "px-4 pt-3 pb-2 relative",
            dragOver && uploadsEnabled ? "ring-2 ring-accent rounded-lg" : "",
          ].join(" ")}
          onDragOver={(e) => {
            if (!uploadsEnabled) return;
            if (e.dataTransfer.types.includes("Files")) {
              e.preventDefault();
              setDragOver(true);
            }
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            if (!uploadsEnabled) return;
            const files = Array.from(e.dataTransfer.files ?? []);
            if (files.length === 0) return;
            e.preventDefault();
            setDragOver(false);
            uploadFiles(files);
          }}
        >
          {dragOver && uploadsEnabled && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none rounded-lg bg-accent/10 text-accent text-[13px] font-medium">
              Drop to attach
            </div>
          )}
          <textarea
            ref={textareaRef}
            value={message}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            onPaste={(e) => {
              if (!uploadsEnabled) return;
              const files = Array.from(e.clipboardData.files ?? []);
              if (files.length === 0) return;
              e.preventDefault();
              uploadFiles(files);
            }}
            placeholder={placeholder ?? (disabled ? "Type a follow-up… (sends when reply completes)" : "Message… (/ for commands)")}
            rows={variant === "inline" ? 4 : 2}
            className="w-full resize-none bg-transparent text-[14px] text-fg placeholder:text-subtle focus:outline-none leading-relaxed"
            style={{ minHeight: variant === "inline" ? "120px" : "52px", maxHeight: "320px" }}
          />
        </div>

        {notice && (
          <div className="px-4 pb-2 text-[12px] text-subtle" aria-live="polite">
            {notice}
          </div>
        )}

        {/* Toolbar footer */}
        <div className="flex items-center gap-1 px-3 py-2 border-t border-border">
          {/* CLI pills */}
          {/* CLI picker — single active pill + popover */}
          <div className="relative" ref={cliPickerRef}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => setCliPickerOpen((o) => !o)}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-medium bg-accent text-white disabled:opacity-40 transition-all"
              title="Switch CLI"
            >
              {CLI_SHORT_LABELS[cli]}
              <svg className="w-2.5 h-2.5 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {cliPickerOpen && (
              <div className="absolute bottom-full left-0 mb-1 z-50 min-w-[110px] rounded-lg border border-border bg-bg shadow-lg py-1">
                {selectableClis.map((c) => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => { handleCliChange(c); setCliPickerOpen(false); }}
                    className={[
                      "w-full text-left px-3 py-1.5 text-[12px] transition-colors",
                      cli === c ? "text-accent font-medium" : "text-fg hover:bg-bg-hover",
                    ].join(" ")}
                  >
                    {CLI_SHORT_LABELS[c]}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="h-3.5 w-px bg-border mx-1.5" />

          {/* Model dropdown */}
          <div className="relative flex items-center min-w-0 max-w-[130px]" title={models.find((m) => m.id === model) ? formatModelOption(models.find((m) => m.id === model)!) : model}>
            <select
              value={model}
              onChange={(e) => { didUserChoose.current = true; setModel(e.target.value); }}
              disabled={disabled}
              className="appearance-none bg-transparent text-[11px] text-muted hover:text-fg cursor-pointer pr-4 py-1 rounded transition-colors focus:outline-none disabled:opacity-40 truncate max-w-full"
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {formatModelOption(m)}
                </option>
              ))}
            </select>
            <svg className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 text-subtle" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </div>

          <div className="h-3.5 w-px bg-border mx-1.5" />

          {/* Reasoning effort dropdown */}
          <div className="relative flex items-center min-w-0 max-w-[100px]" title={`Reasoning: ${formatReasoningEffort(reasoningEffort || undefined)}`}>
            <select
              value={reasoningEffort}
              onChange={(e) => {
                didUserChoose.current = true;
                setReasoningEffort(e.target.value as ModelReasoningEffort | "");
              }}
              disabled={disabled}
              className="appearance-none bg-transparent text-[11px] text-muted hover:text-fg cursor-pointer pr-4 py-1 rounded transition-colors focus:outline-none disabled:opacity-40 truncate max-w-full"
            >
              <option value="">Effort</option>
              {reasoningEffortOptionsForCli(cli, models.find((m) => m.id === model)).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            <svg className="pointer-events-none absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 text-subtle" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </div>

          <div className="flex-1" />

          {/* Always-visible: attach + dictate icon buttons */}
          {uploadsEnabled && (
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length > 0) uploadFiles(files);
                e.target.value = "";
              }}
            />
          )}
          {uploadsEnabled && (
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center justify-center w-7 h-7 rounded-lg text-muted hover:text-fg hover:bg-bg-hover transition-colors"
              title="Attach files (or drag/drop/paste)"
              aria-label="Attach files"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
              </svg>
            </button>
          )}
          {sttSupported && (
            <button
              type="button"
              onClick={toggleSTT}
              className={[
                "flex items-center gap-1 w-7 h-7 justify-center rounded-lg transition-colors",
                isRecording ? "text-[var(--fail)] hover:bg-bg-hover" : "text-muted hover:text-fg hover:bg-bg-hover",
              ].join(" ")}
              title={isRecording ? "Stop recording" : "Dictate (speech to text)"}
              aria-label={isRecording ? "Stop recording" : "Dictate"}
            >
              {isRecording ? (
                <span className="flex items-end gap-px" style={{ width: 18, height: 14 }} aria-hidden>
                  {waveformBars.slice(0, 5).map((h, i) => (
                    <span key={i} style={{ width: 2.5, height: Math.max(3, h * 0.55), background: "var(--fail)", opacity: 0.8, borderRadius: 2, transition: "height 60ms linear" }} />
                  ))}
                </span>
              ) : (
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} x1="12" y1="19" x2="12" y2="23" />
                  <line strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} x1="8" y1="23" x2="16" y2="23" />
                </svg>
              )}
            </button>
          )}

          {/* queued indicator — only show inline badge for inline variant */}
          {queued.length > 0 && variant === "inline" && (
            <span className="flex items-center gap-1 text-[10px] text-accent mr-1">
              <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
              {queued.length}
            </span>
          )}

          {/* Overflow ⋯ menu */}
          <div className="relative" ref={overflowRef}>
            <button
              type="button"
              onClick={() => setOverflowOpen((o) => !o)}
              className={[
                "flex items-center justify-center w-7 h-7 rounded-lg text-muted hover:text-fg hover:bg-bg-hover transition-colors",
                overflowOpen ? "bg-bg-hover text-fg" : "",
              ].join(" ")}
              title="More options"
              aria-label="More options"
            >
              <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                <circle cx="5" cy="12" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="19" cy="12" r="2" />
              </svg>
            </button>
            {overflowOpen && (
              <div className="absolute bottom-full right-0 mb-1 z-50 w-52 rounded-lg border border-border bg-bg shadow-lg py-1">
                {/* MCP tools (local only) */}

                {cli === "claude-local" && (
                  <label
                    className="flex items-center gap-2.5 px-3 py-2 text-[12px] text-fg hover:bg-bg-hover cursor-pointer select-none transition-colors"
                    title={mcpTools ? "All MCP tools loaded — slower (~100K token prompt)" : "No MCP tools — faster prefill"}
                  >
                    <svg className="w-3.5 h-3.5 text-muted shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                    MCP tools
                    <input
                      type="checkbox"
                      checked={mcpTools}
                      onChange={(e) => setMcpTools(e.target.checked)}
                      disabled={disabled}
                      className="ml-auto w-3 h-3 accent-accent"
                    />
                  </label>
                )}
                {/* Slash commands */}
                <button
                  type="button"
                  onClick={() => {
                    setMessage("/");
                    setSlashOpen(true);
                    setSlashQuery("");
                    setOverflowOpen(false);
                    setTimeout(() => textareaRef.current?.focus(), 0);
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-[12px] text-fg hover:bg-bg-hover transition-colors"
                >
                  <span className="w-3.5 h-3.5 text-muted shrink-0 text-center font-mono font-bold">/</span>
                  Slash commands
                </button>
                {/* CWD */}
                {cwd && (
                  <>
                    <div className="h-px bg-border mx-2 my-1" />
                    <div className="flex items-center gap-2 px-3 py-1.5 text-[11px] text-muted" title={cwd}>
                      <svg className="w-3 h-3 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                      </svg>
                      <span className="truncate mono">{cwd.split("/").pop() || cwd}</span>
                    </div>
                  </>
                )}
                {/* Keyboard hint */}
                <div className="h-px bg-border mx-2 my-1" />
                <div className="px-3 py-1.5 text-[10px] text-subtle">↵ send · ⇧↵ newline</div>
              </div>
            )}
          </div>

          {/* Stop button — shown while streaming */}
          {disabled && onStop ? (
            <>
              <button
                type="button"
                onClick={onStop}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[12px] font-medium border border-[var(--fail)]/40 text-[var(--fail)] hover:bg-[var(--fail)]/10 transition-all active:scale-95"
                aria-label="Stop generation"
                title="Stop generation"
              >
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="4" y="4" width="16" height="16" rx="2" />
                </svg>
                Stop
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={!canSend}
                className={[
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[12px] font-medium transition-all",
                  canSend
                    ? "bg-accent text-white shadow-sm hover:bg-[var(--accent-hover)] active:scale-95"
                    : "bg-bg-hover text-subtle cursor-not-allowed",
                ].join(" ")}
                aria-label="Queue message"
                title="Queue message"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.3} d="M4 7h10M4 12h10M4 17h6m8-8v8m4-4h-8" />
                </svg>
                Queue
              </button>
            </>
          ) : sendLabel ? (
            <button
              type="button"
              onClick={submit}
              disabled={!canSend}
              className={[
                "flex items-center gap-2 px-4 py-1.5 rounded-lg text-[13px] font-medium transition-all",
                canSend
                  ? "bg-accent text-white shadow-sm hover:bg-[var(--accent-hover)] active:scale-95"
                  : "bg-bg-hover text-subtle cursor-not-allowed",
              ].join(" ")}
            >
              {sendLabel}
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!canSend}
              className={[
                "flex items-center justify-center w-8 h-8 rounded-xl transition-all",
                canSend
                  ? "bg-accent text-white shadow-sm hover:bg-[var(--accent-hover)] active:scale-95"
                  : "bg-bg-hover text-subtle cursor-not-allowed",
              ].join(" ")}
              aria-label="Send"
              title="Send"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 12h14M12 5l7 7-7 7" />
              </svg>
            </button>
          )}
        </div>
      </div>
  );

  if (variant === "inline") {
    return (
      <div>
        {header}
        {inner}
      </div>
    );
  }

  return (
    <div
      className="sticky bottom-0 px-4 pb-4 pt-2"
      style={{ background: "linear-gradient(to top, var(--bg) 75%, transparent)" }}
    >
      {queued.length > 0 && (
        <div className="mb-2 flex flex-col gap-1">
          <div className="flex items-center gap-2 px-1 mb-0.5">
            <div className="text-[10px] uppercase tracking-wider text-subtle">
              {queued.length} queued
            </div>
            <button
              type="button"
              onClick={() => setQueued([])}
              className="rounded-md border border-border px-2 py-0.5 text-[10px] text-subtle hover:bg-bg-hover hover:text-fg transition-colors"
            >
              Clear
            </button>
          </div>
          {queued.map((q, i) => (
            <div
              key={i}
              className="flex items-start gap-2 px-3 py-2 rounded-xl border border-border text-[12px]"
              style={{ background: "var(--bg-elev)" }}
            >
              <span className="shrink-0 text-subtle text-[10px] mt-0.5">{i + 1}.</span>
              <div className="shrink-0 flex items-center gap-1">
                {disabled && onStop && (
                  <button
                    type="button"
                    onClick={() => steerWithQueued(i)}
                    className="rounded-md border border-accent/40 px-2 py-1 text-[10px] font-medium text-accent hover:bg-accent/10 transition-colors"
                    title="Stop current reply and send this queued message next"
                  >
                    Steer
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => removeQueued(i)}
                  className="flex h-6 w-6 items-center justify-center rounded-md border border-border text-subtle hover:bg-bg-hover hover:text-fg transition-colors"
                  aria-label={`Remove queued message ${i + 1}`}
                  title="Remove queued message"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <span className="min-w-0 flex-1 text-fg leading-snug line-clamp-2">{q.text}</span>
            </div>
          ))}
        </div>
      )}
      {inner}
    </div>
  );
});
