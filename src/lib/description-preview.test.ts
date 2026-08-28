// US-2960: the preview panel's two non-obvious guarantees.
//
// Debounce is the visible one. The one that would have shipped broken is the
// other: two renders in flight can settle in either order, and a SLOW earlier
// response landing after a FAST later one puts stale bytes under a seller who is
// about to publish them. Both are timer- and promise-shaped, so they are tested
// here on the scheduler rather than guessed at through a mounted card.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPreviewScheduler,
  PREVIEW_DEBOUNCE_MS,
} from "@/lib/description-preview";

/** A fetcher whose every call is resolved by hand, so ordering is the test's choice. */
function deferredFetcher() {
  const pending: { payload: string; resolve: (v: string) => void; reject: (e: unknown) => void }[] = [];
  const fetcher = (payload: string) =>
    new Promise<string>((resolve, reject) => {
      pending.push({ payload, resolve, reject });
    });
  return { fetcher, pending };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("createPreviewScheduler (US-2960)", () => {
  it("waits the debounce window before asking the server", () => {
    const { fetcher, pending } = deferredFetcher();
    const s = createPreviewScheduler({ fetcher, onResult: () => {} });

    s.request("a");
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS - 1);
    expect(pending).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(pending.map((p) => p.payload)).toEqual(["a"]);
  });

  it("collapses a burst of edits into ONE request, carrying the last one", () => {
    const { fetcher, pending } = deferredFetcher();
    const s = createPreviewScheduler({ fetcher, onResult: () => {} });

    for (const c of ["a", "ab", "abc", "abcd"]) {
      s.request(c);
      vi.advanceTimersByTime(100);
    }
    expect(pending).toHaveLength(0);
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    expect(pending.map((p) => p.payload)).toEqual(["abcd"]);
  });

  it("drops a stale response that lands after a newer one", async () => {
    const { fetcher, pending } = deferredFetcher();
    const seen: string[] = [];
    const s = createPreviewScheduler({ fetcher, onResult: (r) => seen.push(r) });

    s.request("first");
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    s.request("second");
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    expect(pending).toHaveLength(2);

    // The NEWER one comes back first, then the older one settles.
    pending[1]!.resolve("render of second");
    await Promise.resolve();
    pending[0]!.resolve("render of first");
    await Promise.resolve();
    await Promise.resolve();

    expect(seen).toEqual(["render of second"]);
  });

  it("does not report an error from a request that has been superseded", async () => {
    const { fetcher, pending } = deferredFetcher();
    const errors: unknown[] = [];
    const seen: string[] = [];
    const s = createPreviewScheduler({
      fetcher,
      onResult: (r) => seen.push(r),
      onError: (e) => errors.push(e),
    });

    s.request("first");
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    s.request("second");
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);

    pending[1]!.resolve("render of second");
    await Promise.resolve();
    pending[0]!.reject(new Error("gateway timeout"));
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toEqual([]);
    expect(seen).toEqual(["render of second"]);
  });

  it("reports pending across the newest request only", async () => {
    const { fetcher, pending } = deferredFetcher();
    const states: boolean[] = [];
    const s = createPreviewScheduler({
      fetcher,
      onResult: () => {},
      onPending: (p) => states.push(p),
    });

    s.request("a");
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    expect(states).toEqual([true]);
    pending[0]!.resolve("x");
    await Promise.resolve();
    await Promise.resolve();
    expect(states).toEqual([true, false]);
  });

  it("cancel() drops the pending timer and orphans what is in flight", async () => {
    const { fetcher, pending } = deferredFetcher();
    const seen: string[] = [];
    const s = createPreviewScheduler({ fetcher, onResult: (r) => seen.push(r) });

    s.request("a");
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS);
    s.cancel();
    pending[0]!.resolve("late");
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([]);

    // And a request queued before cancel never fires at all.
    s.request("b");
    s.cancel();
    vi.advanceTimersByTime(PREVIEW_DEBOUNCE_MS * 3);
    expect(pending).toHaveLength(1);
  });
});
