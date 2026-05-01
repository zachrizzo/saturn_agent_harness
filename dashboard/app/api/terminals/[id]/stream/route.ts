import { NextRequest, NextResponse } from "next/server";
import { getAgentBashTerminal, type AgentBashTerminal } from "@/lib/terminal-agent";
import { getPtyReplay, getPtyTerminal, subscribePtyTerminal } from "@/lib/terminal-pty";
import type { TerminalRecord } from "@/lib/terminal-types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type SsePayload =
  | { type: "data"; data: string }
  | { type: "meta"; terminal: TerminalRecord }
  | { type: "end"; terminal: TerminalRecord }
  | { type: "error"; message: string };

function sseResponse(start: (send: (payload: SsePayload) => void, close: () => void) => void | (() => void)): Response {
  const encoder = new TextEncoder();
  let cleanup: (() => void) | undefined;
  const body = new ReadableStream({
    start(controller) {
      let closed = false;
      const send = (payload: SsePayload) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          closed = true;
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        cleanup?.();
        cleanup = undefined;
        try {
          controller.close();
        } catch {
          /* noop */
        }
      };
      cleanup = start(send, close) ?? undefined;
    },
    cancel() {
      cleanup?.();
      cleanup = undefined;
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

function streamPtyTerminal(id: string, req: NextRequest): Response {
  const terminal = getPtyTerminal(id);
  const replay = getPtyReplay(id);
  if (!terminal || replay === null) {
    return NextResponse.json({ error: "terminal not found" }, { status: 404 });
  }

  return sseResponse((send, close) => {
    let unsubscribe: (() => void) | null = null;
    const cleanup = () => {
      unsubscribe?.();
      unsubscribe = null;
    };

    send({ type: "meta", terminal });
    if (replay) send({ type: "data", data: replay });
    if (terminal.status !== "running") {
      send({ type: "end", terminal });
      close();
      return;
    }

    unsubscribe = subscribePtyTerminal(id, (event) => {
      send(event);
      if (event.type === "end") {
        cleanup();
        close();
      }
    });
    if (!unsubscribe) {
      send({ type: "error", message: "terminal disappeared" });
      close();
      return;
    }

    req.signal.addEventListener("abort", () => {
      cleanup();
      close();
    }, { once: true });

    return cleanup;
  });
}

function streamAgentTerminal(initial: AgentBashTerminal, req: NextRequest): Response {
  return sseResponse((send, close) => {
    let lastOutput = "";
    let closed = false;
    let busy = false;

    const publish = (terminal: AgentBashTerminal) => {
      send({ type: "meta", terminal: terminal.record });
      if (terminal.output.startsWith(lastOutput)) {
        const delta = terminal.output.slice(lastOutput.length);
        if (delta) send({ type: "data", data: delta });
      } else {
        send({ type: "data", data: terminal.output });
      }
      lastOutput = terminal.output;
      if (terminal.record.status !== "running") {
        send({ type: "end", terminal: terminal.record });
        closed = true;
        close();
      }
    };

    publish(initial);
    if (closed) return;

    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const next = await getAgentBashTerminal(initial.record.id);
        if (!next) {
          send({ type: "error", message: "terminal disappeared" });
          closed = true;
          clearInterval(timer);
          close();
        } else {
          publish(next);
          if (closed) clearInterval(timer);
        }
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : "failed to refresh terminal" });
        closed = true;
        clearInterval(timer);
        close();
      } finally {
        busy = false;
      }
    }, 1000);

    const cleanup = () => {
      closed = true;
      clearInterval(timer);
    };

    req.signal.addEventListener("abort", () => {
      cleanup();
      close();
    }, { once: true });

    return cleanup;
  });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ptyTerminal = getPtyTerminal(id);
  if (ptyTerminal) return streamPtyTerminal(id, req);

  const agentTerminal = await getAgentBashTerminal(id);
  if (agentTerminal) return streamAgentTerminal(agentTerminal, req);

  return NextResponse.json({ error: "terminal not found" }, { status: 404 });
}
