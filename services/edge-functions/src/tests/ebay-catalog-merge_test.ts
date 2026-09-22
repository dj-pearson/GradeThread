// eBay → FlipDesk catalog merge: title overwrite-if-different, brand/size/etc.
// fill-if-blank. Pure module — no env needed.
import { assert, assertEquals } from "@std/assert";
import {
  buildCatalogPatch,
  flattenAspects,
  type LocalCatalog,
  pickAspect,
} from "../lib/ebay-catalog-merge.ts";

const EMPTY: LocalCatalog = {
  title: null,
  brand: null,
  size: null,
  color: null,
  style: null,
  material: null,
};

Deno.test("title: overwrites when eBay differs", () => {
  const patch = buildCatalogPatch(
    { ...EMPTY, title: "Old Title" },
    { title: "New eBay Title", specifics: {} },
  );
  assertEquals(patch.title, "New eBay Title");
});

Deno.test("title: no-op when identical (ignoring whitespace)", () => {
  const patch = buildCatalogPatch(
    { ...EMPTY, title: "Nike Tee" },
    { title: "  Nike Tee  ", specifics: {} },
  );
  assertEquals(patch.title, undefined);
});

Deno.test("title: never blanked when eBay title is empty/missing", () => {
  const patch = buildCatalogPatch(
    { ...EMPTY, title: "Keep Me" },
    { title: "", specifics: {} },
  );
  assertEquals(patch.title, undefined);
  assertEquals("title" in patch, false);
});

Deno.test("fill-if-blank: fills only empty cells, never overwrites set ones", () => {
  const local: LocalCatalog = {
    title: "T",
    brand: "Nike", // already set — must NOT be overwritten
    size: null, // blank — should fill
    color: "   ", // whitespace = blank — should fill
    style: null,
    material: null,
  };
  const patch = buildCatalogPatch(local, {
    title: "T",
    specifics: {
      Brand: "Adidas",
      Size: "M",
      Color: "Red",
      Style: "Crewneck",
      Material: "Cotton",
    },
  });
  assertEquals(patch.brand, undefined); // preserved
  assertEquals(patch.size, "M");
  assertEquals(patch.color, "Red");
  assertEquals(patch.style, "Crewneck");
  assertEquals(patch.material, "Cotton");
  assertEquals(patch.title, undefined);
});

Deno.test("no-op when everything is populated and title matches", () => {
  const local: LocalCatalog = {
    title: "T",
    brand: "Nike",
    size: "M",
    color: "Red",
    style: "Crew",
    material: "Cotton",
  };
  const patch = buildCatalogPatch(local, {
    title: "T",
    specifics: { Brand: "X", Size: "X", Color: "X", Style: "X", Material: "X" },
  });
  assertEquals(Object.keys(patch).length, 0);
});

Deno.test("pickAspect: case-insensitive + variant fallbacks", () => {
  assertEquals(pickAspect({ BRAND: "Levi's" }, "brand"), "Levi's");
  assertEquals(pickAspect({ Colour: "Blue" }, "color"), "Blue");
  assertEquals(pickAspect({ "Fabric Type": "Denim" }, "material"), "Denim");
  assertEquals(pickAspect({ "Women's Size": "8" }, "size"), "8");
});

Deno.test("pickAspect: 'Size Type' must not satisfy size", () => {
  // Only "Size Type" present — it's Regular/Plus/Petite, not the numeric size.
  assertEquals(pickAspect({ "Size Type": "Regular" }, "size"), null);
  // But when both exist, the real Size wins.
  assertEquals(
    pickAspect({ "Size Type": "Regular", Size: "10" }, "size"),
    "10",
  );
});

Deno.test("pickAspect: blank specific value returns null", () => {
  assertEquals(pickAspect({ Brand: "   " }, "brand"), null);
  assertEquals(pickAspect({}, "brand"), null);
});

Deno.test("flattenAspects: first non-empty value per name", () => {
  const flat = flattenAspects({
    Brand: ["Nike"],
    Color: ["", "Red"],
    Size: [],
    Material: ["  Cotton  "],
  });
  assertEquals(flat.Brand, "Nike");
  assertEquals(flat.Color, "Red");
  assertEquals("Size" in flat, false);
  assertEquals(flat.Material, "Cotton");
  assert(!("Size" in flat));
});

// ── US-3468: the full specifics map + leaf category ─────────────────────────
//
// Until this story the pull read every specific and kept five. These pin the
// other direction: what eBay holds lands on the item, what the item holds is
// never clobbered.
import {
  mergeEbayAspects,
  sanitizePulledAspects,
} from "../lib/ebay-catalog-merge.ts";

const CARD_ASPECTS: Record<string, string[]> = {
  Sport: ["Baseball"],
  Player: ["Ken Griffey Jr."],
  Season: ["1989"],
  Set: ["Upper Deck"],
  "Card Number": ["1"],
  Graded: ["Yes"],
  Features: ["Rookie", "Hall of Fame"],
};

Deno.test("US-3468: every specific eBay holds lands in ebay_aspects, not just the five columns", () => {
  const patch = buildCatalogPatch(
    { ...EMPTY, title: "1989 Upper Deck Ken Griffey Jr. #1" },
    {
      title: "1989 Upper Deck Ken Griffey Jr. #1",
      specifics: flattenAspects(CARD_ASPECTS),
      aspects: CARD_ASPECTS,
      categoryId: "261328",
    },
  );
  assertEquals(patch.ebay_aspects, CARD_ASPECTS);
  assertEquals(patch.ebay_category_id, "261328");
  // The five columns are untouched by a card's specifics: none of these
  // names match brand/size/color/style/material.
  assertEquals(patch.brand, undefined);
  assertEquals(patch.size, undefined);
});

