// US-722: seeded per-platform category mapping. Pure module — no env.
import { assert, assertEquals } from "@std/assert";
import { resolveSeededCategory } from "../lib/marketplace-category.ts";

Deno.test("maps each garment type to a platform leaf", () => {
  assertEquals(resolveSeededCategory("poshmark", "dresses", null)?.path, "Dresses");
  assertEquals(resolveSeededCategory("mercari", "outerwear", null)?.path, "Coats & jackets");
  assertEquals(resolveSeededCategory("grailed", "bottoms", null)?.path, "Bottoms");
  assertEquals(resolveSeededCategory("depop", "footwear", null)?.path, "Shoes");
});

Deno.test("falls back to item_category when garment_category is absent", () => {
  assertEquals(resolveSeededCategory("poshmark", null, "shoes")?.path, "Shoes");
  assertEquals(resolveSeededCategory("grailed", null, "clothing")?.path, "Tops");
});

Deno.test("is case-insensitive on the garment key", () => {
  assertEquals(resolveSeededCategory("depop", "Dresses", null)?.path, "Dresses");
});

Deno.test("returns null when unmapped (caller falls back)", () => {
  assertEquals(resolveSeededCategory("poshmark", "spacesuit", "gadgets"), null);
  // eBay/Shopify are intentionally not seeded here.
  assertEquals(resolveSeededCategory("ebay", "tops", null), null);
  assertEquals(resolveSeededCategory("shopify", "tops", null), null);
});

Deno.test("source is 'seed'", () => {
  assert(resolveSeededCategory("mercari", "tops", null)?.source === "seed");
});
