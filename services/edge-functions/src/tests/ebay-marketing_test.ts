// US-561: Promoted Listings ad-rate resolution. These cover the PURE rate
// helpers — the category suggestion, the clamp bounds, and the publish-time
// resolution order (opt-out → chosen rate → category suggestion).
//
// ebay-marketing.ts -> ebay-client.ts -> supabase, which throw at init without
// env. Dummy-env then dynamic-import (mirrors demand-terms_test.ts).

import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);
// Force a known baseline so the env-override path is deterministic.
Deno.env.delete("EBAY_DEFAULT_AD_RATE");

const {
  suggestedAdRateForCategory,
  recommendationApiSupported,
  resolvePublishAdRate,
  MIN_AD_RATE_PCT,
  MAX_AD_RATE_PCT,
} = await import("../lib/ebay-marketing.ts");

Deno.test("suggestedAdRateForCategory: baseline for unknown/empty category", () => {
  assertEquals(suggestedAdRateForCategory(null), 8);
  assertEquals(suggestedAdRateForCategory(undefined), 8);
  assertEquals(suggestedAdRateForCategory("99999999"), 8);
});

Deno.test("suggestedAdRateForCategory: higher rate for high-demand categories", () => {
  assertEquals(suggestedAdRateForCategory("15709"), 11); // sneakers
  assertEquals(suggestedAdRateForCategory("169291"), 11); // handbags
});

Deno.test("resolvePublishAdRate: opt-out wins → null", () => {
  assertEquals(
    resolvePublishAdRate({ optOut: true, chosenRatePct: 12, categoryId: "15709" }),
    null,
  );
});

Deno.test("resolvePublishAdRate: chosen rate wins over suggestion (clamped)", () => {
  assertEquals(
    resolvePublishAdRate({ optOut: false, chosenRatePct: 5, categoryId: "15709" }),
    5,
  );
  // Above the cap clamps down to MAX.
  assertEquals(
    resolvePublishAdRate({ optOut: false, chosenRatePct: 99, categoryId: null }),
    MAX_AD_RATE_PCT,
  );
  // Below the floor clamps up to MIN.
  assertEquals(
    resolvePublishAdRate({ optOut: false, chosenRatePct: 0.5, categoryId: null }),
    MIN_AD_RATE_PCT,
  );
});

Deno.test("resolvePublishAdRate: no chosen rate falls back to the category suggestion", () => {
  assertEquals(
    resolvePublishAdRate({ optOut: false, chosenRatePct: null, categoryId: "15709" }),
    11,
  );
  assertEquals(
    resolvePublishAdRate({ optOut: null, chosenRatePct: null, categoryId: null }),
    8,
  );
});

// ── 00432: off-by-default, opt-in per seller ───────────────────────────────
Deno.test("resolvePublishAdRate: no override + seller default OFF → null", () => {
  assertEquals(
    resolvePublishAdRate({
      optOut: false,
      promoteOverride: null,
      defaultPromote: false,
      chosenRatePct: null,
      categoryId: "15709",
    }),
    null,
  );
});

Deno.test("resolvePublishAdRate: no override + seller default ON → suggestion", () => {
  assertEquals(
    resolvePublishAdRate({
      optOut: false,
      promoteOverride: null,
      defaultPromote: true,
      chosenRatePct: null,
      categoryId: "15709",
    }),
    11,
  );
});

Deno.test("resolvePublishAdRate: per-listing override true wins over seller default OFF", () => {
  assertEquals(
    resolvePublishAdRate({
      optOut: false,
      promoteOverride: true,
      defaultPromote: false,
      chosenRatePct: null,
      categoryId: null,
    }),
    8,
  );
});

Deno.test("resolvePublishAdRate: per-listing override false wins over seller default ON", () => {
  assertEquals(
    resolvePublishAdRate({
      optOut: false,
      promoteOverride: false,
      defaultPromote: true,
      chosenRatePct: 10,
      categoryId: "15709",
    }),
    null,
  );
});

Deno.test("resolvePublishAdRate: seller default rate used when promoting with no listing rate", () => {
  assertEquals(
    resolvePublishAdRate({
      optOut: false,
      promoteOverride: true,
      defaultPromote: false,
      chosenRatePct: null,
      defaultRatePct: 6,
      categoryId: "15709",
    }),
    6,
  );
  // Listing's own rate still beats the seller default.
  assertEquals(
    resolvePublishAdRate({
      optOut: false,
      promoteOverride: true,
      defaultPromote: false,
      chosenRatePct: 9,
      defaultRatePct: 6,
      categoryId: null,
    }),
    9,
  );
});

Deno.test("resolvePublishAdRate: legacy opt-out still wins even with override/default", () => {
  assertEquals(
    resolvePublishAdRate({
      optOut: true,
      promoteOverride: true,
      defaultPromote: true,
      chosenRatePct: 10,
      categoryId: "15709",
    }),
    null,
  );
});

// ── US-1447 chunk 2: Smart Targeting exports exist and are wire-shaped ──────
// The network functions (suggestMaxCpc / ensureSmartCampaign /
// createSmartAdForListing) are eBay-API-bound like the CPS/CPC creators above
// (validated live, not unit-mocked); this pins the exported surface + the
// non-throwing failure contract of suggestMaxCpc against a dead endpoint.

const marketing = await import("../lib/ebay-marketing.ts");

Deno.test("US-1447: smart-targeting surface is exported", () => {
  assertEquals(typeof marketing.suggestMaxCpc, "function");
  assertEquals(typeof marketing.ensureSmartCampaign, "function");
  assertEquals(typeof marketing.createSmartAdForListing, "function");
  assertEquals(typeof marketing.attachPromotionAtPublish, "function");
});

// ── US-1979 (AC1): eBay's trending ad rate vs our heuristic ────────────────
//
// suggestedAdRateForCategory was the PRIMARY suggestion, justified by a comment
// claiming "eBay exposes no synchronous suggested bid per leaf endpoint". That was
// wrong: eBay's suggestion is per-LISTING, not per-leaf-category, via the
// Recommendation API's findListingRecommendations (marketing.ad.bidPercentages,
// basis TRENDING = the average ad rate of listings that recently SOLD in the same
// category). The map is now the FALLBACK.
//
// The marketplace gate is eBay's, not ours, and it is why the fallback has to stay:
// the Recommendation API is CPS-only and covers only these four marketplaces.

Deno.test("US-1979: the Recommendation API gate matches eBay's supported marketplaces", () => {
  for (const m of ["EBAY_US", "EBAY_GB", "EBAY_DE", "EBAY_AU"]) {
    assertEquals(recommendationApiSupported(m), true, `${m} is supported by eBay`);
  }
  // Everywhere else must fall back rather than call an endpoint eBay does not
  // serve there — a 4xx per listing would be noise, and the seller would lose the
  // suggestion entirely.
  for (const m of ["EBAY_CA", "EBAY_FR", "EBAY_IT", "EBAY_ES", "EBAY_NL", "EBAY_IE"]) {
    assertEquals(recommendationApiSupported(m), false, `${m} is NOT supported`);
  }
});

Deno.test("US-1979: the category heuristic still stands as the fallback", () => {
  // It is no longer the primary, but it must keep working — it is what a seller on
  // EBAY_CA, or with a draft listing, or during a Recommendation API outage, gets.
  const sneakers = suggestedAdRateForCategory("15709");
  const unknown = suggestedAdRateForCategory("999999");
  assertEquals(sneakers > unknown, true, "high-demand categories still bid above baseline");
});
