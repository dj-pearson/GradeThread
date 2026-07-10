// US-1835: condition-adjusted price-fairness meter (pure). No DB.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { priceFairness, parsePriceCents } = await import("../lib/price-fairness.ts");

const BAND = { lowCents: 4000, medianCents: 6000, highCents: 9000 };

// ── priceFairness ───────────────────────────────────────────────────────────

Deno.test("fairness: below the band → 'low' (a deal)", () => {
  const r = priceFairness(3500, BAND);
  assertEquals(r.verdict, "low");
  assertEquals(r.deltaPct, -42); // (3500-6000)/6000
});

Deno.test("fairness: inside the band → 'fair'", () => {
  assertEquals(priceFairness(4000, BAND).verdict, "fair"); // at low edge
  assertEquals(priceFairness(6000, BAND).verdict, "fair");
  assertEquals(priceFairness(9000, BAND).verdict, "fair"); // at high edge
});

Deno.test("fairness: above the band → 'high' (overpriced)", () => {
  const r = priceFairness(12000, BAND);
  assertEquals(r.verdict, "high");
  assertEquals(r.deltaPct, 100); // double the median
});

Deno.test("fairness: no band or no price → unknown, null delta", () => {
  assertEquals(priceFairness(5000, null).verdict, "unknown");
  assertEquals(priceFairness(null, BAND).verdict, "unknown");
  assertEquals(priceFairness(5000, { lowCents: 0, medianCents: 0, highCents: 0 }).verdict, "unknown");
  assertEquals(priceFairness(null, BAND).deltaPct, null);
});

// ── parsePriceCents ─────────────────────────────────────────────────────────

Deno.test("price: parses dollar strings, numbers, and junk", () => {
  assertEquals(parsePriceCents("$59.99"), 5999);
  assertEquals(parsePriceCents("US $1,299.00"), 129900);
  assertEquals(parsePriceCents("45"), 4500);
  assertEquals(parsePriceCents(60), 6000); // bare number = dollars
  assertEquals(parsePriceCents("free"), null);
  assertEquals(parsePriceCents(null), null);
  assertEquals(parsePriceCents(-5), null);
});
