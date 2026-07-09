// US-1747: pure helpers of the Value Index URL model. The DB-backed resolvers
// (resolveValueCurve/getValueHub) need a live stack; the slug math + condition
// mapping that decide the URL space are pure and unit-tested here.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-key");

const {
  slugify,
  itemSlugFromCurve,
  conditionTierBySlug,
  nearestPointForGrade,
  valuePath,
  CONDITION_TIERS,
} = await import("../lib/value-index.ts");

Deno.test("slugify: lowercases, hyphenates, trims", () => {
  assertEquals(slugify("Patagonia"), "patagonia");
  assertEquals(slugify("The North Face"), "the-north-face");
  assertEquals(slugify("Levi's 501"), "levi-s-501");
  assertEquals(slugify("  Ralph  Lauren  "), "ralph-lauren");
});

Deno.test("itemSlugFromCurve: strips the brand prefix, falls back to whole slug", () => {
  assertEquals(itemSlugFromCurve("patagonia-better-sweater", "Patagonia"), "better-sweater");
  assertEquals(itemSlugFromCurve("the-north-face-fleece", "The North Face"), "fleece");
  // No brand prefix → the whole slug is the item.
  assertEquals(itemSlugFromCurve("vintage-tee", "Nike"), "vintage-tee");
});

Deno.test("conditionTierBySlug: known tiers resolve, unknown → null", () => {
  assertEquals(conditionTierBySlug("excellent")?.grade, 8);
  assertEquals(conditionTierBySlug("very-good")?.label, "Very Good");
  assertEquals(conditionTierBySlug("nonsense"), null);
  // Every tier slug is unique.
  const slugs = CONDITION_TIERS.map((t) => t.slug);
  assertEquals(new Set(slugs).size, slugs.length);
});

Deno.test("nearestPointForGrade: picks the closest published point", () => {
  const points = [
    { grade: 9, lowCents: 8000, medianCents: 9000, highCents: 10000, sampleSize: 5 },
    { grade: 7, lowCents: 5000, medianCents: 6000, highCents: 7000, sampleSize: 5 },
    { grade: 5, lowCents: 3000, medianCents: 3500, highCents: 4000, sampleSize: 5 },
  ];
  assertEquals(nearestPointForGrade(points, 8)?.grade, 9); // 8 is equidistant → first (9) wins on <
  assertEquals(nearestPointForGrade(points, 6.5)?.grade, 7);
  assertEquals(nearestPointForGrade(points, 4)?.grade, 5);
  assertEquals(nearestPointForGrade([], 8), null);
});

Deno.test("valuePath: builds base + condition URLs", () => {
  assertEquals(valuePath("patagonia", "better-sweater"), "/value/patagonia/better-sweater");
  assertEquals(
    valuePath("patagonia", "better-sweater", "excellent"),
    "/value/patagonia/better-sweater/excellent",
  );
});

Deno.test("condition tiers span new→fair, anchored on the public grade bands", () => {
  const byGrade = CONDITION_TIERS.map((t) => t.grade);
  assert(Math.max(...byGrade) >= 9); // "new"
  assert(Math.min(...byGrade) <= 4); // "fair"
});
