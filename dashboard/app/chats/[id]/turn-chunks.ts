import type { ModelReasoningEffort } from "@/lib/models";
import type { CLI, SessionMeta } from "@/lib/runs";
import type { StreamEvent } from "@/lib/events";
import { normalizeCli } from "@/lib/clis";

export type TurnChunk = {
  turnIndex: number;
  cli: CLI;
  model?: string;
  reasoningEffort?: ModelReasoningEffort;
  userMessage: string;
  events: StreamEvent[];
  streaming: boolean;
};

type EventSlice = {
  sid?: string;
  turnId?: string;
  start: number;
  end: number;
  hasResult: boolean;
};

type BuildTurnChunksOptions = {
  startTurnIndex?: number;
  endTurnIndex?: number;
};

function rawRecord(ev: StreamEvent): Record<string, unknown> {
  return (ev.raw && typeof ev.raw === "object" ? ev.raw : {}) as Record<string, unknown>;
}

function turnMarkerId(ev: StreamEvent): string | undefined {
  const raw = rawRecord(ev);
  if (raw.type !== "saturn.turn_start") return undefined;
  return typeof raw.turn_id === "string" ? raw.turn_id : undefined;
}

function nativeSessionId(ev: StreamEvent): string | undefined {
  const raw = rawRecord(ev);
  if (ev.kind === "system" && raw.subtype === "init") {
    return typeof raw.session_id === "string" ? raw.session_id : undefined;
  }
  if (ev.kind === "system" && raw.type === "thread.started") {
    return typeof raw.thread_id === "string" ? raw.thread_id : undefined;
  }
  return undefined;
}

function hasTerminalResult(events: StreamEvent[], start: number, end: number): boolean {
  for (let i = start; i < end; i++) {
    const ev = events[i];
    if (ev.kind === "result" || rawRecord(ev).type === "saturn.turn_aborted") return true;
  }
  return false;
}

function splitByResult(
  events: StreamEvent[],
  start: number,
  end: number,
  sid?: string,
  includeTrailing = true,
): EventSlice[] {
  const slices: EventSlice[] = [];
  let sliceStart = start;
  let sawResult = false;
  for (let i = start; i < end; i++) {
    if (events[i].kind !== "result") continue;
    sawResult = true;
    slices.push({ sid, start: sliceStart, end: i + 1, hasResult: true });
    sliceStart = i + 1;
  }
  if ((includeTrailing || !sawResult) && sliceStart < end) {
    slices.push({ sid, start: sliceStart, end, hasResult: false });
  }
  return slices;
}

function buildLegacySlices(events: StreamEvent[], start: number, end: number): EventSlice[] {
  const starts: Array<{ sid: string; idx: number }> = [];
  for (let i = start; i < end; i++) {
    const sid = nativeSessionId(events[i]);
    if (sid) starts.push({ sid, idx: i });
  }

  const slices: EventSlice[] = [];
  if (starts.length === 0) {
    slices.push(...splitByResult(events, start, end));
    return slices;
  }

  starts.forEach((segmentStart, pos) => {
    const segmentEnd = pos + 1 < starts.length ? starts[pos + 1].idx : end;
    const isLastSegment = pos + 1 >= starts.length;
    slices.push(...splitByResult(events, segmentStart.idx, segmentEnd, segmentStart.sid, isLastSegment));
  });
  return slices;
}

