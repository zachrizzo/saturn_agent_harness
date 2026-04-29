// Shared SSE helper — tails a JSONL file, sends each line as an SSE `data:` event,
// and closes when the companion meta.json reports status "success" or "failed".
//
// Used by both /api/runs/[name]/[ts]/stream and /api/sessions/[id]/stream.

import { spawn } from "child_process";
import fs from "node:fs";

type TerminalStatus = "success" | "failed";

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
   * Optional callback invoked for each raw JSONL line before it is forwarded to the client.
   * Fire-and-forget — errors are swallowed so they never affect the SSE stream.
   */
  onRawLine?: (line: string) => void;
};

/** Creates a Response with SSE headers that tails `streamFile` and watches `metaFile`. */
export function tailSseResponse(opts: TailSseOptions): Response {
  const { streamFile, metaFile, liveTail = true, keepOpenStatuses = [], onRawLine } = opts;
  const encoder = new TextEncoder();

  const body = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (data: string) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`data: ${data}\n\n`)); } catch {}
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch {}
      };

      // Wait up to 5s for the stream file to exist (may have just been created)
      let waited = 0;
      const waitForFile = setInterval(() => {
        if (fs.existsSync(streamFile)) {
          clearInterval(waitForFile);
          startTail();
        } else if (waited++ > 50) {
          clearInterval(waitForFile);
          send(JSON.stringify({ type: "error", message: "stream file never appeared" }));
          close();
        }
      }, 100);

      function readMeta(): Record<string, unknown> {
        try { return JSON.parse(fs.readFileSync(metaFile, "utf8")); } catch { return {}; }
      }

      function isTerminal(status: unknown): status is TerminalStatus {
        if (status !== "success" && status !== "failed") return false;
        return !keepOpenStatuses.includes(status as string);
      }

      // Tracks how many bytes of stream.jsonl we've already emitted, so subsequent
      // reads (and the follow-mode tail) resume without skipping or duplicating.
      let byteOffset = 0;
      let pendingPartial = "";

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
            const len = stat.size - byteOffset;
            const buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, byteOffset);
            byteOffset = stat.size;
            emitBytes(buf);
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
        const tail = spawn("tail", ["-c", `+${byteOffset + 1}`, "-f", streamFile]);

        tail.stdout.on("data", (chunk: Buffer) => {
          byteOffset += chunk.length;
          emitBytes(chunk);
        });

        const pollMeta = setInterval(() => {
          const m = readMeta();
          if (isTerminal(m.status)) {
            clearInterval(pollMeta);
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
          clearInterval(pollMeta);
          close();
        });
      }

      function startTail() {
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
          const waitForRunning = setInterval(() => {
            replayUpToEnd();
            const m = readMeta();
            if (!isTerminal(m.status)) {
              clearInterval(waitForRunning);
              startLiveTail();
            } else if (ticks++ >= 66) { // 66 x 150ms ~= 10s max wait
              clearInterval(waitForRunning);
              send(JSON.stringify({ type: "_meta", meta: m }));
              close();
            }
          }, 150);
          return;
        }

        startLiveTail();
      }
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
