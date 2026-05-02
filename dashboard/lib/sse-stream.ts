// Shared SSE helper — tails a JSONL file, sends each line as an SSE `data:` event,
// and closes when the companion meta.json reports status "success" or "failed".
//
// Used by both /api/runs/[name]/[ts]/stream and /api/sessions/[id]/stream.

import { spawn } from "child_process";
import fs from "node:fs";

const SSE_REPLAY_CHUNK_BYTES = 256 * 1024;

export type TailSseOptions = {
  /** Absolute path to the JSONL file to tail. */
  streamFile: string;
  /** Absolute path to the meta.json that signals completion via its `status` field. */
  metaFile: string;
  /**
   * If true (default), the stream stays open — polling meta for completion — even after the
   * initial read if the status is not yet terminal. Set to false to always close after replay.
   */
  liveTail?: boolean;
  /**
   * For sessions: a turn can complete (status === "idle") but the overall session is still
   * alive. Pass "idle" here to keep tailing; omit to treat idle as terminal.
   */
  keepOpenStatuses?: string[];
  /**
   * Defaults to "success" and "failed". Slice streams use not-running because
   * validation errors, timeouts, and budget exits are terminal too.
   */
  terminalStatuses?: string[];
  terminalStatusMode?: "listed" | "not-running";
  /**
   * Optional callback invoked for each raw JSONL line before it is forwarded to the client.
   * Fire-and-forget — errors are swallowed so they never affect the SSE stream.
   */
  onRawLine?: (line: string) => void;
  /**
   * Start tailing from the current end of the stream file. New bytes appended
   * after the connection opens are still replayed during the running grace
   * period, but historical transcript bytes are skipped.
   */
  startAtEnd?: boolean;
  /**
   * Start after this many completed turn result records. This avoids sending
   * long historical transcripts back to the browser while still replaying any
   * current-turn bytes that were written before the SSE connection opened.
   */
  startAfterResultCount?: number;
  /** Start replay at the saturn.turn_start marker for this turn id. */
  startAtTurnId?: string;
  /** Start replay at the turn immediately after this saturn.turn_start marker. */
  startAfterTurnId?: string;
};

