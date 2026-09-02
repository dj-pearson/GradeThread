// 2026-09-02: the read-tags-only backfill writes code, name and RN fields and
// the two aspects, and nothing else.
//   deno test --allow-env --allow-read --allow-net src/tests/tag-read-backfill_test.ts
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  planBackfillPatch,
  planRedoUndecodedPatch,
  backfillEligible,
  INVENTORY_DERIVED,
} = await import("../lib/tag-read-backfill.ts");

const item = {
  id: "i1",
  user_id: "u1",
  brand: "Lululemon",
  style: "Pullover",
  size: "6",
  color: "Black",
  material: null,
  title: "Lululemon Pullover",
  item_category: "clothing",
  garment_type: null,
  garment_category: null,
  ebay_category_id: "53159",
  ebay_aspects: { Brand: ["Lululemon"], Size: ["6"] },
  ebay_aspect_sources: { Brand: "ai_extracted", Size: "ai_extracted" },
  attributes: { garment_care: "Machine wash cold" },
};
const specs = [
  { name: "Style Code", required: false, cardinality: "SINGLE", mode: "FREE_TEXT" },
  { name: "Model", required: false, cardinality: "SINGLE", mode: "FREE_TEXT" },
  { name: "Brand", required: true, cardinality: "SINGLE", mode: "FREE_TEXT" },
] as never;

Deno.test("writes the code, model and rn attributes and the two aspects; leaves everything else", () => {
  const patch = planBackfillPatch({
    item,
    tagAttributes: {
      mpn: "W3CWDS",
      model: "Scuba Oversized Half-Zip",
      rn: "RN 106259",
      rn_registrant: "lululemon athletica",
      // Not on the allow-list: the backfill must drop it.
      garment_care: "Hand wash",
    },
    aspectSpecs: specs,
  });
  assertEquals(patch.attributes, {
    garment_care: "Machine wash cold",
    mpn: "W3CWDS",
    model: "Scuba Oversized Half-Zip",
    rn: "RN 106259",
    rn_registrant: "lululemon athletica",
  });
  assertEquals(patch.addedAttributes, ["mpn", "model", "rn", "rn_registrant"]);
  assertEquals(patch.ebay_aspects, {
    Brand: ["Lululemon"],
    Size: ["6"],
    "Style Code": ["W3CWDS"],
    Model: ["Scuba Oversized Half-Zip"],
  });
  assertEquals(patch.ebay_aspect_sources?.["Style Code"], INVENTORY_DERIVED);
  assertEquals(patch.ebay_aspect_sources?.Model, INVENTORY_DERIVED);
  assertEquals(patch.ebay_aspect_sources?.Brand, "ai_extracted");
  assertEquals([...patch.addedAspects].sort(), ["Model", "Style Code"]);
});

Deno.test("no leaf: attributes only, aspects untouched", () => {
  const patch = planBackfillPatch({
    item: { ...item, ebay_category_id: null },
    tagAttributes: { mpn: "W3CWDS" },
    aspectSpecs: [],
  });
  assertEquals(patch.attributes?.mpn, "W3CWDS");
  assertEquals(patch.ebay_aspects, null);
  assertEquals(patch.ebay_aspect_sources, null);
  assertEquals(patch.addedAspects, []);
});

Deno.test("nothing read: nothing written", () => {
  const patch = planBackfillPatch({ item, tagAttributes: {}, aspectSpecs: specs });
  assertEquals(patch.attributes, null);
  assertEquals(patch.ebay_aspects, null);
  assertEquals(patch.addedAttributes, []);
});

Deno.test("an aspect the seller already set is never replaced", () => {
  const patch = planBackfillPatch({
    item: { ...item, ebay_aspects: { "Style Code": ["TYPED"] } },
    tagAttributes: { mpn: "W3CWDS" },
    aspectSpecs: specs,
  });
  assertEquals(patch.attributes?.mpn, "W3CWDS");
  assertEquals(patch.ebay_aspects, null);
  assertEquals(patch.addedAspects, []);
});

