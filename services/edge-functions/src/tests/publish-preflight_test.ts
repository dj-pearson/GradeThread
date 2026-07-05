// US-473 + US-566: publish pre-flight — image cap/de-dup/order, category
// condition allow-list validation, and image reachability probing.

import { assertEquals } from "@std/assert";
import {
  checkImageReachability,
  CONDITION_ENUM_TO_ID,
  conditionOptionsForCategory,
  dedupeAndCapImages,
  EBAY_MAX_IMAGES,
  imageCapBlocker,
  reachabilityBlocker,
  remapConditionForCategory,
  validateConditionForCategory,
} from "../lib/publish-preflight.ts";

// ── apparel condition family (2990/3010) — the Dress/Women's-Sweaters set ──────

// The exact allow-list eBay returns for apparel leaves like Dresses.
const APPAREL_CONDITIONS = ["1000", "1500", "1750", "2990", "3000", "3010"];

Deno.test("apparel enums map to the right conditionIds (2990/3010)", () => {
  assertEquals(CONDITION_ENUM_TO_ID.PRE_OWNED_EXCELLENT, "2990");
  assertEquals(CONDITION_ENUM_TO_ID.PRE_OWNED_FAIR, "3010");
});

Deno.test("apparel condition is accepted (no blocker) in an apparel category", () => {
  assertEquals(validateConditionForCategory("PRE_OWNED_EXCELLENT", APPAREL_CONDITIONS), null);
  assertEquals(validateConditionForCategory("PRE_OWNED_FAIR", APPAREL_CONDITIONS), null);
});

Deno.test("apparel remap never overstates: LIKE_NEW → nearest worse allowed (Pre-owned Excellent)", () => {
  // Like new (2750) is rejected by apparel → step DOWN to the nearest allowed of
  // equal-or-worse quality: 2990 (PRE_OWNED_EXCELLENT). Never jumps to a NEW_* id.
  assertEquals(remapConditionForCategory("LIKE_NEW", APPAREL_CONDITIONS), "PRE_OWNED_EXCELLENT");
});

Deno.test("apparel remap never overstates: USED_EXCELLENT(3000) stays, not upgraded to 2990", () => {
  // 3000 is allowed → unchanged (never jump UP to Excellent/2990).
  assertEquals(remapConditionForCategory("USED_EXCELLENT", APPAREL_CONDITIONS), "USED_EXCELLENT");
});

Deno.test("legacy USED_GOOD in an apparel category → safe block (never a cross-family overstate)", () => {
  // "Good" (5000) is a LEGACY tier; the apparel set shares id 3000 for a
  // different meaning, so there's no safe linear remap. Rather than risk
  // overstating, remap returns null and validate surfaces the fixable blocker —
  // the seller then picks a real apparel condition from the (now category-aware)
  // dropdown.
  assertEquals(remapConditionForCategory("USED_GOOD", APPAREL_CONDITIONS), null);
  const msg = validateConditionForCategory("USED_GOOD", APPAREL_CONDITIONS);
  assertEquals(typeof msg, "string");
  assertEquals(msg!.includes("Change the condition in the composer"), true);
});

Deno.test("conditionOptionsForCategory: apparel set → selectable options, best→worst, 3000='Good'", () => {
  const { options, allowedLabels } = conditionOptionsForCategory(APPAREL_CONDITIONS);
  assertEquals(
    options.map((o) => o.value),
    [
      "NEW",
      "NEW_OTHER",
      "NEW_WITH_DEFECTS",
      "PRE_OWNED_EXCELLENT",
      "USED_EXCELLENT",
      "PRE_OWNED_FAIR",
    ],
  );
  // In the apparel family the shared id 3000 is labeled "Pre-owned - Good"
  // (not the generic "Used / pre-owned") so it doesn't duplicate 2990's label.
  assertEquals(options.find((o) => o.value === "USED_EXCELLENT")?.label, "Pre-owned - Good");
  assertEquals(options.find((o) => o.value === "PRE_OWNED_EXCELLENT")?.label, "Pre-owned - Excellent");
  assertEquals(allowedLabels.includes("Pre-owned - Fair"), true);
});

Deno.test("conditionOptionsForCategory: empty allow-list → empty (caller uses static list)", () => {
  assertEquals(conditionOptionsForCategory([]), { options: [], allowedLabels: [] });
});

Deno.test("conditionOptionsForCategory: non-apparel keeps 3000 as the generic 'Used / pre-owned'", () => {
  const { options } = conditionOptionsForCategory(["1000", "3000", "4000", "5000"]);
  assertEquals(options.find((o) => o.value === "USED_EXCELLENT")?.label, "Used / pre-owned");
});

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

// ── condition auto-pick (remap) ────────────────────────────────────────

Deno.test("remap keeps an already-allowed condition unchanged", () => {
  assertEquals(
    remapConditionForCategory("USED_EXCELLENT", ["1000", "1500", "3000"]),
    "USED_EXCELLENT",
  );
});

Deno.test("remap leaves condition untouched when allow-list is empty/unknown", () => {
  assertEquals(remapConditionForCategory("LIKE_NEW", []), "LIKE_NEW");
});

Deno.test("remap downgrades a rejected condition to the nearest worse allowed", () => {
  // The classic apparel failure: LIKE_NEW (2750) rejected; category allows
  // New-with-tags (1000), New-without-tags (1500), Used (3000). Never overstate,
  // so fall to the nearest EQUAL-OR-WORSE → USED_EXCELLENT (3000).
  assertEquals(
    remapConditionForCategory("LIKE_NEW", ["1000", "1500", "3000"]),
    "USED_EXCELLENT",
  );
  // NEW_OTHER (1500) rejected, only Used tiers allowed → nearest worse 3000.
  assertEquals(
    remapConditionForCategory("NEW_OTHER", ["3000", "4000"]),
    "USED_EXCELLENT",
  );
});

Deno.test("remap never overstates: blocks (null) when only better conditions allowed", () => {
  // Item graded USED_GOOD (5000) but the category accepts only New → no honest
  // equal-or-worse option, so signal the caller to block rather than upgrade.
  assertEquals(remapConditionForCategory("USED_GOOD", ["1000", "1500"]), null);
});

Deno.test("remap returns null when only unrepresentable (refurb) conditions allowed", () => {
  // 2000/2010 (refurbished) have no enum we emit → can't honestly remap.
  assertEquals(remapConditionForCategory("USED_EXCELLENT", ["2000", "2010"]), null);
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
