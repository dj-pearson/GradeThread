// US-1807: buyer condition-alerts matching engine — the pure matching, curve
// resolution, due-search budgeting, and alert-body rendering.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  matchesSearch,
  pickCurveSlugForCert,
  selectDueSearches,
  buildAlertBody,
  DEFAULT_ALERTS_CONFIG,
} = await import("../lib/condition-alerts.ts");

type Search = Parameters<typeof matchesSearch>[1];
type Cert = Parameters<typeof matchesSearch>[0];

function search(o: Partial<Search> = {}): Search {
  return {
    id: "s1",
    user_id: "u1",
    label: "test",
    brands: [],
    categories: [],
    keywords: [],
    min_grade: null,
    max_price_cents: null,
    last_matched_at: null,
    ...o,
  };
}
function cert(o: Partial<Cert> = {}): Cert {
  return { certificateId: "GT-1", brand: "Nike", title: "Air Hoodie", category: "tops", grade: 8.5, ...o };
}

Deno.test("empty criteria = wildcard: any public cert matches", () => {
  assert(matchesSearch(cert(), search()));
});

Deno.test("brand filter is case-insensitive and exclusive", () => {
  assert(matchesSearch(cert({ brand: "Nike" }), search({ brands: ["nike"] })));
  assert(!matchesSearch(cert({ brand: "Adidas" }), search({ brands: ["nike"] })));
  assert(!matchesSearch(cert({ brand: null }), search({ brands: ["nike"] })));
});

Deno.test("category filter matches the garment_category slug", () => {
  assert(matchesSearch(cert({ category: "tops" }), search({ categories: ["tops"] })));
  assert(!matchesSearch(cert({ category: "footwear" }), search({ categories: ["tops"] })));
});

Deno.test("min_grade is an inclusive floor", () => {
  assert(matchesSearch(cert({ grade: 8.0 }), search({ min_grade: 8.0 })));
  assert(!matchesSearch(cert({ grade: 7.9 }), search({ min_grade: 8.0 })));
});

Deno.test("keywords match against title + brand, case-insensitively", () => {
  assert(matchesSearch(cert({ title: "Vintage Hoodie" }), search({ keywords: ["vintage"] })));
  assert(matchesSearch(cert({ brand: "Supreme", title: "Box Tee" }), search({ keywords: ["supreme"] })));
  assert(!matchesSearch(cert({ title: "Plain Tee" }), search({ keywords: ["vintage"] })));
});

Deno.test("all criteria compose (AND)", () => {
  const s = search({ brands: ["nike"], categories: ["tops"], min_grade: 8, keywords: ["air"] });
  assert(matchesSearch(cert(), s));
  assert(!matchesSearch(cert({ grade: 6 }), s)); // fails grade
  assert(!matchesSearch(cert({ title: "Court Hoodie" }), s)); // fails keyword
});

// ── pickCurveSlugForCert ─────────────────────────────────────────────────────
type Hub = Parameters<typeof pickCurveSlugForCert>[1];
const hubItem = (brandSlug: string, itemSlug: string, slug: string) =>
  ({ brandSlug, itemSlug, slug, brand: brandSlug, label: "", overall: null, refreshedAt: "" }) as unknown as Hub[number];

Deno.test("curve pick: exact item-slug match on the brand wins", () => {
  const hub = [hubItem("nike", "tops", "nike-tops"), hubItem("nike", "footwear", "nike-footwear")];
  assertEquals(pickCurveSlugForCert(cert({ brand: "Nike", category: "tops" }), hub), "nike-tops");
});

Deno.test("curve pick: single brand curve is used even without an item match", () => {
  const hub = [hubItem("nike", "outerwear", "nike-outerwear")];
  assertEquals(pickCurveSlugForCert(cert({ brand: "Nike", category: "tops", title: "Plain" }), hub), "nike-outerwear");
});

Deno.test("curve pick: ambiguous brand (2 non-matching curves) → null (don't guess)", () => {
  const hub = [hubItem("nike", "footwear", "nike-footwear"), hubItem("nike", "bags", "nike-bags")];
  assertEquals(pickCurveSlugForCert(cert({ brand: "Nike", category: "tops", title: "Plain" }), hub), null);
});

Deno.test("curve pick: no curve for the brand → null", () => {
  const hub = [hubItem("adidas", "tops", "adidas-tops")];
  assertEquals(pickCurveSlugForCert(cert({ brand: "Nike" }), hub), null);
  assertEquals(pickCurveSlugForCert(cert({ brand: null }), hub), null);
});

// ── selectDueSearches ────────────────────────────────────────────────────────
Deno.test("due selection: never-checked first, then oldest, budget-capped", () => {
  const searches = [
    search({ id: "recent", last_matched_at: "2026-07-09T00:00:00Z" }),
    search({ id: "never", last_matched_at: null }),
    search({ id: "old", last_matched_at: "2026-01-01T00:00:00Z" }),
  ];
  const sel = selectDueSearches(searches, { ...DEFAULT_ALERTS_CONFIG, maxSearchesPerRun: 2 }, Date.now());
  assertEquals(sel.batch.map((s) => s.id), ["never", "old"]);
  assertEquals(sel.dueCount, 3);
  assert(sel.budgetCapped);
});

Deno.test("due selection: within budget → nothing capped", () => {
  const sel = selectDueSearches([search()], DEFAULT_ALERTS_CONFIG, Date.now());
  assertEquals(sel.budgetCapped, false);
});

// ── buildAlertBody ───────────────────────────────────────────────────────────
Deno.test("alert body includes fair value when known, omits it when not", () => {
  const withPrice = buildAlertBody(cert({ brand: "Nike", title: "Hoodie", grade: 9 }), 4200);
  assert(withPrice.includes("$42"));
  assert(withPrice.includes("9.0/10"));
  const without = buildAlertBody(cert({ brand: "Nike", title: "Hoodie", grade: 9 }), null);
  assert(!without.includes("$"));
  assert(without.includes("matches your watch"));
});