/** Creates a Response with SSE headers that tails `streamFile` and watches `metaFile`. */
export function tailSseResponse(opts: TailSseOptions): Response {
  const {
    streamFile,
    metaFile,
    liveTail = true,
    keepOpenStatuses = [],
    terminalStatuses = ["success", "failed"],
    terminalStatusMode = "listed",
    onRawLine,
    startAtEnd = false,
    startAfterResultCount,
    startAtTurnId,
    startAfterTurnId,
  } = opts;
  const encoder = new TextEncoder();
  let cleanupStream: (() => void) | undefined;

  const body = new ReadableStream({
    start(controller) {
      let closed = false;
      let waitForFile: ReturnType<typeof setInterval> | null = null;
      let waitForRunning: ReturnType<typeof setInterval> | null = null;
      let pollMeta: ReturnType<typeof setInterval> | null = null;
      let tailProcess: ReturnType<typeof spawn> | null = null;

      const clearTimer = (timer: ReturnType<typeof setInterval> | null) => {
        if (timer !== null) clearInterval(timer);
      };
      const cleanup = () => {
        clearTimer(waitForFile);
        clearTimer(waitForRunning);
        clearTimer(pollMeta);
        waitForFile = null;
        waitForRunning = null;
        pollMeta = null;
        if (tailProcess) {
          try { tailProcess.kill(); } catch {}
          tailProcess = null;
        }
      };
      cleanupStream = () => {
        closed = true;
        cleanup();
      };

      const send = (data: string) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`data: ${data}\n\n`)); } catch {}
      };
      const close = () => {
        if (closed) return;
        closed = true;
        cleanup();
        cleanupStream = undefined;
        try { controller.close(); } catch {}
      };

      // Wait up to 5s for the stream file to exist (may have just been created)
      let waited = 0;
      waitForFile = setInterval(() => {
        if (fs.existsSync(streamFile)) {
          clearTimer(waitForFile);
          waitForFile = null;
          startTail();
        } else if (waited++ > 50) {
          clearTimer(waitForFile);
          waitForFile = null;
          send(JSON.stringify({ type: "error", message: "stream file never appeared" }));
          close();
        }
      }, 100);

      function readMeta(): Record<string, unknown> {
        try { return JSON.parse(fs.readFileSync(metaFile, "utf8")); } catch { return {}; }
      }

      function isTerminal(status: unknown): boolean {
        if (typeof status !== "string" || !status) return false;
        if (terminalStatusMode === "not-running" && status !== "running") {
          return !keepOpenStatuses.includes(status);
        }
        if (!terminalStatuses.includes(status)) return false;
        return !keepOpenStatuses.includes(status as string);
      }

      // Tracks how many bytes of stream.jsonl we've already emitted, so subsequent
      // reads (and the follow-mode tail) resume without skipping or duplicating.
      let byteOffset = 0;
      let pendingPartial = "";

      function byteOffsetAfterResultCount(resultCount: number): number | null {
        if (!Number.isFinite(resultCount) || resultCount <= 0) return 0;
        try {
          const buf = fs.readFileSync(streamFile);
          let offset = 0;
          let seen = 0;
          while (offset < buf.length) {
            const newline = buf.indexOf(0x0a, offset);
            const lineEnd = newline === -1 ? buf.length : newline;
            const line = buf.subarray(offset, lineEnd).toString("utf8");
            if (/"type"\s*:\s*"(result|turn\.completed|step_finish)"/.test(line)) {
              seen += 1;
              if (seen >= resultCount) return newline === -1 ? lineEnd : newline + 1;
            }
            if (newline === -1) break;
            offset = newline + 1;
          }
        } catch {}
        return null;
      }

      function lineHasTurnStart(line: string): boolean {
        return /"type"\s*:\s*"saturn\.turn_start"/.test(line);
      }

      function lineHasTurnId(line: string, turnId: string): boolean {
        try {
          const obj = JSON.parse(line) as { turn_id?: unknown };
          return obj.turn_id === turnId;
        } catch {
          return false;
        }
      }

      function byteOffsetForTurnMarker(turnId: string, mode: "at" | "after"): number | null {
        if (!turnId) return null;
        try {
          const buf = fs.readFileSync(streamFile);
          let offset = 0;
          let found = false;
          while (offset < buf.length) {
            const lineStart = offset;
            const newline = buf.indexOf(0x0a, offset);
            const lineEnd = newline === -1 ? buf.length : newline;
            const line = buf.subarray(lineStart, lineEnd).toString("utf8");
            if (lineHasTurnStart(line)) {
              if (found) return lineStart;
              if (lineHasTurnId(line, turnId)) {
                if (mode === "at") return lineStart;
                found = true;
              }
            }
            if (newline === -1) break;
            offset = newline + 1;
          }
          if (found && mode === "after") return buf.length;
        } catch {}
        return null;
      }

      function emitBytes(buf: Buffer) {
        const text = pendingPartial + buf.toString("utf8");
        const lines = text.split("\n");
        pendingPartial = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          send(trimmed);
          if (onRawLine) {
            try { onRawLine(trimmed); } catch { /* fire-and-forget */ }
          }
        }
      }

      function replayUpToEnd() {
        try {
          const stat = fs.statSync(streamFile);
          if (stat.size <= byteOffset) return;
          const fd = fs.openSync(streamFile, "r");
          try {
            const targetEnd = stat.size;
            while (byteOffset < targetEnd && !closed) {
              const len = Math.min(SSE_REPLAY_CHUNK_BYTES, targetEnd - byteOffset);
              const buf = Buffer.allocUnsafe(len);
              const read = fs.readSync(fd, buf, 0, len, byteOffset);
              if (read <= 0) break;
              byteOffset += read;
              emitBytes(read === len ? buf : buf.subarray(0, read));
            }
          } finally {
            fs.closeSync(fd);
          }
        } catch {}
      }

      function startLiveTail() {
        // Catch up to the current end before switching to follow mode, so nothing
        // written during any grace period is lost.
        replayUpToEnd();

        // Continue from exactly byteOffset+1 (tail -c is 1-indexed).
        tailProcess = spawn("tail", ["-c", `+${byteOffset + 1}`, "-f", streamFile]);
        const tail = tailProcess;

        tail.stdout?.on("data", (chunk: Buffer) => {
          byteOffset += chunk.length;
          emitBytes(chunk);
        });

        pollMeta = setInterval(() => {
          const m = readMeta();
          if (isTerminal(m.status)) {
            clearTimer(pollMeta);
            pollMeta = null;
            // Flush anything tail hasn't surfaced yet before closing.
            replayUpToEnd();
            if (pendingPartial.trim()) send(pendingPartial.trim());
            pendingPartial = "";
            send(JSON.stringify({ type: "_meta", meta: m }));
            tail.kill();
            close();
          }
        }, 500);

        tail.on("close", () => {
          clearTimer(pollMeta);
          pollMeta = null;
          close();
        });
      }

      function startTail() {
        const turnOffset = startAtTurnId
          ? byteOffsetForTurnMarker(startAtTurnId, "at")
          : startAfterTurnId
            ? byteOffsetForTurnMarker(startAfterTurnId, "after")
            : null;
        const afterResults = turnOffset === null && typeof startAfterResultCount === "number"
          ? byteOffsetAfterResultCount(startAfterResultCount)
          : null;
        if (turnOffset !== null) {
          byteOffset = turnOffset;
        } else if (afterResults !== null) {
          byteOffset = afterResults;
        } else if (startAtEnd) {
          try {
            byteOffset = fs.statSync(streamFile).size;
          } catch {
            byteOffset = 0;
          }
        }

        // Replay whatever is already on disk.
        replayUpToEnd();

        const meta = readMeta();
        if (!liveTail) {
          send(JSON.stringify({ type: "_meta", meta }));
          close();
          return;
        }

        if (isTerminal(meta.status)) {
          // Grace period: a new turn may have just been spawned but hasn't written
          // "running" to meta.json yet. Poll briefly, also replaying any bytes
          // appended during the wait so they aren't dropped.
          let ticks = 0;
          waitForRunning = setInterval(() => {
            replayUpToEnd();
            const m = readMeta();
            if (!isTerminal(m.status)) {
              clearTimer(waitForRunning);
              waitForRunning = null;
              startLiveTail();
            } else if (ticks++ >= 66) { // 66 x 150ms ~= 10s max wait
              clearTimer(waitForRunning);
              waitForRunning = null;
              send(JSON.stringify({ type: "_meta", meta: m }));
              close();
            }
          }, 150);
          return;
        }

        startLiveTail();
      }
    },
    cancel() {
      cleanupStream?.();
      cleanupStream = undefined;
    }
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive",
    },
  });
}
