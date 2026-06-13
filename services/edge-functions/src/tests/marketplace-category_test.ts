// US-722: seeded per-platform category mapping. Pure module — no env.
import { assert, assertEquals } from "@std/assert";
import {
  MAPPED_PLATFORMS,
  PLATFORM_CATEGORY_HINTS,
  resolveSeededCategory,
  toGarmentKey,
  UNMAPPED_CATEGORY,
} from "../lib/marketplace-category.ts";

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

Deno.test("MAPPED_PLATFORMS is exactly the no-API set (eBay/Shopify excluded)", () => {
  assert(MAPPED_PLATFORMS.has("poshmark"));
  assert(MAPPED_PLATFORMS.has("mercari"));
  assert(MAPPED_PLATFORMS.has("depop"));
  assert(MAPPED_PLATFORMS.has("grailed"));
  assert(!MAPPED_PLATFORMS.has("ebay"));
  assert(!MAPPED_PLATFORMS.has("shopify"));
});

Deno.test("every seeded leaf is in its platform's candidate hint list", () => {
  for (const platform of MAPPED_PLATFORMS) {
    const hints = PLATFORM_CATEGORY_HINTS[platform];
    assert(hints && hints.length > 0, `${platform} has hints`);
    for (const garment of ["tops", "bottoms", "outerwear", "dresses", "footwear", "accessories"]) {
      const seeded = resolveSeededCategory(platform, garment, null);
      assert(seeded, `${platform}/${garment} is seeded`);
      assert(
        hints!.includes(seeded!.path),
        `${platform} hint list must include seed leaf "${seeded!.path}"`,
      );
    }
  }
});

Deno.test("toGarmentKey normalizes garment + item categories", () => {
  assertEquals(toGarmentKey("Outerwear", null), "outerwear");
  assertEquals(toGarmentKey(null, "shoes"), "footwear");
  assertEquals(toGarmentKey("spacesuit", "gadgets"), null);
});

Deno.test("UNMAPPED_CATEGORY is the unmapped sentinel", () => {
  assertEquals(UNMAPPED_CATEGORY.status, "unmapped");
  assertEquals(UNMAPPED_CATEGORY.path, null);
  assertEquals(UNMAPPED_CATEGORY.source, "none");
});
