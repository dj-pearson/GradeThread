// US-2423: the attributes the capture pass already read must show up as item
// specifics on the AutoLister DRAFT, not only at publish time.
//
// generateListing itself needs Supabase + two Anthropic calls, so these cover
// the two exported pieces it composes — deriveInventoryAspects (what lands on
// the draft) and buildAspectSources (how it is attributed) — wired together the
// same way step 6c-bis wires them. ai-listing.ts transitively imports the
// service-role client at load, so set dummy env BEFORE the dynamic import.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { buildAspectSources, deriveInventoryAspects, registryAspectsFromSpecs } =
  await import("../lib/ai-listing.ts");
type EbayAspectSpec = import("../lib/ai-extract.ts").EbayAspectSpec;
type RegistryItem = import("../lib/aspect-registry.ts").RegistryItem;

const spec = (
  name: string,
  over: Partial<EbayAspectSpec> = {},
): EbayAspectSpec => ({
  name,
  required: false,
  cardinality: "SINGLE",
  mode: "FREE_TEXT",
  ...over,
});

const ITEM: RegistryItem = {
  item_category: "clothing",
  attributes: { pattern: "Striped" },
};

// Exactly what generateListing does at step 6c-bis: derive, merge fill-only,
// then attribute. Kept in one helper so the two tests below cannot drift from
// the call site they stand in for.
function generateDraftAspects(
  item: RegistryItem,
  specs: EbayAspectSpec[],
  fromModel: Record<string, string[]>,
) {
  const derived = deriveInventoryAspects(item, specs, fromModel);
  const aspects = { ...fromModel, ...derived };
  return {
    aspects,
    sources: buildAspectSources(aspects, new Set(Object.keys(derived))),
  };
}

Deno.test("US-2423: an item's stored pattern fills the draft's Pattern aspect as inventory_derived", () => {
  const { aspects, sources } = generateDraftAspects(
    ITEM,
    [spec("Pattern"), spec("Brand")],
    { Brand: ["Patagonia"] },
  );
  assertEquals(aspects.Pattern, ["Striped"]);
  assertEquals(sources.Pattern, "inventory_derived");
  // The model's own output keeps its own provenance.
  assertEquals(sources.Brand, "ai_extracted");
});

Deno.test("US-2423: a model-set Pattern is never overwritten by the projection", () => {
  const { aspects, sources } = generateDraftAspects(ITEM, [spec("Pattern")], {
    Pattern: ["Plaid"],
  });
  assertEquals(aspects.Pattern, ["Plaid"]);
  assertEquals(sources.Pattern, "ai_extracted");
});

Deno.test("US-2423: SELECTION_ONLY aspects still validate — an off-list value never lands", () => {
  const selection = (name: string, allowed: string[]) =>
    spec(name, { mode: "SELECTION_ONLY", allowedValues: allowed });
  assertEquals(
    deriveInventoryAspects(ITEM, [selection("Pattern", ["Striped", "Solid"])], {}),
    { Pattern: ["Striped"] },
  );
  assertEquals(
    deriveInventoryAspects(ITEM, [selection("Pattern", ["Solid", "Floral"])], {}),
    {},
  );
});

Deno.test("US-2423: the US-2421 widening reaches the draft, per vertical", () => {
  const boot: RegistryItem = {
    item_category: "shoes",
    attributes: { heel_type: "Block", toe_shape: "Almond Toe", occasion: "Casual" },
  };
  assertEquals(
    deriveInventoryAspects(
      boot,
      [spec("Heel Style"), spec("Toe Type"), spec("Occasion")],
      {},
    ),
    { "Heel Style": ["Block"], "Toe Type": ["Almond Toe"], Occasion: ["Casual"] },
  );
});

Deno.test("US-2423: no category spec means no projection (and no crash)", () => {
  assertEquals(deriveInventoryAspects(ITEM, [], {}), {});
  assertEquals(
    deriveInventoryAspects({ item_category: null, attributes: null }, [spec("Pattern")], {}),
    {},
  );
});

Deno.test("US-2423: MULTI cardinality carries through from the eBay spec", () => {
  const item: RegistryItem = {
    item_category: "clothing",
    attributes: { features: ["Pockets", "Hooded"] },
  };
  assertEquals(registryAspectsFromSpecs([spec("Features", { cardinality: "MULTI" })]), [
    { name: "Features", mode: "FREE_TEXT", multi: true, allowedValues: undefined },
  ]);
  assertEquals(
    deriveInventoryAspects(item, [spec("Features", { cardinality: "MULTI" })], {}),
    { Features: ["Pockets", "Hooded"] },
  );
  // SINGLE takes one value only.
  assertEquals(deriveInventoryAspects(item, [spec("Features")], {}), {
    Features: ["Pockets"],
  });
});

Deno.test("US-2423: the source map drops names the reconcile pass removed", () => {
  // buildAspectSources is handed the POST-reconcile aspect map, so a derived
  // aspect that reconciliation stripped must not linger in provenance.
  const sources = buildAspectSources({ Brand: ["Nike"] }, new Set(["Pattern"]));
  assertEquals(sources, { Brand: "ai_extracted" });
});
