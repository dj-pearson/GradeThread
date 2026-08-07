// US-2424: AutoLister used to take eBay's first Taxonomy suggestion on faith.
// A wrong leaf costs every specific below it — its required aspects become
// publish blockers the seller clears by hand. These cover the deterministic
// scorer that replaced that: which candidate can the item already fill?
//
// Pure functions (no AI, no network), but ai-listing.ts transitively imports
// the service-role client at load, so set dummy env BEFORE the dynamic import.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  CATEGORY_CANDIDATE_LIMIT,
  projectedAspectsForCategory,
  rankCategoryCandidates,
  scoreCategoryCandidate,
} = await import("../lib/ai-listing.ts");
type EbayAspectSpec = import("../lib/ai-extract.ts").EbayAspectSpec;
type RegistryItem = import("../lib/aspect-registry.ts").RegistryItem;
type CategoryCandidateScore =
  import("../lib/ai-listing.ts").CategoryCandidateScore;

const req = (name: string): EbayAspectSpec => ({
  name,
  required: true,
  cardinality: "SINGLE",
  mode: "FREE_TEXT",
});
const opt = (name: string): EbayAspectSpec => ({ ...req(name), required: false });

// A men's striped cotton shirt: brand/size/color on the columns, department and
// pattern captured onto attributes by the extract pass.
const SHIRT: RegistryItem = {
  item_category: "clothing",
  brand: "Patagonia",
  size: "M",
  color: "Blue",
  title: "Men's Patagonia shirt",
  attributes: { department: "Men", pattern: "Striped" },
};

Deno.test("US-2424: the candidate covering strictly more required aspects wins", () => {
  // eBay ranked "Casual Shirts" first, but it requires a Sleeve Length the item
  // never captured. "Dress Shirts" requires only what the item already has.
  const thin = scoreCategoryCandidate(
    { categoryId: "111", categoryPath: "Casual Shirts", rank: 0 },
    SHIRT,
    {},
    [req("Brand"), req("Size"), req("Department"), req("Sleeve Length")],
  );
  const rich = scoreCategoryCandidate(
    { categoryId: "222", categoryPath: "Dress Shirts", rank: 1 },
    SHIRT,
    {},
    [req("Brand"), req("Size"), req("Department"), req("Color"), req("Pattern")],
  );
  assertEquals(thin.requiredFilled, 3);
  assertEquals(thin.requiredMissing, ["Sleeve Length"]);
  assertEquals(rich.requiredFilled, 5);
  assertEquals(rich.requiredMissing, []);

  const ranked = rankCategoryCandidates([thin, rich]);
  assertEquals(ranked[0].categoryId, "222");
  assertEquals(ranked[1].categoryId, "111");
});

Deno.test("US-2424: a single candidate behaves exactly as before — it is chosen", () => {
  const only = scoreCategoryCandidate(
    { categoryId: "111", categoryPath: "Casual Shirts", rank: 0 },
    SHIRT,
    {},
    [req("Brand"), req("Sleeve Length")],
  );
  const ranked = rankCategoryCandidates([only]);
  assertEquals(ranked.length, 1);
  assertEquals(ranked[0].categoryId, "111");
  // …even though it leaves a required gap. One candidate is not a choice.
  assertEquals(ranked[0].requiredMissing, ["Sleeve Length"]);
});

Deno.test("US-2424: eBay's own order breaks every tie", () => {
  const mk = (id: string, rank: number): CategoryCandidateScore => ({
    categoryId: id,
    categoryPath: null,
    rank,
    requiredFilled: 2,
    requiredTotal: 3,
    requiredMissing: ["Size Type"],
  });
  assertEquals(
    rankCategoryCandidates([mk("c", 2), mk("a", 0), mk("b", 1)]).map((s) => s.categoryId),
    ["a", "b", "c"],
  );
});

Deno.test("US-2424: equal fill counts break on the smaller remaining gap", () => {
  const wide: CategoryCandidateScore = {
    categoryId: "wide",
    categoryPath: null,
    rank: 0,
    requiredFilled: 3,
    requiredTotal: 8,
    requiredMissing: ["A", "B", "C", "D", "E"],
  };
  const tight: CategoryCandidateScore = {
    categoryId: "tight",
    categoryPath: null,
    rank: 1,
    requiredFilled: 3,
    requiredTotal: 4,
    requiredMissing: ["A"],
  };
  assertEquals(rankCategoryCandidates([wide, tight])[0].categoryId, "tight");
});

Deno.test("US-2424: ranking is a pure sort — the input array is untouched", () => {
  const input: CategoryCandidateScore[] = [
    { categoryId: "a", categoryPath: null, rank: 0, requiredFilled: 1, requiredTotal: 2, requiredMissing: ["X"] },
    { categoryId: "b", categoryPath: null, rank: 1, requiredFilled: 2, requiredTotal: 2, requiredMissing: [] },
  ];
  rankCategoryCandidates(input);
  assertEquals(input.map((s) => s.categoryId), ["a", "b"]);
});

Deno.test("US-2424: the model's own specifics count toward the score, case-insensitively", () => {
  const bare: RegistryItem = { item_category: "clothing" };
  const score = scoreCategoryCandidate(
    { categoryId: "1", categoryPath: null, rank: 0 },
    bare,
    { color: ["Blue"], "sleeve length": ["Long Sleeve"] },
    [req("Color"), req("Sleeve Length"), req("Brand")],
  );
  assertEquals(score.requiredFilled, 2);
  assertEquals(score.requiredMissing, ["Brand"]);
});

Deno.test("US-2424: projection rewrites generated names to eBay's own casing", () => {
  assertEquals(
    projectedAspectsForCategory(
      { item_category: "clothing" },
      { color: ["Blue"], "not an aspect here": ["x"], Empty: [] },
      [opt("Color")],
    ),
    { Color: ["Blue"] },
  );
});

Deno.test("US-2424: a leaf with no required aspects scores zero-of-zero, not a crash", () => {
  const score = scoreCategoryCandidate(
    { categoryId: "1", categoryPath: null, rank: 0 },
    SHIRT,
    {},
    [opt("Color"), opt("Brand")],
  );
  assertEquals(score.requiredTotal, 0);
  assertEquals(score.requiredFilled, 0);
  assertEquals(score.requiredMissing, []);
});

Deno.test("US-2424: the shortlist is bounded so scoring stays cheap", () => {
  // Each candidate costs one cached Taxonomy read and no AI, but the tail of
  // eBay's suggestion list stops being plausible leaves.
  assertEquals(CATEGORY_CANDIDATE_LIMIT >= 3 && CATEGORY_CANDIDATE_LIMIT <= 5, true);
});
