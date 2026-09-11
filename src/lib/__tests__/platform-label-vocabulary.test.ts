// One platform vocabulary across the web app and the browser extension
// (US-3380, the web half of US-3373).
//
// WHAT WENT WRONG. The extension's popup, side panel, worker tab, background
// service worker and Facebook content script all say "Facebook Marketplace".
// src/lib/constants.ts said "Facebook". A seller queues a cross-post from the
// composer, walks to their laptop, and the row the extension shows them is
// named differently from the row they queued. Nothing throws, nothing renders
// broken, and neither screen on its own looks wrong. It only shows up when the
// same person reads both, which is the entire point of the queue.
//
// WHY THIS FILE NAMES NO PLATFORMS. Facebook was found by eye, and an eye finds
// one. A guard that lists the platforms it checks is that same eye with a
// longer attention span: the sixth platform lands, it disagrees, and the guard
// passes. So the keys come out of the extension's own map, exactly the way
// extension-unified/test/platform-label-vocabulary.test.cjs does it from the
// other side, and the day a key is added there it is checked here with no edit
// to this file.
//
// THE TWO MAPS ARE NOT THE SAME SIZE AND ARE NOT MEANT TO BE. MARKETPLACE_LABELS
// carries 12 keys because the web app names channels the Lister has no flow for
// (ebay, depop, etsy, shopify, offerup, whatnot, other). The extension carries
// the 5 it can actually drive. So the invariant is SUBSET-AND-AGREE, never
// equality: every key the extension knows must exist here, and must read the
// same. A web-only key is nobody else's business.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MARKETPLACE_LABELS } from "@/lib/constants";

const QUEUE_VIEW = resolve(
  process.cwd(),
  "extension-unified/queue/queue-view.js",
);

/**
 * The extension's PLATFORM_LABELS, loaded the way the browser loads it.
 *
 * Evaluated rather than regex-scraped on purpose: the shape of that
 * declaration is the extension's business and this file is only entitled to
 * its VALUE. queue-view.js is an IIFE over `self` that touches no DOM at load,
 * which is why extension-unified/test/queue-view.test.cjs can do the same.
 *
 * CRLF is normalized first. This repo's working tree mixes line endings and
 * queue-view.js is CRLF today; `new Function` copes, but a future reader
 * slicing this source should not have to rediscover that.
 */
function extensionPlatformLabels(): Record<string, string> {
  const src = readFileSync(QUEUE_VIEW, "utf8").replace(/\r\n/g, "\n");
  const scope: { GT_QUEUE_VIEW?: { PLATFORM_LABELS?: Record<string, string> } } = {};
  new Function("self", src)(scope);
  const labels = scope.GT_QUEUE_VIEW?.PLATFORM_LABELS;
  if (!labels || typeof labels !== "object") {
    throw new Error(
      "extension-unified/queue/queue-view.js did not export PLATFORM_LABELS on " +
        "self.GT_QUEUE_VIEW. It is the source of truth for this guard; if its " +
        "shape changed, this file needs rewriting rather than deleting.",
    );
  }
  return labels;
}

describe("platform names agree with the browser extension", () => {
  const canon = extensionPlatformLabels();
  const keys = Object.keys(canon);

  // Vacuity guard. An empty or one-key map would make every expectation below
  // a no-op, and this file would pass while the two sides were free to drift.
  it("the extension's map is a real map", () => {
    expect(
      keys.length,
      "expected at least 5 platforms in queue-view.js PLATFORM_LABELS",
    ).toBeGreaterThanOrEqual(5);
    for (const key of keys) {
      expect(typeof canon[key], `PLATFORM_LABELS.${key} must be a string`).toBe(
        "string",
      );
      expect(canon[key]?.trim(), `PLATFORM_LABELS.${key} must not be blank`)
        .toBeTruthy();
    }
  });

  // The second half of the vacuity guard, and the reason this is a subset test
  // rather than an intersection test: if a key were renamed on either side, an
  // intersection would quietly shrink and the value check would stop covering
  // it. Every channel the extension can drive is a channel the web app lists.
  it("every platform the extension drives has a web label", () => {
    const missing = keys.filter(
      (k) => !Object.prototype.hasOwnProperty.call(MARKETPLACE_LABELS, k),
    );
    expect(
      missing,
      "the extension drives platform(s) MARKETPLACE_LABELS cannot name, so a " +
        "queued job would render with a raw key in the web app",
    ).toEqual([]);
  });

  it("every shared platform reads the same on both sides", () => {
    const disagreements = keys
      .filter((k) => Object.prototype.hasOwnProperty.call(MARKETPLACE_LABELS, k))
      .filter(
        (k) => MARKETPLACE_LABELS[k as keyof typeof MARKETPLACE_LABELS] !== canon[k],
      )
      .map(
        (k) =>
          `${k}: web says "${MARKETPLACE_LABELS[k as keyof typeof MARKETPLACE_LABELS]}", ` +
          `extension says "${canon[k]}"`,
      );
    expect(
      disagreements,
      "one vocabulary, and it is queue-view.js's (US-3373/US-3380). A seller " +
        "reads the same queue from both sides; it cannot have two names.",
    ).toEqual([]);
  });
});
