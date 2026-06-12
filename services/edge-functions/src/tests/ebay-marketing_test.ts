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