Deno.test("a stored attribute is never replaced", () => {
  const patch = planBackfillPatch({
    item: { ...item, attributes: { mpn: "KEPT" } },
    tagAttributes: { mpn: "W3CWDS", rn: "RN 1" },
    aspectSpecs: [],
  });
  assertEquals(patch.attributes?.mpn, "KEPT");
  assertEquals(patch.addedAttributes, ["rn"]);
});

// ── US-3086: --redo-undecoded re-files a raw rim from the STORED string ─────

/** An item the first backfill filed a raw rim on: mpn plus a derived aspect. */
const filedRaw = {
  ...item,
  attributes: { garment_care: "Machine wash cold", mpn: "LW3DUTS224000011302" },
  ebay_aspects: { Brand: ["Lululemon"], MPN: ["LW3DUTS224000011302"] },
  ebay_aspect_sources: { Brand: "ai_extracted", MPN: INVENTORY_DERIVED },
};

Deno.test("the canonical code replaces the raw one on the attribute and the derived aspect", () => {
  const patch = planRedoUndecodedPatch({ item: filedRaw, canonicalCode: "W3DUTS" });
  assertEquals(patch.storedCode, "LW3DUTS224000011302");
  assertEquals(patch.attributes?.mpn, "W3DUTS");
  assertEquals(patch.attributes?.garment_care, "Machine wash cold");
  assertEquals(patch.ebay_aspects, { Brand: ["Lululemon"], MPN: ["W3DUTS"] });
  assertEquals(patch.changedAttributes, ["mpn"]);
  assertEquals(patch.changedAspects, ["MPN"]);
});

Deno.test("an aspect the seller owns, or one carrying a different value, is left alone", () => {
  // Same value, but no longer stamped inventory_derived: somebody else wrote it.
  const typed = planRedoUndecodedPatch({
    item: {
      ...filedRaw,
      ebay_aspect_sources: { Brand: "ai_extracted", MPN: "seller_edited" },
    },
    canonicalCode: "W3DUTS",
  });
  assertEquals(typed.attributes?.mpn, "W3DUTS");
  assertEquals(typed.ebay_aspects, null);
  assertEquals(typed.changedAspects, []);

  // Derived, but no longer the raw string this is replacing.
  const moved = planRedoUndecodedPatch({
    item: { ...filedRaw, ebay_aspects: { MPN: ["SOMETHING ELSE"] } },
    canonicalCode: "W3DUTS",
  });
  assertEquals(moved.ebay_aspects, null);
  assertEquals(moved.changedAspects, []);

  // An aspect outside the two the backfill may write is never touched.
  const foreign = planRedoUndecodedPatch({
    item: {
      ...filedRaw,
      ebay_aspects: { Department: ["LW3DUTS224000011302"] },
      ebay_aspect_sources: { Department: INVENTORY_DERIVED },
    },
    canonicalCode: "W3DUTS",
  });
  assertEquals(foreign.ebay_aspects, null);
});

Deno.test("nothing to re-file: no code stored, or the code is already canonical", () => {
  assertEquals(planRedoUndecodedPatch({ item, canonicalCode: "W3DUTS" }).attributes, null);
  const same = planRedoUndecodedPatch({
    item: { ...filedRaw, attributes: { mpn: "W3DUTS" } },
    canonicalCode: "W3DUTS",
  });
  assertEquals(same.attributes, null);
  assertEquals(same.changedAttributes, []);
  // A code that still decodes to nothing yields no canonical code, so no write.
  assertEquals(planRedoUndecodedPatch({ item: filedRaw, canonicalCode: "" }).attributes, null);
});

Deno.test("eligible only when no code and no rn is stored yet", () => {
  assertEquals(backfillEligible(item), true);
  assertEquals(backfillEligible({ ...item, attributes: { mpn: "X" } }), false);
  assertEquals(backfillEligible({ ...item, attributes: { rn: "RN 1" } }), false);
  assertEquals(backfillEligible({ ...item, attributes: null }), true);
});
