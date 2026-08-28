// US-2960: the description preview's request scheduler.
//
// The preview panel shows the exact string eBay will receive, which only the
// edge renderer can produce, so every keystroke in a block textarea is a
// potential round trip. Two things have to hold and neither is free:
//
//   1. DEBOUNCE. 400ms, per the design doc. Typing an intro must not fire a
//      request per character.
//   2. LAST REQUEST WINS. Two in-flight renders can come back in either order,
//      and a slow EARLIER one landing after a fast LATER one would put stale
//      bytes under a seller who is about to publish them. The sequence number
//      here is what makes that impossible — a response whose sequence is not
//      the newest issued is dropped, not rendered.
//
// Pure and timer-driven, so both properties are tested directly with fake timers
// rather than inferred from a mounted component.

export interface PreviewScheduler<TPayload> {
  /** Queue a render. Resets the debounce window. */
  request(payload: TPayload): void;
  /** Drop any pending timer and ignore every response still in flight. */
  cancel(): void;
}

export interface PreviewSchedulerOptions<TPayload, TResult> {
  fetcher: (payload: TPayload) => Promise<TResult>;
  onResult: (result: TResult) => void;
  onError?: (error: unknown) => void;
  /** Called with true when a request is issued and false when the newest settles. */
  onPending?: (pending: boolean) => void;
  delayMs?: number;
}

export const PREVIEW_DEBOUNCE_MS = 400;

export function createPreviewScheduler<TPayload, TResult>(
  opts: PreviewSchedulerOptions<TPayload, TResult>,
): PreviewScheduler<TPayload> {
  const delay = opts.delayMs ?? PREVIEW_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Monotonic. `issued` is the newest request; a settled response is only
  // allowed to speak if it carries that number.
  let issued = 0;

  function fire(payload: TPayload) {
    const seq = ++issued;
    opts.onPending?.(true);
    opts
      .fetcher(payload)
      .then((result) => {
        if (seq !== issued) return; // a newer request has already been sent
        opts.onPending?.(false);
        opts.onResult(result);
      })
      .catch((error) => {
        if (seq !== issued) return;
        opts.onPending?.(false);
        opts.onError?.(error);
      });
  }

  return {
    request(payload: TPayload) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fire(payload);
      }, delay);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      // Bumping the counter orphans everything in flight: no settled promise can
      // match it any more, so an unmounting card cannot write into dead state.
      issued++;
      opts.onPending?.(false);
    },
  };
}
