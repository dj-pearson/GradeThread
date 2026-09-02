// US-3043: the AutoLister batch path decides the category through the visual
// pass's leaf votes and pre-fills specifics from the visual consensus, the way
// the one-item path has since US-2765/US-2770. It computed both and discarded
// them until now.
//
// resolveBatchCategory takes its network as an argument so these cases run
// with fakes: a leaf-status oracle, a suggestion list, and a per-category spec.
// The keyword branch is the US-2424 required-aspect scoring, unchanged, and it
// is pinned here as the floor: when the vote does not settle, the draft lands
// exactly where it landed before.
//
//   deno test --allow-env --allow-read --allow-net src/tests/autolister-category-decision_test.ts
import "./_env.ts"; // ai-listing reaches lib/supabase.ts
import { assert, assertEquals } from "@std/assert";
import {
  applyVisualPrefill,
  type BatchCategoryDeps,
  buildAspectSources,
  resolveBatchCategory,
} from "../lib/ai-listing.ts";
import type { RegistryItem } from "../lib/aspect-registry.ts";
import type { EbayAspectSpec } from "../lib/ai-extract.ts";

const ITEM: RegistryItem = {
  item_category: "clothing",
  brand: "Nike",
  size: "M",
  color: "Black",
  material: null,
  style: null,
  title: "Nike Dri-FIT tee",
  description: null,
  condition_notes: null,
  attributes: null,
};

const BRAND_ONLY: EbayAspectSpec[] = [
  { name: "Brand", required: true, cardinality: "SINGLE", mode: "FREE_TEXT" },
];
const BRAND_AND_DEPT: EbayAspectSpec[] = [
  ...BRAND_ONLY,
  {
    name: "Department",
    required: true,
    cardinality: "SINGLE",
    mode: "SELECTION_ONLY",
  },
];

/** Fakes that also count what was called, so "no network" is assertable. */
function deps(
  overrides: Partial<BatchCategoryDeps> = {},
): BatchCategoryDeps & {
  calls: { leafStatus: string[]; suggest: string[]; specsFor: string[] };
} {
  const calls = {
    leafStatus: [] as string[],
    suggest: [] as string[],
    specsFor: [] as string[],
  };
  return {
    calls,
    leafStatus: (id) => {
      calls.leafStatus.push(id);
      return Promise.resolve("leaf" as const);
    },
    suggest: (q) => {
      calls.suggest.push(q);
      return Promise.resolve([
        {
          categoryId: "Y",
          categoryName: "Leaf Y",
          categoryTreePath: "Clothing > Y",
        },
        {
          categoryId: "Z",
          categoryName: "Leaf Z",
          categoryTreePath: "Clothing > Z",
        },
      ]);
    },
    specsFor: (id) => {
      calls.specsFor.push(id);
      // Y needs a Department the item cannot fill; Z needs only Brand. Under
      // US-2424 scoring Z wins on required-fill, so a test that expects Y has
      // to be asking for eBay's order, and one that expects Z for the score.
      return Promise.resolve(id === "Y" ? BRAND_AND_DEPT : BRAND_ONLY);
    },
    ...overrides,
  };
}

const ARGS = {
  savedCategoryId: null,
  query: "men's athletic t-shirt",
  registryItem: ITEM,
  itemSpecifics: { Brand: ["Nike"] },
  itemId: "item-1",
};

Deno.test("two of three similar listings in leaf X -> X, by visual consensus, no keyword call", async () => {
  const d = deps();
  const r = await resolveBatchCategory(
    {
      ...ARGS,
      leafVotes: [
        { categoryId: "X", categoryName: "Leaf X", count: 2 },
        { categoryId: "Y", categoryName: "Leaf Y", count: 1 },
      ],
    },
    d,
  );
  assertEquals(r.categoryId, "X");
  assertEquals(r.decision.method, "visual_consensus");
  assertEquals(r.decision.support, 2);
  assertEquals(r.decision.rejectedReason, null);
  // A vote knows the leaf, not its ancestry.
  assertEquals(r.categoryPath, null);
  assertEquals(r.candidates, []);
  assertEquals(d.calls.leafStatus, ["X"]);
  assertEquals(
    d.calls.suggest,
    [],
    "a visual win must not spend a suggestion call",
  );
  assertEquals(d.calls.specsFor, [], "nor an aspect read per candidate");
});

Deno.test("one match (below MIN_VOTE_SUPPORT) -> the keyword branch, scored as before", async () => {
  const d = deps();
  const r = await resolveBatchCategory(
    {
      ...ARGS,
      leafVotes: [{ categoryId: "X", categoryName: "Leaf X", count: 1 }],
    },
    d,
  );
  assertEquals(r.decision.method, "keyword");
  assertEquals(r.decision.rejectedReason, "below_min_support");
  // US-2424: Z fills 1/1 required, Y fills 1/2 -> Z outranks eBay's order.
  assertEquals(r.categoryId, "Z");
  assertEquals(r.categoryPath, "Clothing > Z");
  assertEquals(r.candidates.map((c) => c.categoryId), ["Z", "Y"]);
  assertEquals(r.decision.categoryName, "Leaf Z");
  assertEquals(
    d.calls.leafStatus,
    [],
    "an unsupported vote is not checked against eBay",
  );
  assertEquals(d.calls.suggest, ["men's athletic t-shirt"]);
});

