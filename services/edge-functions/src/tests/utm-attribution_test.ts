// US-2101: UTM persist route input sanitisation. sanitizeUtmSet is pure, so the
// validation is tested directly without a DB.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { sanitizeUtmSet } from "../routes/utm-attribution.ts";

Deno.test("US-2101: keeps known UTM keys and landingAt, drops the rest", () => {
  const out = sanitizeUtmSet({
    utm_source: "google",
    utm_medium: "cpc",
    utm_campaign: "spring",
    utm_term: "ignored?no—kept",
    utm_content: "hero",
    landingAt: "2026-07-22T00:00:00.000Z",
    evil: "drop me",
    id: "should not pass through",
  });
  assertEquals(out, {
    utm_source: "google",
    utm_medium: "cpc",
    utm_campaign: "spring",
    utm_term: "ignored?no—kept",
    utm_content: "hero",
    landingAt: "2026-07-22T00:00:00.000Z",
  });
});

Deno.test("US-2101: a set with no real UTM dimension is rejected", () => {
  // landingAt alone is not a channel.
  assertEquals(sanitizeUtmSet({ landingAt: "2026-07-22T00:00:00.000Z" }), null);
  assertEquals(sanitizeUtmSet({}), null);
  assertEquals(sanitizeUtmSet(null), null);
  assertEquals(sanitizeUtmSet("nope"), null);
});

Deno.test("US-2101: non-string values are dropped, not coerced", () => {
  const out = sanitizeUtmSet({ utm_source: "email", utm_medium: 42, utm_campaign: null });
  assert(out !== null);
  assertEquals(out.utm_source, "email");
  assert(!("utm_medium" in out));
  assert(!("utm_campaign" in out));
});