export function buildTurnChunks(
  meta: Pick<SessionMeta, "turns" | "status">,
  events: StreamEvent[],
  options: BuildTurnChunksOptions = {},
): TurnChunk[] {
  const startTurnIndex = Math.min(
    meta.turns.length,
    Math.max(0, options.startTurnIndex ?? 0),
  );
  const endTurnIndex = Math.min(
    meta.turns.length,
    Math.max(startTurnIndex, options.endTurnIndex ?? meta.turns.length),
  );
  const shouldMaterializeTurn = (index: number) => index >= startTurnIndex && index < endTurnIndex;
  const makeChunk = (
    t: SessionMeta["turns"][number],
    i: number,
    slice: EventSlice | undefined,
  ): TurnChunk => {
    const isLast = i === meta.turns.length - 1;
    return {
      turnIndex: i,
      cli: normalizeCli(t.cli),
      model: t.model,
      reasoningEffort: t.reasoningEffort,
      userMessage: t.user_message,
      events: slice ? events.slice(slice.start, slice.end) : [],
      streaming: !slice?.hasResult && meta.status === "running" && isLast,
    };
  };

  const turnStarts: Array<{ turnId: string; idx: number }> = [];
  events.forEach((ev, i) => {
    const turnId = turnMarkerId(ev);
    if (turnId) turnStarts.push({ turnId, idx: i });
  });

  if (turnStarts.length > 0) {
    const markerSlices = turnStarts.map((start, pos): EventSlice => {
      const end = pos + 1 < turnStarts.length ? turnStarts[pos + 1].idx : events.length;
      return {
        turnId: start.turnId,
        start: start.idx,
        end,
        hasResult: hasTerminalResult(events, start.idx, end),
      };
    });
    const slicesByTurnId = new Map(markerSlices.map((slice) => [slice.turnId!, slice]));
    const consumedMarkerSlices = new Set<EventSlice>();
    const legacySlices = buildLegacySlices(events, 0, turnStarts[0].idx);
    let legacyCursor = 0;
    let markerCursor = 0;
    const nextUnclaimedMarkerSlice = () => {
      while (markerCursor < markerSlices.length) {
        const candidate = markerSlices[markerCursor];
        markerCursor += 1;
        if (!consumedMarkerSlices.has(candidate)) return candidate;
      }
      return undefined;
    };
    const result: TurnChunk[] = [];

    meta.turns.forEach((t, i) => {
      const turnId = (t as unknown as Record<string, unknown>).turn_id as string | undefined;
      let slice = turnId ? slicesByTurnId.get(turnId) : undefined;
      if (slice) {
        consumedMarkerSlices.add(slice);
      } else if (legacyCursor < legacySlices.length) {
        slice = legacySlices[legacyCursor++];
      } else {
        // Optimistic client turns do not know the server-generated turn_id yet.
        // Attach the next unclaimed saturn.turn_start slice so live output shows
        // immediately instead of waiting for a metadata refresh.
        slice = nextUnclaimedMarkerSlice();
        if (slice) consumedMarkerSlices.add(slice);
      }
      if (shouldMaterializeTurn(i)) result.push(makeChunk(t, i, slice));
    });
    return result;
  }

  const allSlices = buildLegacySlices(events, 0, events.length);

  const slicesBySid = new Map<string, EventSlice[]>();
  for (const slice of allSlices) {
    if (!slice.sid) continue;
    const group = slicesBySid.get(slice.sid) ?? [];
    group.push(slice);
    slicesBySid.set(slice.sid, group);
  }

  const consumedBySid = new Map<string, number>();
  const consumedSlices = new Set<EventSlice>();
  const result: TurnChunk[] = [];
  let unclaimedSliceCursor = 0;
  const nextUnclaimedSlice = () => {
    while (unclaimedSliceCursor < allSlices.length) {
      const slice = allSlices[unclaimedSliceCursor];
      unclaimedSliceCursor += 1;
      if (!consumedSlices.has(slice)) return slice;
    }
    return undefined;
  };
  const latestUnclaimedSlice = () => {
    for (let i = allSlices.length - 1; i >= 0; i--) {
      const slice = allSlices[i];
      if (!consumedSlices.has(slice)) return slice;
    }
    return undefined;
  };

  for (let i = 0; i < meta.turns.length; i++) {
    const t = meta.turns[i];
    const isLast = i === meta.turns.length - 1;
    const sid = (t as unknown as Record<string, unknown>).cli_session_id as string | undefined | null;

    let slice: EventSlice | undefined;

    if (sid) {
      const consumed = consumedBySid.get(sid) ?? 0;
      slice = slicesBySid.get(sid)?.[consumed];
      if (slice) consumedBySid.set(sid, consumed + 1);
    } else if (isLast && meta.status === "running" && allSlices.length > 0) {
      // The turn stub is written before run-turn.sh fills cli_session_id.
      // Attach the newest unclaimed native slice so live output is visible.
      slice = latestUnclaimedSlice();
    } else {
      // Legacy aborted turns were written before dashboard turn ids existed.
      // Preserve chronological order by assigning the next unclaimed slice,
      // even when the CLI reused a native session id from an earlier turn.
      slice = nextUnclaimedSlice();
    }

    if (slice) consumedSlices.add(slice);
    if (shouldMaterializeTurn(i)) result.push(makeChunk(t, i, slice));
  }

  return result;
}
