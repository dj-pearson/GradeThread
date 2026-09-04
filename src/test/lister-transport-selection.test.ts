// US-1882: which transport a seller job actually leaves the page on.
//
// The story adds a SECOND transport. `externally_connectable` (page →
// chrome.runtime.sendMessage(extId, …)) is Chromium-only by platform design, so
// Firefox rides the gradethread.com content script (extension-unified/gt-bridge.js)
// relaying a `window.postMessage` envelope to the background instead.
//
// Two properties are worth pinning, and neither is visible in a type:
//
//  1. NO REGRESSION ON CHROMIUM (AC4). When externally_connectable is available it
//     must still carry the job — and the page must NOT also post a bridge envelope.
//     Both transports converge on the same background handler, so a page that
//     quietly did both would double-list an item and look fine in code review.
//  2. THE FIREFOX PATH IS COMPLETE (AC2). The envelope carries a correlation id, a
//     reply quoting a different id must not settle it, and the US-1874 semantics
//     (a transportError keeps waiting; the durable push settles) hold over the
//     bridge exactly as they do over the runtime port.
//
// Everything here was previously "verified by reading the code", which is how the
// preference silently inverts the first time someone reorders the branches.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  extensionWebStoreUrl,
  isListerAvailable,
  sendToLister,
  type ListerPayload,
} from "@/lib/lister-extension";
import { CHROME_WEB_STORE_URL } from "@/lib/app-links";

const PAYLOAD = { platform: "poshmark", title: "Test" } as unknown as ListerPayload;

interface BridgeEnvelope {
  __gtExtReq?: boolean;
  id?: string;
  message?: { type?: string; clientRef?: string; [k: string]: unknown };
}

let runtimeMessage: { type?: string; clientRef?: string } | null = null;

/** Chromium: the page-side chrome.runtime externally_connectable shim. */
function installChrome(
  respond: (cb: (r: unknown) => void) => void,
  lastError?: { message?: string },
) {
  runtimeMessage = null;
  (globalThis as unknown as { chrome?: unknown }).chrome = {
    runtime: {
      sendMessage: (_id: string, message: unknown, cb: (r: unknown) => void) => {
        runtimeMessage = message as { type?: string; clientRef?: string };
        respond(cb);
      },
      get lastError() {
        return lastError;
      },
    },
  };
}

/** The bridge content script's install marker (set at document_start). */
function installMarker() {
  document.documentElement.dataset.gtExtBridge = "1";
}

/**
 * Deliver a page message the way a real browser does. jsdom sets `source` to null
 * on a self-post, while every real browser sets it to the posting window — and the
 * `event.source !== window` check is a deliberate guard, so the test has to
 * reproduce browser semantics rather than jsdom's.
 */
function deliver(data: unknown) {
  window.dispatchEvent(
    new MessageEvent("message", { data, source: window, origin: window.location.origin }),
  );
}

/** gt-bridge.js relaying the background's answer back to the page. */
function bridgeReply(id: string, response: Record<string, unknown>) {
  deliver({ __gtExtRes: true, id, response });
}

