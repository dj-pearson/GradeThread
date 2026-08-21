// US-2724 AC4: an undeliverable send settles NOW, a dead port still waits.
//
// WHY A SEPARATE FILE. cross-post-setup.test.ts already "covers" this, in the
// same way it covered numericOr (US-2740): by reading the source.
//
//   expect(src).toContain("if (r && r.undelivered)")
//   expect(src).toContain("export function isUndeliverable")
//
// Those pin that the branch is SPELLED a certain way. AC4 asks for something a
// source scan cannot express — that one reply settles in well under the 130s
// backstop, and that the other still does not settle. That is timing, and it is
// the whole guarantee: US-1874 deliberately does NOT settle on a dead port,
// because the job is usually still running and the durable push will report it.
// Trading that away to fix the hang would be a regression the source scan would
// happily approve.
//
// So this drives the real sender against a stubbed chrome.runtime and a fake
// clock.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const EXTENSION_TIMEOUT_MS = 130000;

const DELIST = {
  platform: "poshmark" as const,
  platformLabel: "Poshmark",
  listingId: "listing-1",
  listingUrl: "https://poshmark.com/listing/x",
};

/** Install a chrome.runtime whose sendMessage fails with `lastError`. */
function stubRuntimeFailing(message: string) {
  const runtime = {
    lastError: undefined as { message?: string } | undefined,
    sendMessage(_id: string, _msg: unknown, cb: (r: unknown) => void) {
      runtime.lastError = { message };
      cb(undefined);
      // Chrome clears lastError once the callback returns.
      runtime.lastError = undefined;
    },
  };
  (globalThis as unknown as { chrome?: unknown }).chrome = { runtime };
  return runtime;
}

/** Track whether a promise has settled, without awaiting it. */
function watch<T>(p: Promise<T>) {
  const state = { settled: false, value: undefined as T | undefined };
  void p.then((v) => {
    state.settled = true;
    state.value = v;
  });
  return state;
}

/** Let queued microtasks run while the clock is frozen. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("US-2724: an undeliverable send does not wait 130 seconds", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_LISTER_EXTENSION_ID", "abcdefghijklmnopabcdefghijklmnop");
    // No bridge marker: an undelivered id-addressed send would otherwise retry
    // over the bridge, which is a different path from the one under test.
    delete document.documentElement.dataset.gtExtBridge;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
    vi.resetModules();
  });

  it("'Receiving end does not exist' settles immediately, not at the backstop", async () => {
    stubRuntimeFailing("Could not establish connection. Receiving end does not exist.");
    const { sendDelistToLister } = await import("@/lib/lister-extension");

    vi.useFakeTimers();
    const state = watch(
      sendDelistToLister(DELIST),
    );

    // Not a single millisecond of the backstop.
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    await flush();

    expect(
      state.settled,
      "an undeliverable send did not settle at once — the seller waits out the " +
        `${EXTENSION_TIMEOUT_MS}ms backstop`,
    ).toBe(true);
    expect(state.value?.ok).toBe(false);
  });

  it("the message names the real cause, and never a marketplace tab", async () => {
    stubRuntimeFailing("Could not establish connection. Receiving end does not exist.");
    const { sendDelistToLister } = await import("@/lib/lister-extension");

    const result = await sendDelistToLister(DELIST);

    const err = String(result.error ?? "");
    // AC3. The backstop text points at a tab that was never opened.
    expect(err).not.toContain("didn't report back");
    expect(err.toLowerCase()).not.toContain("marketplace tab");
    // It should say what to actually do.
    expect(err.toLowerCase()).toContain("extension");
    expect(err.length).toBeGreaterThan(20);
  });

  it("'message port closed' still does NOT settle — US-1874 is preserved", async () => {
    // The guarantee this story must not trade away. The port dying almost always
    // means Chrome suspended the MV3 worker while the job is STILL RUNNING; the
    // background pushes the result home. Settling here would report a failure
    // for a job that is about to succeed.
    stubRuntimeFailing("The message port closed before a response was received.");
    const { sendDelistToLister } = await import("@/lib/lister-extension");

    vi.useFakeTimers();
    const state = watch(
      sendDelistToLister(DELIST),
    );

    await vi.advanceTimersByTimeAsync(1000);
    expect(
      state.settled,
      "a dead port settled early — the durable-push guarantee (US-1874) has been " +
        "traded away, and a job that is still running will be reported as failed",
    ).toBe(false);

    // It must still settle eventually, at the backstop and not before.
    await vi.advanceTimersByTimeAsync(EXTENSION_TIMEOUT_MS);
    vi.useRealTimers();
    await flush();
    expect(state.settled, "a dead port never settled at all").toBe(true);
  });
});

describe("US-2724: which Chrome errors mean nobody received it", () => {
  it("classifies the three non-delivery messages", async () => {
    const { isUndeliverable } = await import("@/lib/lister-extension");
    expect(isUndeliverable("Could not establish connection. Receiving end does not exist.")).toBe(true);
    expect(isUndeliverable("Receiving end does not exist")).toBe(true);
    // US-2733: reloading an unpacked extension orphans the content scripts in
    // open tabs. Nothing gets the message and no push is coming.
    expect(isUndeliverable("Extension context invalidated.")).toBe(true);
  });

  it("a dead port is NOT non-delivery", async () => {
    const { isUndeliverable } = await import("@/lib/lister-extension");
    expect(isUndeliverable("The message port closed before a response was received.")).toBe(false);
  });

  it("an unrecognised error is treated as recoverable", async () => {
    // Wrongly settling a live job is worse than a slow failure, so anything we
    // do not recognise keeps waiting for the push.
    const { isUndeliverable } = await import("@/lib/lister-extension");
    expect(isUndeliverable("Some future Chrome wording nobody has seen")).toBe(false);
    expect(isUndeliverable(undefined)).toBe(false);
    expect(isUndeliverable("")).toBe(false);
  });

  it("matching is case-insensitive, since Chrome has reworded these before", async () => {
    const { isUndeliverable } = await import("@/lib/lister-extension");
    expect(isUndeliverable("RECEIVING END DOES NOT EXIST")).toBe(true);
  });
});
