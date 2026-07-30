// US-2108 AC2 — attribution survives a landing on a standalone SSR page.
//
// The gap this closes was mis-diagnosed once already, so it is worth stating
// plainly: the SSR pages (cert, blog, verified, passport) DO NOT MOUNT THE SPA.
// A previous note on this story claimed /cert/:id "renders under RootLayout,
// which calls captureAffiliateRef() on mount" and concluded the only exposure
// was no-JS crawlers. renderLayout emits no #root and no module script, and
// security-headers.ts says outright that these pages are standalone — so a
// visitor opening a shared certificate link ran NO capture code at all. That is
// every visitor in the share loop, not an edge case.
//
// The fix has to satisfy two properties that pull against each other, and both
// are asserted below:
//
//   1. CREDIT IS BANKED. A ?ref= on an SSR landing ends up in localStorage in
//      the exact shape the SPA's redeem path reads.
//   2. THE RESPONSE STAYS CACHEABLE. These pages are shared-edge-cached on
//      origin+pathname with the query string dropped, so the HTML must be
//      byte-identical for every visitor. Rendering the ref into the page would
//      cache the first arriver's code and credit them for everyone else — the
//      exact bug the original refusal was protecting against.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  affiliateCaptureSnippet,
  AFFILIATE_STORAGE_KEY,
} from "../../functions/_shared/affiliate-capture";
import { renderLayout } from "../../functions/_shared/blog-render";
import { flushPendingAffiliateClick, clearStoredAffiliateRef } from "@/lib/affiliate";

/** Run the snippet's JS the way a browser would, in the current jsdom page. */
function runSnippet(nonce = "N0NCE"): void {
  const html = affiliateCaptureSnippet(nonce);
  const js = html.replace(/^<script nonce="[^"]*">/, "").replace(/<\/script>$/, "");
  new Function(js)();
}

function land(search: string): void {
  window.history.replaceState({}, "", `/cert/abc123${search}`);
}

const LAYOUT = {
  title: "T",
  description: "D",
  canonicalUrl: "https://gradethread.com/cert/abc123",
  bodyHtml: "<main>c</main>",
};

describe("the emitted snippet", () => {
  it("is stamped with the response nonce", () => {
    expect(affiliateCaptureSnippet("ABC123")).toContain('<script nonce="ABC123">');
  });

  it("emits nothing without a nonce rather than dead code", () => {
    // The SSR CSP has no 'unsafe-inline', so an unstamped script would be
    // silently blocked — a feature that looks wired up and never runs.
    expect(affiliateCaptureSnippet()).toBe("");
    expect(affiliateCaptureSnippet("")).toBe("");
  });

  it("targets the same storage key the SPA reads", () => {
    // If these drift, the SSR page banks a ref nobody ever redeems.
    expect(AFFILIATE_STORAGE_KEY).toBe("gt_affiliate_ref");
    expect(affiliateCaptureSnippet("N")).toContain('"gt_affiliate_ref"');
  });

  it("ships in the shared layout, so every SSR surface captures", () => {
    // The leak is a property of renderLayout, not of the cert Function — a
    // shared link can carry a ref to any standalone SSR page.
    const html = renderLayout({ ...LAYOUT, nonce: "N" });
    expect(html).toContain(affiliateCaptureSnippet("N"));
  });
});

describe("the response stays safe to shared-edge-cache", () => {
  it("contains no referral code — the ref is read client-side at runtime", () => {
    // The cache key drops the query string. Any per-visitor value baked into
    // these bytes is served to every later visitor of the same certificate.
    const snippet = affiliateCaptureSnippet("N");
    expect(snippet).toContain("window.location.search");
    expect(snippet).not.toMatch(/ref=[A-Za-z0-9]/);
  });

  it("renders identically no matter who is landing", () => {
    const a = renderLayout({ ...LAYOUT, nonce: "N" });
    const b = renderLayout({ ...LAYOUT, nonce: "N" });
    expect(a).toBe(b);
  });
});

describe("landing on an SSR page banks the credit", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("stores a ref in the shape the SPA's redeem path parses", () => {
    land("?ref=seller7&utm_source=certificate");
    runSnippet();
    const stored = JSON.parse(localStorage.getItem(AFFILIATE_STORAGE_KEY) ?? "null");
    expect(stored.code).toBe("SELLER7"); // normalized like captureAffiliateRef
    expect(typeof stored.ts).toBe("number");
  });

  it("no-ops when there is no ref", () => {
    land("?utm_source=certificate");
    runSnippet();
    expect(localStorage.getItem(AFFILIATE_STORAGE_KEY)).toBeNull();
  });

  it("applies the same length rule as captureAffiliateRef", () => {
    // Divergent validation would mean a code that attributes on an SPA landing
    // and silently does not on an SSR one.
    land(`?ref=${"A".repeat(33)}`);
    runSnippet();
    expect(localStorage.getItem(AFFILIATE_STORAGE_KEY)).toBeNull();
  });
});

describe("the parked click ping", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    fetchSpy = vi.fn(() => Promise.resolve(new Response("{}")));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearStoredAffiliateRef();
  });

  it("is NOT sent from the SSR page", () => {
    // It would be a cross-origin POST, and the SSR CSP's connect-src does not
    // allow the edge API. Widening that on the most XSS-sensitive surface to
    // deliver telemetry is the wrong trade.
    land("?ref=SELLER7&utm_source=certificate");
    runSnippet();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is flushed by the first SPA load, carrying the SSR page's context", () => {
    land("?ref=SELLER7&utm_source=certificate");
    runSnippet();

    expect(flushPendingAffiliateClick()).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body));
    expect(body.code).toBe("SELLER7");
    // The source + path describe where the click actually happened, not where
    // it was flushed — otherwise every cert click reports as a homepage hit.
    expect(body.source).toBe("certificate");
    expect(body.path).toBe("/cert/abc123");
  });

  it("sends once, even if the visitor keeps browsing", () => {
    land("?ref=SELLER7&utm_source=certificate");
    runSnippet();

    expect(flushPendingAffiliateClick()).toBe(true);
    expect(flushPendingAffiliateClick()).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("leaves the credit intact after flushing", () => {
    // Clearing the whole entry with the ping would trade a telemetry write for
    // the actual earning event.
    land("?ref=SELLER7&utm_source=certificate");
    runSnippet();
    flushPendingAffiliateClick();

    const stored = JSON.parse(localStorage.getItem(AFFILIATE_STORAGE_KEY) ?? "null");
    expect(stored.code).toBe("SELLER7");
    expect(stored.pendingClick).toBeUndefined();
  });

  it("no-ops for a ref captured by the SPA, which already pinged", () => {
    localStorage.setItem(
      AFFILIATE_STORAGE_KEY,
      JSON.stringify({ code: "SELLER7", ts: Date.now() }),
    );
    expect(flushPendingAffiliateClick()).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("drops a ping whose ref has aged past the attribution window", () => {
    const stale = Date.now() - 31 * 24 * 60 * 60 * 1000;
    localStorage.setItem(
      AFFILIATE_STORAGE_KEY,
      JSON.stringify({
        code: "SELLER7",
        ts: stale,
        pendingClick: { source: "certificate", path: "/cert/abc123", referrer: null },
      }),
    );
    expect(flushPendingAffiliateClick()).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    // Redeem would ignore it anyway — don't leave it to be re-read forever.
    expect(localStorage.getItem(AFFILIATE_STORAGE_KEY)).toBeNull();
  });
});
