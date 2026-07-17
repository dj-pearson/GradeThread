// US-1874: the SaaS side of durable Lister job delivery (src/lib/lister-extension.ts).
//
// THE BUG THIS GUARDS. A cross-post job outlives the message that started it.
// Chrome kills an idle MV3 service worker ~30s after its last event — routinely
// while a cold Poshmark/Mercari tab is still loading — and that closes the
// sendResponse port the old code treated as the ONLY delivery path. Chromium then
// invokes our callback with lastError ("The message port closed before a response
// was received"). The job itself is still running and will still finish.
//
// So the two properties below are the whole fix, and they pull in opposite
// directions, which is why they need a test:
//   1. a transport error must NOT settle the promise (the job is still alive —
//      settling would report a failure for a cross-post that then succeeds), and
//   2. the background's push MUST settle it (that is the durable path home).
//
// Getting (1) wrong reintroduces the bug in a worse form: a confident, wrong
// "failed" that pushes the seller into posting a duplicate listing.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendToLister, type ListerPayload } from "@/lib/lister-extension";

// Minimal payload — these tests are about DELIVERY, not payload assembly.
const PAYLOAD = { platform: "poshmark", title: "Test" } as unknown as ListerPayload;

type Responder = (respond: (r: unknown) => void) => void;

// The clientRef is minted inside sendToLister, so the stub records it on the way
// out; a push has to quote it back for the page to correlate the result.
let capturedRef: string | null = null;

/**
 * Install a fake chrome.runtime. `respond` drives what the callback does;
 * `lastError` emulates Chromium's port-closed signal.
 */
function installChrome(respond: Responder, lastError?: { message?: string }) {
  capturedRef = null;
  (globalThis as unknown as { chrome?: unknown }).chrome = {
    runtime: {
      sendMessage: (_id: string, message: unknown, cb: (r: unknown) => void) => {
        capturedRef = (message as { clientRef?: string })?.clientRef ?? null;
        respond(cb);
      },
      get lastError() {
        return lastError;
      },
    },
  };
}

function clientRef(): string {
  if (!capturedRef) throw new Error("the send did not carry a clientRef");
  return capturedRef;
}

/**
 * Emulate gt-bridge.js relaying a background push into the page.
 *
 * Dispatched as an explicit MessageEvent with `source: window` rather than via
 * window.postMessage, because jsdom sets `source` to NULL on a self-post while real
 * browsers set it to the posting window. The listener's `event.source !== window`
 * check is a deliberate guard (it is what keeps a cross-frame message from being
 * mistaken for our bridge, and the pre-existing sendViaBridge uses the same check),
 * so the test has to reproduce real browser semantics instead of jsdom's.
 */
function pushFromExtension(ref: string, result: Record<string, unknown>) {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { __gtExtPush: true, jobId: "job-x", clientRef: ref, result },
      source: window,
      origin: window.location.origin,
    }),
  );
}

/** Let the postMessage macrotask flush. */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** The worker died: callback fires with no response and lastError set. */
const PORT_CLOSED: Responder = (respond) => respond(undefined);
const PORT_CLOSED_ERR = { message: "The message port closed before a response was received." };

describe("US-1874: durable Lister job delivery", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_LISTER_EXTENSION", "true");
    vi.stubEnv("VITE_LISTER_EXTENSION_ID", "test-ext-id");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  it("resolves from the callback when the worker survives (fast path)", async () => {
    installChrome((respond) =>
      respond({ ok: true, filled: true, listingUrl: "https://poshmark.com/listing/1" }),
    );
    const r = await sendToLister(PAYLOAD);
    expect(r.ok).toBe(true);
    expect(r.listingUrl).toBe("https://poshmark.com/listing/1");
  });

  it("sends a clientRef so a later push can be correlated", async () => {
    installChrome((respond) => respond({ ok: true }));
    await sendToLister(PAYLOAD);
    expect(typeof clientRef()).toBe("string");
    expect(clientRef().length).toBeGreaterThan(0);
  });

  it("does NOT settle on a port-closed transport error — the job is still alive", async () => {
    installChrome(PORT_CLOSED, PORT_CLOSED_ERR);

    let settled = false;
    const p = sendToLister(PAYLOAD).then((r) => {
      settled = true;
      return r;
    });

    await flush();
    // The old code resolved here with a bogus failure. It must stay pending.
    expect(settled).toBe(false);

    // ...and the push is what actually delivers the outcome.
    pushFromExtension(clientRef(), {
      ok: true,
      filled: true,
      listingUrl: "https://poshmark.com/listing/9",
    });

    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.listingUrl).toBe("https://poshmark.com/listing/9");
  });

  it("delivers a timeout reported via the push", async () => {
    installChrome(PORT_CLOSED, PORT_CLOSED_ERR);
    const p = sendToLister(PAYLOAD);
    await flush();
    pushFromExtension(clientRef(), {
      ok: false,
      timedOut: true,
      error: "Timed out waiting for the Poshmark form. List manually if the tab didn't prefill.",
    });
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(r.error).toMatch(/Poshmark/);
  });

  it("surfaces a late success so the seller doesn't post a duplicate", async () => {
    installChrome(PORT_CLOSED, PORT_CLOSED_ERR);
    const p = sendToLister(PAYLOAD);
    await flush();
    pushFromExtension(clientRef(), {
      ok: true,
      filled: true,
      late: true,
      listingUrl: "https://poshmark.com/listing/late",
    });
    const r = await p;
    expect(r.late).toBe(true);
    expect(r.ok).toBe(true);
  });

  it("surfaces an immediate tab-closed error rather than a long silence", async () => {
    installChrome(PORT_CLOSED, PORT_CLOSED_ERR);
    const p = sendToLister(PAYLOAD);
    await flush();
    pushFromExtension(clientRef(), {
      ok: false,
      tabClosed: true,
      error: "The Poshmark tab was closed before the form was filled.",
    });
    const r = await p;
    expect(r.tabClosed).toBe(true);
    expect(r.timedOut).toBeUndefined();
  });

  it("ignores a push carrying somebody else's clientRef", async () => {
    installChrome(PORT_CLOSED, PORT_CLOSED_ERR);
    let settled = false;
    const p = sendToLister(PAYLOAD).then((r) => {
      settled = true;
      return r;
    });
    await flush();

    // Another tab's job (or a stray page message) must not settle ours.
    pushFromExtension("not-our-ref", { ok: true, filled: true });
    await flush();
    expect(settled).toBe(false);

    pushFromExtension(clientRef(), { ok: true, filled: true });
    await expect(p).resolves.toMatchObject({ ok: true });
  });

  it("still settles from a real extension error (not every failure is a transport error)", async () => {
    // A genuine extension answer — e.g. the seller gate — must resolve immediately
    // rather than hang waiting for a push that will never come.
    installChrome((respond) =>
      respond({ ok: false, needsUpgrade: true, error: "Cross-listing is a FlipDesk seller feature." }),
    );
    const r = await sendToLister(PAYLOAD);
    expect(r.ok).toBe(false);
    expect(r.needsUpgrade).toBe(true);
  });
});
