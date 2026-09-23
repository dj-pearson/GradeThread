// US-3345: let photos 2..N of one grade READ the prompt cache photo 1 writes.
//
// A prompt-cache entry becomes readable only once the request writing it has
// begun streaming. The per-image fan-out issues every photo at once, so every
// photo pays the 1.25x write premium on the same cached system prefix and none
// reads it back. The fix is to send photo 1, wait until its generation has
// BEGUN (not finished), then release 2..N together. Photo 1 streams so that
// moment is observable (AiMessageRequest.onFirstToken); the rest are the same
// non-streamed calls as before.
//
// What it costs: photo 1's time to first token (prefill of one image plus the
// cached prefix) is added to the seller's wait, once per grade. What it buys,
// at Sonnet 5 list input on a four-photo grade: one write plus three reads
// instead of four writes on the system prefix. The fan-out log in
// grading-pipeline.ts prints `gate_ms`, which is exactly the added wait, so the
// trade can be read off real grades before this is turned on for everyone.
//
// Behind GRADING_CACHE_STAGGER, default OFF, and inert unless grading caching
// is on too (gradingCachingEnabled): with no cache_control there is nothing to
// read, so serialising would be a latency cost for nothing. The flag changes
// transport and timing only, never a byte the model reads, so it does not ride
// the prompt-version lane and earns no prompt_version suffix.
//
// Pure apart from the env read: no supabase, no SDK.

import { gradingCachingEnabled } from "./ai-config.ts";

export function gradingCacheStaggerRequested(): boolean {
  const v = (Deno.env.get("GRADING_CACHE_STAGGER") ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

/** On only when requested AND there is a cache write for photo 2..N to read. */
export function gradingCacheStaggerEnabled(): boolean {
  return gradingCacheStaggerRequested() && gradingCachingEnabled();
}

export interface StaggeredFanOut<R> {
  /** One promise per item, in input order, for Promise.allSettled. */
  promises: Promise<R>[];
  /**
   * Resolves with the ms the rest of the fan-out waited for the first call
   * (0 when nothing was staggered). Never rejects.
   */
  gateMs: Promise<number>;
}

/**
 * Start `run` for every item. Staggered: item 0 starts now with an
 * `onFirstToken` callback, and items 1..N start together once it fires, or once
 * item 0 settles, whichever comes first. So a provider that cannot stream, or a
 * first call that fails, degrades to "wait for photo 1" rather than hanging,
 * and a rejection of item 0 never rejects the others. Not staggered (flag off,
 * or fewer than two items): every item starts now, exactly as a bare .map().
 */
export function staggerFirstCall<T, R>(
  items: readonly T[],
  run: (item: T, index: number, onFirstToken?: () => void) => Promise<R>,
  enabled: boolean,
): StaggeredFanOut<R> {
  if (!enabled || items.length < 2) {
    return {
      promises: items.map((item, i) => run(item, i)),
      gateMs: Promise.resolve(0),
    };
  }
  const startedAt = Date.now();
  let open!: () => void;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const first = run(items[0], 0, () => open());
  first.then(() => open(), () => open());
  const rest = items.slice(1).map((item, j) => gate.then(() => run(item, j + 1)));
  return {
    promises: [first, ...rest],
    gateMs: gate.then(() => Date.now() - startedAt),
  };
}
