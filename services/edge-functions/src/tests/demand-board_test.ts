// US-1830: demand-board want normalization + matching adapter (pure). No DB.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  normalizeTerms,
  normalizeWantInput,
  hasCriteria,
  wantToSearch,
  matchesSearch,
  aggregatePublicWants,
} = await import("../lib/demand-board.ts");

// ── normalizeTerms ──────────────────────────────────────────────────────────

Deno.test("terms: trims, drops blanks/non-strings, de-dupes case-insensitively", () => {
  assertEquals(normalizeTerms(["Nike", " nike ", "", 5, "Adidas"]), ["Nike", "Adidas"]);
  assertEquals(normalizeTerms("nope"), []);
});

Deno.test("terms: bounded to 20", () => {
  const many = Array.from({ length: 30 }, (_, i) => `b${i}`);
  assertEquals(normalizeTerms(many).length, 20);
});

// ── normalizeWantInput ──────────────────────────────────────────────────────

Deno.test("want: clamps grade to 0.5 steps in [1,10]; coerces cents; defaults private", () => {
  const w = normalizeWantInput({ brands: ["Nike"], min_grade: 8.3, max_price_cents: 6000.7, budget_cents: -4 });
  assertEquals(w.brands, ["Nike"]);
  assertEquals(w.min_grade, 8.5);
  assertEquals(w.max_price_cents, 6001);
  assertEquals(w.budget_cents, null); // negative → null
  assertEquals(w.visibility, "private");
});

Deno.test("want: visibility 'public' honored; garbage grade → null", () => {
  const w = normalizeWantInput({ categories: ["hoodie"], visibility: "public", min_grade: "high" });
  assertEquals(w.visibility, "public");
  assertEquals(w.min_grade, null);
});

// ── hasCriteria ─────────────────────────────────────────────────────────────

Deno.test("criteria: an all-wildcard want is rejected", () => {
  assertEquals(hasCriteria(normalizeWantInput({})), false);
  assertEquals(hasCriteria(normalizeWantInput({ min_grade: 7 })), true);
  assertEquals(hasCriteria(normalizeWantInput({ brands: ["Nike"] })), true);
});

// ── wantToSearch + matchesSearch (reused engine) ────────────────────────────

const cert = { certificateId: "GT-1", brand: "Nike", title: "Nike tech hoodie", category: "hoodie", grade: 8.5 };

Deno.test("match: reuses the alerts engine via wantToSearch", () => {
  const w = { id: "w1", user_id: "u1", ...normalizeWantInput({ brands: ["nike"], min_grade: 8 }) };
  assertEquals(matchesSearch(cert, wantToSearch(w)), true);
});

Deno.test("match: brand mismatch fails; grade below min fails", () => {
  const wrongBrand = { id: "w", user_id: "u", ...normalizeWantInput({ brands: ["Adidas"] }) };
  assertEquals(matchesSearch(cert, wantToSearch(wrongBrand)), false);
  const tooLow = { id: "w", user_id: "u", ...normalizeWantInput({ min_grade: 9 }) };
  assertEquals(matchesSearch(cert, wantToSearch(tooLow)), false);
});

Deno.test("match: keyword hits the title", () => {
  const w = { id: "w", user_id: "u", ...normalizeWantInput({ keywords: ["tech"] }) };
  assertEquals(matchesSearch(cert, wantToSearch(w)), true);
});

// ── aggregatePublicWants (PII-safe seller signal) ───────────────────────────

Deno.test("aggregate: counts per brand/category; strongest grade/budget signal", () => {
  const agg = aggregatePublicWants([
    { brands: ["Nike"], categories: ["hoodie"], min_grade: 8, max_price_cents: 6000 },
    { brands: ["Nike"], categories: ["tee"], min_grade: 9, max_price_cents: 4000 },
    { brands: ["Adidas"], categories: ["hoodie"], min_grade: null, max_price_cents: null },
  ]);
  assertEquals(agg.totalWants, 3);
  // Nike wanted twice → ranked first; topMinGrade is the strongest (9), top budget 6000.
  assertEquals(agg.brands[0], { term: "Nike", wantCount: 2, topMinGrade: 9, topMaxPriceCents: 6000 });
  assertEquals(agg.brands[1].term, "Adidas");
  // hoodie wanted twice → ranked first among categories.
  assertEquals(agg.categories[0].term, "hoodie");
  assertEquals(agg.categories[0].wantCount, 2);
});

Deno.test("aggregate: case-insensitive facet keys; empty input → empty", () => {
  const agg = aggregatePublicWants([
    { brands: ["Nike"], categories: [], min_grade: null, max_price_cents: null },
    { brands: ["nike"], categories: [], min_grade: null, max_price_cents: null },
  ]);
  assertEquals(agg.brands.length, 1);
  assertEquals(agg.brands[0].wantCount, 2);
  assertEquals(aggregatePublicWants([]).brands, []);
});
