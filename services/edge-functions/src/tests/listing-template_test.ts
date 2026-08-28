// US-674 — listing template validation/normalization + the AutoLister overlay
// patch. listing-template.ts is pure (no DB/network), so it's imported directly.
import { assert, assertEquals } from "@std/assert";
import {
  buildTemplateListingPatch,
  type ListingTemplateRow,
  normalizeTemplateInput,
  TEMPLATE_NAME_MAX,
  templateTextBlock,
  withTemplateBlock,
} from "../lib/listing-template.ts";
import {
  defaultBlocks,
  type DescriptionBlock,
  type RenderContext,
  renderDescription,
} from "../lib/description-blocks.ts";

// ── normalizeTemplateInput ──────────────────────────────────────────

Deno.test("normalize rejects a missing/blank name", () => {
  for (const body of [{}, { name: "" }, { name: "   " }, { name: 7 }]) {
    const r = normalizeTemplateInput(body);
    assert(!r.ok, `expected failure for ${JSON.stringify(body)}`);
  }
});

Deno.test("normalize rejects an over-long name", () => {
  const r = normalizeTemplateInput({ name: "x".repeat(TEMPLATE_NAME_MAX + 1) });
  assert(!r.ok);
});

Deno.test("normalize trims name + blanks-to-null optional fields", () => {
  const r = normalizeTemplateInput({
    name: "  My preset  ",
    description_template: "   ",
    ebay_condition: "USED_EXCELLENT",
    return_policy_id: "  ",
  });
  assert(r.ok);
  assertEquals(r.value.name, "My preset");
  assertEquals(r.value.description_template, null); // whitespace -> null
  assertEquals(r.value.ebay_condition, "USED_EXCELLENT");
  assertEquals(r.value.return_policy_id, null);
  assertEquals(r.value.is_default, false);
  assertEquals(r.value.sort_order, 0);
  assertEquals(r.value.item_specifics, {});
});

Deno.test("normalize coerces item_specifics to a string map, dropping empties", () => {
  const r = normalizeTemplateInput({
    name: "T",
    item_specifics: { Brand: "  Nike  ", Size: 10, Vintage: true, Junk: "  ", "": "x" },
  });
  assert(r.ok);
  assertEquals(r.value.item_specifics, { Brand: "Nike", Size: "10", Vintage: "true" });
});

Deno.test("normalize truncates a float sort_order + honors is_default", () => {
  const r = normalizeTemplateInput({ name: "T", sort_order: 3.9, is_default: true });
  assert(r.ok);
  assertEquals(r.value.sort_order, 3);
  assertEquals(r.value.is_default, true);
});

// ── buildTemplateListingPatch ───────────────────────────────────────

function row(overrides: Partial<ListingTemplateRow> = {}): ListingTemplateRow {
  return {
    description_template: null,
    ebay_condition: null,
    condition_description: null,
    item_specifics: null,
    ebay_category_id: null,
    return_policy_id: null,
    shipping_policy_id: null,
    payment_policy_id: null,
    ...overrides,
  };
}

// US-2967: the boilerplate is a BLOCK now, so the patch never carries a
// description. It used to be appended onto `listing_description`, which the
// block renderer then overwrote on the seller's very next save.
Deno.test("overlay never writes a description, however much boilerplate", () => {
  const patch = buildTemplateListingPatch(
    row({ description_template: "Ships in 1 business day." }),
  );
  assertEquals(patch.listing_description, undefined);
  assertEquals(Object.keys(patch).length, 0);
});

Deno.test("overlay sets condition/category/specifics/policies only when present", () => {
  const patch = buildTemplateListingPatch(
    row({
      ebay_condition: "USED_GOOD",
      condition_description: "minor wear",
      item_specifics: { Brand: "Levi's" },
      ebay_category_id: "57988",
      return_policy_id: "rp1",
      shipping_policy_id: "sp1",
      payment_policy_id: "pp1",
    }),
  );
  assertEquals(patch.ebay_condition, "USED_GOOD");
  assertEquals(patch.ebay_condition_description, "minor wear");
  // US-1505: overlay now persists string[] values (the shape every edge
  // publish/revise consumer expects), not the template's raw {String:String}.
  assertEquals(patch.item_specifics_override, { Brand: ["Levi's"] });
  // The listing's category column is platform_category_id (publish reads that).
  assertEquals(patch.platform_category_id, "57988");
  assertEquals(patch.ebay_category_id, undefined);
  assertEquals(patch.return_policy_id, "rp1");
  assertEquals(patch.shipping_policy_id, "sp1");
  assertEquals(patch.payment_policy_id, "pp1");
  // Description untouched (no boilerplate on this template).
  assertEquals(patch.listing_description, undefined);
});

Deno.test("overlay of an empty template is a no-op patch", () => {
  const patch = buildTemplateListingPatch(row());
  assertEquals(Object.keys(patch).length, 0);
});

Deno.test("overlay ignores an empty item_specifics map", () => {
  const patch = buildTemplateListingPatch(row({ item_specifics: {} }));
  assertEquals(patch.item_specifics_override, undefined);
});

// ── US-2967: boilerplate as a description block ─────────────────────

Deno.test("a template with no boilerplate produces no block", () => {
  assertEquals(templateTextBlock(row()), null);
  assertEquals(templateTextBlock(row({ description_template: "   " })), null);
});

Deno.test("boilerplate becomes an editable seller-owned text block", () => {
  const block = templateTextBlock(row({ description_template: "  Terms apply.  " }));
  assertEquals(block, { key: "text", on: true, src: "seller", text: "Terms apply." });
});

Deno.test("the block goes in front of credentials and facts, not after them", () => {
  const out = withTemplateBlock(
    defaultBlocks(),
    row({ description_template: "Terms apply." }),
  );
  const keys = out.map((b) => b.key);
  assert(keys.indexOf("text") < keys.indexOf("credentials"));
  assert(keys.indexOf("text") < keys.indexOf("facts"));
  // Everything else keeps the order it had.
  assertEquals(
    keys.filter((k) => k !== "text"),
    defaultBlocks().map((b) => b.key),
  );
});

Deno.test("withTemplateBlock appends when the list has no trailing rows", () => {
  const bare: DescriptionBlock[] = [{ key: "intro", on: true, src: "ai", text: "Hi." }];
  const out = withTemplateBlock(bare, row({ description_template: "Terms." }));
  assertEquals(out.map((b) => b.key), ["intro", "text"]);
});

// The regression this story exists for. The old overlay put the boilerplate in
// the rendered string only, so the composer's first save -- which re-renders
// from the stored blocks -- dropped it.
Deno.test("boilerplate survives a re-render from the stored blocks", () => {
  const ctx: RenderContext = {
    item: {
      brand: "Filson",
      size: "L",
      color: "Forest",
      material: "Virgin wool",
    },
    grade: null,
    credential: null,
    snippets: {},
    unit: "in",
  };
  const blocks = withTemplateBlock(
    defaultBlocks().map((b) =>
      b.key === "intro" ? { ...b, text: "Heavy wool cruiser jacket." } : b
    ),
    row({ description_template: "Ships in 1 business day." }),
  );

  const firstPass = renderDescription(blocks, ctx);
  assert(firstPass.includes("Ships in 1 business day."));

  // Exactly what the composer does on save: render the SAME stored blocks
  // again. Nothing re-reads the template.
  const secondPass = renderDescription(blocks, ctx);
  assert(secondPass.includes("Ships in 1 business day."));
  assertEquals(firstPass, secondPass);
});
