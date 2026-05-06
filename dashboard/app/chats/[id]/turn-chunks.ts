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
  turnId?: string;
  start: number;
  end: number;
  hasResult: boolean;
};

type LegacyEventSlice = EventSlice & {
  sid?: string;
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

function turnIdFromMetaTurn(turn: SessionMeta["turns"][number]): string | undefined {
  const value = (turn as unknown as Record<string, unknown>).turn_id;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function nativeSessionIdFromMetaTurn(turn: SessionMeta["turns"][number]): string | undefined {
  const value = (turn as unknown as Record<string, unknown>).cli_session_id;
  return typeof value === "string" && value.trim() ? value : undefined;
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
): LegacyEventSlice[] {
  const slices: LegacyEventSlice[] = [];
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

function buildSaturnTurnSlices(events: StreamEvent[]): EventSlice[] {
  const turnStarts: Array<{ turnId: string; idx: number }> = [];
  events.forEach((ev, idx) => {
    const turnId = turnMarkerId(ev);
    if (turnId) turnStarts.push({ turnId, idx });
  });

  return turnStarts.map((start, pos): EventSlice => {
    const end = pos + 1 < turnStarts.length ? turnStarts[pos + 1].idx : events.length;
    return {
      turnId: start.turnId,
      start: start.idx,
      end,
      hasResult: hasTerminalResult(events, start.idx, end),
    };
  });
}

function buildLegacyCompatibilitySlices(events: StreamEvent[], start: number, end: number): LegacyEventSlice[] {
  const starts: Array<{ sid: string; idx: number }> = [];
  for (let i = start; i < end; i++) {
    const sid = nativeSessionId(events[i]);
    if (sid) starts.push({ sid, idx: i });
  }

  const slices: LegacyEventSlice[] = [];
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

function nextUnclaimedSlice<T extends EventSlice>(
  slices: T[],
  consumed: Set<EventSlice>,
  cursor: { value: number },
  predicate: (slice: T) => boolean = () => true,
): T | undefined {
  while (cursor.value < slices.length) {
    const slice = slices[cursor.value];
    cursor.value += 1;
    if (!consumed.has(slice) && predicate(slice)) return slice;
  }
  return undefined;
}

function latestUnclaimedOpenSlice<T extends EventSlice>(
  slices: T[],
  consumed: Set<EventSlice>,
): T | undefined {
  for (let i = slices.length - 1; i >= 0; i--) {
    const slice = slices[i];
    if (!consumed.has(slice) && !slice.hasResult) return slice;
  }
  return undefined;
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

  const saturnSlices = buildSaturnTurnSlices(events);

  if (saturnSlices.length > 0) {
    const slicesByTurnId = new Map(saturnSlices.map((slice) => [slice.turnId!, slice]));
    const consumedSaturnSlices = new Set<EventSlice>();
    const leadingLegacySlices = buildLegacyCompatibilitySlices(events, 0, saturnSlices[0].start);
    let leadingLegacyCursor = 0;
    const result: TurnChunk[] = [];

    meta.turns.forEach((t, i) => {
      const turnId = turnIdFromMetaTurn(t);
      let slice = turnId ? slicesByTurnId.get(turnId) : undefined;
      if (slice) {
        consumedSaturnSlices.add(slice);
      } else if (leadingLegacyCursor < leadingLegacySlices.length) {
        // Compatibility only: old sessions may have stream events before the
        // first dashboard-owned turn marker. Modern turns never use this path.
        slice = leadingLegacySlices[leadingLegacyCursor++];
      } else if (i === meta.turns.length - 1 && meta.status === "running") {
        // Optimistic client turns briefly exist before the server snapshot with
        // the new turn_id arrives. Only attach a new open Saturn slice that
        // starts after the previous turn's slice; otherwise a partial or stale
        // event snapshot can make the previous reply look like the new one.
        const previousTurnId = i > 0 ? turnIdFromMetaTurn(meta.turns[i - 1]) : undefined;
        const previousSlice = previousTurnId ? slicesByTurnId.get(previousTurnId) : undefined;
        const openSlice = latestUnclaimedOpenSlice(saturnSlices, consumedSaturnSlices);
        if (openSlice && (!previousTurnId || (previousSlice && openSlice.start > previousSlice.start))) {
          slice = openSlice;
          consumedSaturnSlices.add(slice);
        }
      }
      if (shouldMaterializeTurn(i)) result.push(makeChunk(t, i, slice));
    });
    return result;
  }

  const allSlices = buildLegacyCompatibilitySlices(events, 0, events.length);

  const slicesBySid = new Map<string, LegacyEventSlice[]>();
  for (const slice of allSlices) {
    if (!slice.sid) continue;
    const group = slicesBySid.get(slice.sid) ?? [];
    group.push(slice);
    slicesBySid.set(slice.sid, group);
  }

  const consumedBySid = new Map<string, number>();
  const consumedSlices = new Set<EventSlice>();
  const result: TurnChunk[] = [];
  const legacyCursor = { value: 0 };

  for (let i = 0; i < meta.turns.length; i++) {
    const t = meta.turns[i];
    const isLast = i === meta.turns.length - 1;
    const sid = nativeSessionIdFromMetaTurn(t);

    let slice: LegacyEventSlice | undefined;

    if (sid) {
      const consumed = consumedBySid.get(sid) ?? 0;
      slice = slicesBySid.get(sid)?.[consumed];
      if (slice) consumedBySid.set(sid, consumed + 1);
    } else if (isLast && meta.status === "running" && allSlices.length > 0) {
      // The turn stub is written before run-turn.sh fills cli_session_id.
      // Attach the newest unclaimed native slice so live output is visible,
      // but only if it is still open. Otherwise an optimistic new turn can
      // briefly render the previous completed assistant reply until refresh.
      slice = latestUnclaimedOpenSlice(allSlices, consumedSlices);
    } else {
      // Compatibility only: sessions written before dashboard turn ids must be
      // assigned chronologically because native CLIs can reuse session ids.
      slice = nextUnclaimedSlice(allSlices, consumedSlices, legacyCursor);
    }

    if (slice) consumedSlices.add(slice);
    if (shouldMaterializeTurn(i)) result.push(makeChunk(t, i, slice));
  }

  return result;
}
