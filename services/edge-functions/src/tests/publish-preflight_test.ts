// US-473 + US-566: publish pre-flight — image cap/de-dup/order, category
// condition allow-list validation, and image reachability probing.

import { assertEquals } from "@std/assert";
import {
  checkImageReachability,
  CONDITION_ENUM_TO_ID,
  dedupeAndCapImages,
  EBAY_MAX_IMAGES,
  imageCapBlocker,
  reachabilityBlocker,
  validateConditionForCategory,
} from "../lib/publish-preflight.ts";

// ── image cap / de-dup / order ─────────────────────────────────────────

Deno.test("dedupe drops empties and duplicates, preserves order", () => {
  const r = dedupeAndCapImages(["a", "", null, "b", "a", "  ", "c"]);
  assertEquals(r.urls, ["a", "b", "c"]);
  assertEquals(r.duplicatesRemoved, 1); // the second "a"
  assertEquals(r.dropped, 0);
});

Deno.test("caps to eBay's 24-image limit and reports dropped", () => {
  const urls = Array.from({ length: 30 }, (_, i) => `img-${i}`);
  const r = dedupeAndCapImages(urls);
  assertEquals(r.urls.length, EBAY_MAX_IMAGES);
  assertEquals(r.urls[0], "img-0"); // order (cover first) preserved
  assertEquals(r.dropped, 6);
});

Deno.test("imageCapBlocker only fires over the cap, not on duplicates", () => {
  assertEquals(imageCapBlocker(dedupeAndCapImages(["a", "a", "b"])), null);
  const over = dedupeAndCapImages(Array.from({ length: 26 }, (_, i) => `i${i}`));
  const msg = imageCapBlocker(over);
  assertEquals(typeof msg, "string");
  assertEquals(msg!.includes("Remove 2"), true);
  assertEquals(msg!.includes("24"), true);
});

// ── condition vs. category allow-list ──────────────────────────────────

Deno.test("condition enum→id mapping covers every EbayCondition value", () => {
  assertEquals(CONDITION_ENUM_TO_ID.NEW, "1000");
  assertEquals(CONDITION_ENUM_TO_ID.USED_EXCELLENT, "3000");
  assertEquals(CONDITION_ENUM_TO_ID.FOR_PARTS_OR_NOT_WORKING, "7000");
});

Deno.test("valid condition for the category → no blocker", () => {
  // USED_EXCELLENT → 3000, which the category allows.
  assertEquals(
    validateConditionForCategory("USED_EXCELLENT", ["1000", "3000"]),
    null,
  );
});

Deno.test("unrestricted / unknown category → no blocker", () => {
  assertEquals(validateConditionForCategory("USED_GOOD", []), null);
});

Deno.test("disallowed condition → fixable blocker naming allowed conditions", () => {
  // A NEW-only category rejects a used condition.
  const msg = validateConditionForCategory("USED_ACCEPTABLE", ["1000", "1500"]);
  assertEquals(typeof msg, "string");
  assertEquals(msg!.includes("Acceptable"), true);
  assertEquals(msg!.includes("New"), true);
});

// ── image reachability ─────────────────────────────────────────────────

Deno.test("reachability flags only definitive 404/410/403", async () => {
  const statusByUrl: Record<string, number> = {
    ok: 200,
    gone: 410,
    missing: 404,
    forbidden: 403,
    flaky: 500, // transient → treated as reachable
  };
  const r = await checkImageReachability(
    ["ok", "gone", "missing", "forbidden", "flaky"],
    (url) =>
      Promise.resolve({ ok: statusByUrl[url] < 400, status: statusByUrl[url] }),
  );
  assertEquals(r.unreachable.sort(), ["forbidden", "gone", "missing"]);
});

Deno.test("network errors are treated as reachable (best-effort)", async () => {
  const r = await checkImageReachability(["x"], () =>
    Promise.reject(new Error("ECONNRESET")));
  assertEquals(r.unreachable, []);
  assertEquals(reachabilityBlocker(r), null);
});

Deno.test("reachabilityBlocker phrases the unreachable set", () => {
  const msg = reachabilityBlocker({ unreachable: ["a", "b"] });
  assertEquals(msg!.includes("2 photos"), true);
});