Deno.test("US-3468: multi-value specifics keep every value in ebay_aspects", () => {
  const patch = buildCatalogPatch(EMPTY, {
    title: null,
    specifics: { Features: "Rookie" },
    aspects: { Features: ["Rookie", "Hall of Fame"] },
  });
  assertEquals(patch.ebay_aspects?.Features, ["Rookie", "Hall of Fame"]);
});

Deno.test("US-3468: a name the item already holds keeps its local value (fill-if-blank per name, case-insensitive)", () => {
  const patch = buildCatalogPatch(
    {
      ...EMPTY,
      ebay_aspects: { player: ["Griffey (seller's spelling)"], Sport: ["Baseball"] },
    },
    {
      title: null,
      specifics: {},
      aspects: { Player: ["Ken Griffey Jr."], Sport: ["Baseball"], Season: ["1989"] },
    },
  );
  assertEquals(patch.ebay_aspects, {
    player: ["Griffey (seller's spelling)"],
    Sport: ["Baseball"],
    Season: ["1989"],
  });
});

Deno.test("US-3468: no-op when eBay adds nothing the item lacks", () => {
  const patch = buildCatalogPatch(
    { ...EMPTY, ebay_aspects: { Sport: ["Baseball"] }, ebay_category_id: "261328" },
    {
      title: null,
      specifics: {},
      aspects: { Sport: ["Softball"] },
      categoryId: "999",
    },
  );
  assertEquals(Object.keys(patch).length, 0);
  assertEquals(mergeEbayAspects({ Sport: ["Baseball"] }, { sport: ["X"] }), null);
  assertEquals(mergeEbayAspects({}, {}), null);
  assertEquals(mergeEbayAspects(null, null), null);
});

Deno.test("US-3468: ebay_category_id fills only when blank", () => {
  const filled = buildCatalogPatch(
    { ...EMPTY, ebay_category_id: "  " },
    { title: null, specifics: {}, categoryId: "261328" },
  );
  assertEquals(filled.ebay_category_id, "261328");
  const kept = buildCatalogPatch(
    { ...EMPTY, ebay_category_id: "15687" },
    { title: null, specifics: {}, categoryId: "261328" },
  );
  assertEquals("ebay_category_id" in kept, false);
  const blankIncoming = buildCatalogPatch(EMPTY, {
    title: null,
    specifics: {},
    categoryId: "   ",
  });
  assertEquals("ebay_category_id" in blankIncoming, false);
});

Deno.test("US-3468: a flat-only caller still mirrors what it read", () => {
  // No `aspects` given: the flat specifics are widened to one-value arrays so
  // the mirror is not skipped for a caller that only had the flat form.
  const patch = buildCatalogPatch(EMPTY, {
    title: null,
    specifics: { Brand: "Topps", Sport: "Baseball" },
  });
  assertEquals(patch.brand, "Topps");
  assertEquals(patch.ebay_aspects, { Brand: ["Topps"], Sport: ["Baseball"] });
});

Deno.test("US-3468: sanitizePulledAspects trims, drops blanks and de-dupes", () => {
  assertEquals(
    sanitizePulledAspects({
      " Sport ": [" Baseball ", "", "Baseball"],
      Empty: [],
      Blank: ["   "],
      "": ["x"],
      Single: "Solo" as unknown as string[],
      NotAString: [42 as unknown as string],
    }),
    { Sport: ["Baseball"], Single: ["Solo"] },
  );
  assertEquals(sanitizePulledAspects(null), {});
});

Deno.test("US-3468: a filled column that disagrees with eBay keeps its aspect out of the mirror", () => {
  const patch = buildCatalogPatch(
    { ...EMPTY, brand: "Nike", size: "M" },
    {
      title: null,
      specifics: { Brand: "Adidas", Size: "M", Sport: "Running" },
      aspects: { Brand: ["Adidas"], Size: ["M"], Sport: ["Running"] },
    },
  );
  // Brand disagrees with the column, so it is left out; Size agrees, so it
  // mirrors; Sport has no column and mirrors.
  assertEquals(patch.ebay_aspects, { Size: ["M"], Sport: ["Running"] });
  assertEquals("brand" in patch, false);
});

Deno.test("US-3468: the adoption default 'clothing' is replaced by what eBay's breadcrumb implies", () => {
  const card = buildCatalogPatch(
    { ...EMPTY, item_category: "clothing" },
    { title: null, specifics: {}, itemCategory: "sports_cards" },
  );
  assertEquals(card.item_category, "sports_cards");
  const blank = buildCatalogPatch(
    { ...EMPTY, item_category: null },
    { title: null, specifics: {}, itemCategory: "shoes" },
  );
  assertEquals(blank.item_category, "shoes");
});

Deno.test("US-3468: a chosen vertical, an 'other' answer, or no answer never moves the row", () => {
  // Chosen (anything but the default) stays.
  const chosen = buildCatalogPatch(
    { ...EMPTY, item_category: "collectibles" },
    { title: null, specifics: {}, itemCategory: "sports_cards" },
  );
  assertEquals("item_category" in chosen, false);
  // "other" is not specific enough to overwrite a default.
  const other = buildCatalogPatch(
    { ...EMPTY, item_category: "clothing" },
    { title: null, specifics: {}, itemCategory: "other" },
  );
  assertEquals("item_category" in other, false);
  // Same as the default: nothing to write.
  const same = buildCatalogPatch(
    { ...EMPTY, item_category: "clothing" },
    { title: null, specifics: {}, itemCategory: "clothing" },
  );
  assertEquals("item_category" in same, false);
  // Unknown: keep what it had.
  const none = buildCatalogPatch(
    { ...EMPTY, item_category: "clothing" },
    { title: null, specifics: {}, itemCategory: null },
  );
  assertEquals("item_category" in none, false);
});
