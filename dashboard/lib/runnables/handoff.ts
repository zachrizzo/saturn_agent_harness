// Cross-CLI handoff — export a neutral transcript from one adapter and seed
// another adapter with it.

import type { CLI } from "../runs";
import type { NeutralTranscript, SessionHandle, StartSessionOpts } from "./types";
import { getAdapter } from "./registry";

export type HandoffOptions = {
  from: { cli: CLI; handle: SessionHandle };
  to: { cli: CLI; opts: StartSessionOpts };
};

export async function handoff(opts: HandoffOptions): Promise<{
  target: SessionHandle;
  transcript: NeutralTranscript;
}> {
  const src = getAdapter(opts.from.cli);
  const dst = getAdapter(opts.to.cli);
  const transcript = await src.exportState(opts.from.handle);
  const target = await dst.importState(transcript, opts.to.opts);
  return { target, transcript };
}

/**
 * Convenience: serialize a neutral transcript to JSON that can be stored as
 * part of a SessionMeta turn record and later rehydrated with importState.
 */
export function serializeTranscript(t: NeutralTranscript): string {
  return JSON.stringify(t);
}

export function deserializeTranscript(s: string): NeutralTranscript {
  return JSON.parse(s) as NeutralTranscript;
}