/** The background pushing a job outcome to the originating tab (US-1874). */
function pushResult(clientRef: string, result: Record<string, unknown>) {
  deliver({ __gtExtPush: true, jobId: "job-x", clientRef, result });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Record every page message the code under test posts, without delivering it. */
function capturePosts(): BridgeEnvelope[] {
  const posts: BridgeEnvelope[] = [];
  vi.spyOn(window, "postMessage").mockImplementation(((data: unknown) => {
    posts.push(data as BridgeEnvelope);
  }) as typeof window.postMessage);
  return posts;
}

function firstEnvelope(posts: BridgeEnvelope[]): BridgeEnvelope {
  const env = posts.find((p) => p && p.__gtExtReq === true);
  if (!env) throw new Error("no bridge envelope was posted");
  return env;
}

describe("US-1882: transport selection", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_LISTER_EXTENSION", "true");
    vi.stubEnv("VITE_LISTER_EXTENSION_ID", "test-ext-id");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
    delete document.documentElement.dataset.gtExtBridge;
  });

  // ── AC4: Chromium keeps using externally_connectable ──────────────────────

  it("uses externally_connectable on Chromium and posts NO bridge envelope", async () => {
    installMarker(); // the bridge is installed too — Chromium must still prefer runtime
    installChrome((respond) => respond({ ok: true, filled: true }));
    const posts = capturePosts();

    const r = await sendToLister(PAYLOAD);

    expect(r).toMatchObject({ ok: true, filled: true });
    expect(runtimeMessage?.type).toBe("GT_LISTER_LIST");
    // The regression this guards: sending over BOTH transports would run the job
    // twice in the background and still resolve looking healthy.
    expect(posts.filter((p) => p && p.__gtExtReq === true)).toHaveLength(0);
  });

  it("falls back to the bridge on Chromium when no extension id is configured", async () => {
    // The id is a build-time env var; without it the runtime transport has no
    // address to send to, so the bridge (which needs no id) is the correct pick.
    vi.stubEnv("VITE_LISTER_EXTENSION_ID", "");
    installMarker();
    installChrome((respond) => respond({ ok: true }));
    const posts = capturePosts();

    void sendToLister(PAYLOAD);
    await flush();

    expect(firstEnvelope(posts).message?.type).toBe("GT_LISTER_LIST");
    expect(runtimeMessage).toBeNull();
  });

  // ── AC2: the Firefox bridge path ──────────────────────────────────────────

  it("sends over the bridge when externally_connectable is absent (Firefox)", async () => {
    installMarker();
    const posts = capturePosts();

    let settled = false;
    const p = sendToLister(PAYLOAD).then((r) => {
      settled = true;
      return r;
    });
    await flush();

    const env = firstEnvelope(posts);
    expect(typeof env.id).toBe("string");
    expect(env.message?.type).toBe("GT_LISTER_LIST");
    // The clientRef still rides along, so the durable push can correlate.
    expect(typeof env.message?.clientRef).toBe("string");

    // A reply quoting somebody else's correlation id must not settle ours.
    bridgeReply("gt-not-ours", { ok: true, filled: true });
    await flush();
    expect(settled).toBe(false);

    bridgeReply(env.id!, { ok: true, filled: true, photosTotal: 8, photosFailed: 0 });
    await expect(p).resolves.toMatchObject({ ok: true, filled: true, photosTotal: 8 });
  });

  it("keeps the US-1874 semantics over the bridge: transportError waits, the push settles", async () => {
    installMarker();
    const posts = capturePosts();

    let settled = false;
    const p = sendToLister(PAYLOAD).then((r) => {
      settled = true;
      return r;
    });
    await flush();
    const env = firstEnvelope(posts);

    // Firefox's event page can be torn down mid-job exactly like an MV3 worker;
    // gt-bridge.js reports that as a transportError. The job is still alive.
    bridgeReply(env.id!, { ok: false, transportError: true, error: "Extension error." });
    await flush();
    expect(settled).toBe(false);

    pushResult(env.message!.clientRef as string, {
      ok: true,
      filled: true,
      listingUrl: "https://poshmark.com/listing/ff",
    });
    await expect(p).resolves.toMatchObject({
      ok: true,
      listingUrl: "https://poshmark.com/listing/ff",
    });
  });

  it("settles a real extension answer over the bridge without waiting for a push", async () => {
    installMarker();
    const posts = capturePosts();
    const p = sendToLister(PAYLOAD);
    await flush();
    bridgeReply(firstEnvelope(posts).id!, {
      ok: false,
      needsUpgrade: true,
      error: "Cross-listing is a FlipDesk seller feature.",
    });
    await expect(p).resolves.toMatchObject({ ok: false, needsUpgrade: true });
  });

  it("resolves 'not detected' instead of hanging when neither transport exists", async () => {
    const r = await sendToLister(PAYLOAD);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not detected/i);
  });

  // ── AC2: isListerAvailable reflects EITHER transport ───────────────────────

  describe("isListerAvailable", () => {
    it("is true from the bridge marker alone (Firefox has no extension id path)", () => {
      installMarker();
      expect(isListerAvailable()).toBe(true);
    });

    it("is true from externally_connectable + a configured id", () => {
      installChrome((respond) => respond({ ok: true }));
      expect(isListerAvailable()).toBe(true);
    });

    it("is false with no marker and no id, even on a Chromium page", () => {
      vi.stubEnv("VITE_LISTER_EXTENSION_ID", "");
      installChrome((respond) => respond({ ok: true }));
      expect(isListerAvailable()).toBe(false);
    });

    it("is false whenever the feature flag is off, whatever is installed", () => {
      vi.stubEnv("VITE_LISTER_EXTENSION", "false");
      installMarker();
      installChrome((respond) => respond({ ok: true }));
      expect(isListerAvailable()).toBe(false);
    });
  });

  // ── US-2718 AC4: the install link a seller without the extension is sent to ──
  //
  // This was the half of AC4 that only ever existed as a SOURCE SCAN
  // (cross-post-setup.test.ts asserts the string "extensionWebStoreUrl()"
  // appears). A scan cannot tell a working link from one that returns null,
  // which is exactly what it did for as long as VITE_LISTER_EXTENSION_ID sat
  // blank: the notice rendered with nowhere to go.

  describe("extensionWebStoreUrl", () => {
    it("builds a Chrome Web Store URL from the configured id", () => {
      vi.stubEnv("VITE_LISTER_EXTENSION_ID", "apinefjjagmigmobdlbiilhbjebmjkdh");
      expect(extensionWebStoreUrl()).toBe(
        "https://chromewebstore.google.com/detail/apinefjjagmigmobdlbiilhbjebmjkdh",
      );
    });

    it("falls back to the PUBLISHED listing with no id, never to a dead link", () => {
      // US-3110 changed this. It used to return null, on the reasoning that a
      // URL ending in an empty path segment links to the store's 404 and null
      // is the honest answer — correct while the extension was unpublished.
      //
      // It is published now, so null stopped being honest and started being the
      // same bug in a different place: every deployment with a blank
      // VITE_LISTER_EXTENSION_ID rendered "Add to Chrome" with nowhere to go,
      // which is the exact defect the block above this one was written about.
      // A real store URL is the better default; the empty-segment URL this test
      // was guarding against is still never built (see the id branch).
      vi.stubEnv("VITE_LISTER_EXTENSION_ID", "");
      vi.stubEnv("VITE_EXTENSION_WEBSTORE_URL", "");
      expect(extensionWebStoreUrl()).toBe(CHROME_WEB_STORE_URL);
      expect(CHROME_WEB_STORE_URL).toContain("chromewebstore.google.com/detail/");
    });

    it("an explicit override wins, which is how Firefox gets an AMO link", () => {
      // The id is Chrome's. Firefox reaches the extension through the bridge and
      // never uses that id, so its install link cannot be derived from one.
      vi.stubEnv("VITE_EXTENSION_WEBSTORE_URL", "https://addons.mozilla.org/addon/gradethread/");
      vi.stubEnv("VITE_LISTER_EXTENSION_ID", "apinefjjagmigmobdlbiilhbjebmjkdh");
      expect(extensionWebStoreUrl()).toBe("https://addons.mozilla.org/addon/gradethread/");
    });

    it("a whitespace-only override does not win", () => {
      // An env var set to " " in a dashboard is set as far as the shell is
      // concerned. Without the trim it would beat a perfectly good id and
      // return a blank href.
      vi.stubEnv("VITE_EXTENSION_WEBSTORE_URL", "   ");
      vi.stubEnv("VITE_LISTER_EXTENSION_ID", "apinefjjagmigmobdlbiilhbjebmjkdh");
      expect(extensionWebStoreUrl()).toContain("chromewebstore.google.com");
    });
  });
});