Deno.test("no votes at all -> byte-identical to the pre-US-3043 keyword path", async () => {
  const withNone = await resolveBatchCategory(
    { ...ARGS, leafVotes: [] },
    deps(),
  );
  const withOne = await resolveBatchCategory(
    {
      ...ARGS,
      leafVotes: [{ categoryId: "X", categoryName: "Leaf X", count: 1 }],
    },
    deps(),
  );
  // The declined pass and the thin pass land in the same place, by the same
  // scoring; only the recorded reason differs.
  assertEquals(withNone.categoryId, withOne.categoryId);
  assertEquals(withNone.categoryPath, withOne.categoryPath);
  assertEquals(withNone.candidates, withOne.candidates);
  assertEquals(withNone.decision.method, "keyword");
  assertEquals(withNone.decision.rejectedReason, "no_votes");
});

Deno.test("a tie between leaves loses, and a vote on a non-leaf loses", async () => {
  const tied = await resolveBatchCategory(
    {
      ...ARGS,
      leafVotes: [
        { categoryId: "X", categoryName: "Leaf X", count: 2 },
        { categoryId: "W", categoryName: "Leaf W", count: 2 },
      ],
    },
    deps(),
  );
  assertEquals(tied.decision.method, "keyword");
  assertEquals(tied.decision.rejectedReason, "tied");

  const d = deps({ leafStatus: () => Promise.resolve("non_leaf" as const) });
  const nonLeaf = await resolveBatchCategory(
    {
      ...ARGS,
      leafVotes: [{ categoryId: "X", categoryName: "Leaf X", count: 3 }],
    },
    d,
  );
  assertEquals(nonLeaf.decision.method, "keyword");
  assertEquals(nonLeaf.decision.rejectedReason, "not_a_leaf");
  assertEquals(nonLeaf.categoryId, "Z");
});

Deno.test("a saved category wins outright and touches nothing", async () => {
  const d = deps();
  const r = await resolveBatchCategory(
    {
      ...ARGS,
      savedCategoryId: "SAVED",
      leafVotes: [{ categoryId: "X", categoryName: "Leaf X", count: 5 }],
    },
    d,
  );
  assertEquals(r.categoryId, "SAVED");
  assertEquals(r.decision.method, "saved");
  assertEquals(r.candidates, []);
  assertEquals(d.calls.leafStatus, []);
  assertEquals(d.calls.suggest, []);
});

Deno.test("no query and no votes -> none, not a throw", async () => {
  const r = await resolveBatchCategory(
    { ...ARGS, query: "  ", leafVotes: [] },
    deps(),
  );
  assertEquals(r.categoryId, null);
  assertEquals(r.decision.method, "none");
});

Deno.test("a candidate whose spec read fails scores zero rather than dropping out", async () => {
  const d = deps({
    specsFor: (id) =>
      id === "Z"
        ? Promise.reject(new Error("taxonomy down"))
        : Promise.resolve(BRAND_ONLY),
  });
  const r = await resolveBatchCategory({ ...ARGS, leafVotes: [] }, d);
  // Y now fills 1/1 and Z 0/0, so Y wins; Z is still in the list.
  assertEquals(r.categoryId, "Y");
  assertEquals(r.candidates.map((c) => c.categoryId), ["Y", "Z"]);
});

// ── The visual prefill lands on empty aspects only, as its own provenance ────

Deno.test("applyVisualPrefill fills empty aspects, keeps filled ones, reports names", () => {
  const applied = applyVisualPrefill(
    { Brand: ["Nike"], Theme: [] },
    {
      Theme: {
        values: ["Sports"],
        confidence: 0.55,
        source: "visual_consensus",
      },
      Brand: {
        values: ["Adidas"],
        confidence: 0.55,
        source: "visual_consensus",
      },
      "Product Line": {
        values: [" "],
        confidence: 0.5,
        source: "visual_consensus",
      },
    },
  );
  assertEquals(applied.aspects, { Brand: ["Nike"], Theme: ["Sports"] });
  assertEquals(applied.confidence, { Theme: 0.55 });
  assertEquals(applied.names, ["Theme"]);
});

Deno.test("visual_consensus is the lowest rung: AI, registry and the seller all outrank it", () => {
  const sources = buildAspectSources(
    { Brand: ["Nike"], Fit: ["Regular"], Theme: ["Sports"] },
    new Set(["Fit"]),
    new Set(["Theme"]),
  );
  assertEquals(sources, {
    Brand: "ai_extracted",
    Fit: "inventory_derived",
    Theme: "visual_consensus",
  });
  // And a name in both sets is the registry's, never the vote's.
  const both = buildAspectSources(
    { Fit: ["Regular"] },
    new Set(["Fit"]),
    new Set(["Fit"]),
  );
  assertEquals(both.Fit, "inventory_derived");
  assert(Object.keys(buildAspectSources({}, new Set())).length === 0);
});
