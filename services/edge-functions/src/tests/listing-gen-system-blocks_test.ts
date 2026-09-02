// 2026-09-02: the category's allowed-aspects list rides the CACHED system
// prefix of the generation call, not the user turn behind the photos.
//
// Anthropic's cache is a prefix cache. The user turn opens with the item's
// photos, which differ on every call, so a block placed after them is never
// read from cache; the same block in a second system block is written once per
// category per batch and read at a tenth of the price after that. These tests
// pin the shape (two blocks, both or neither cached, prompt first) and that the
// user turn no longer carries a second copy.
//
//   deno test --allow-env --allow-read --allow-net src/tests/listing-gen-system-blocks_test.ts
import "./_env.ts"; // ai-listing reaches lib/supabase.ts
import { assert, assertEquals } from "@std/assert";
import {
  allowedAspectsBlock,
  buildListingSystemBlocks,
  buildListingUserLines,
  promptAllowedAspects,
  withTagAttributes,
} from "../lib/ai-listing.ts";

const ALLOWED = {
  Brand: [],
  Department: ["Men", "Women"],
  "Country of Origin": ["Vietnam"],
};
const PHOTOS = [{ url: "https://example.test/front.jpg", type: "front" }];

Deno.test("no aspects -> one system block, the prompt", () => {
  const blocks = buildListingSystemBlocks("PROMPT", undefined, true);
  assertEquals(blocks.length, 1);
  assertEquals(blocks[0]!.text, "PROMPT");
  assertEquals(buildListingSystemBlocks("PROMPT", {}, true).length, 1);
});

Deno.test("aspects -> a second block, prompt first, both cached", () => {
  const blocks = buildListingSystemBlocks("PROMPT", ALLOWED, true);
  assertEquals(blocks.length, 2);
  assertEquals(blocks[0]!.text, "PROMPT");
  // Prompt first: it is what a batch spanning several categories still shares.
  assert(blocks[1]!.text.startsWith("ALLOWED ITEM-SPECIFIC ASPECTS"));
  assert(blocks[1]!.text.includes('"Country of Origin"'));
  for (const b of blocks) {
    assertEquals(b.cache_control, { type: "ephemeral" });
  }
});

Deno.test("caching off -> neither block carries a breakpoint", () => {
  const blocks = buildListingSystemBlocks("PROMPT", ALLOWED, false);
  assertEquals(blocks.length, 2);
  for (const b of blocks) assertEquals(b.cache_control, undefined);
});

Deno.test("the block text is deterministic for a category (it is the cache key)", () => {
  assertEquals(
    allowedAspectsBlock(ALLOWED),
    allowedAspectsBlock({ ...ALLOWED }),
  );
  assertEquals(allowedAspectsBlock(null), "");
  assertEquals(allowedAspectsBlock({}), "");
});

Deno.test("the user turn no longer carries the aspect list", () => {
  const text = buildListingUserLines({
    photos: PHOTOS,
    allowedAspects: ALLOWED,
  }).join("\n\n");
  assert(
    !text.includes("ALLOWED ITEM-SPECIFIC ASPECTS"),
    "a second, uncached copy behind the photos is exactly what this change removed",
  );
  // And is byte-identical with and without the field, which is what makes the
  // move safe for every caller that still passes it.
  assertEquals(text, buildListingUserLines({ photos: PHOTOS }).join("\n\n"));
});

Deno.test("promptAllowedAspects maps the capped specs, [] for free text", () => {
  const map = promptAllowedAspects([
    { name: "Brand", required: true, cardinality: "SINGLE", mode: "FREE_TEXT" },
    {
      name: "Department",
      required: true,
      cardinality: "SINGLE",
      mode: "SELECTION_ONLY",
      allowedValues: ["Men", "Women"],
    },
  ]);
  assertEquals(map, { Brand: [], Department: ["Men", "Women"] });
});

// ── The label reads reach the registry ───────────────────────────────────────

Deno.test("withTagAttributes: nothing read -> the item's attributes as they were", () => {
  assertEquals(withTagAttributes(null, {}), null);
  assertEquals(withTagAttributes(undefined, {}), null);
  const attrs = { fit: "Slim" };
  assertEquals(withTagAttributes(attrs, {}), attrs);
});

Deno.test("withTagAttributes: label reads are added, existing keys kept", () => {
  assertEquals(
    withTagAttributes({ fit: "Slim" }, {
      country_of_manufacture: "Vietnam",
      mpn: "CJ1682-010",
    }),
    { fit: "Slim", country_of_manufacture: "Vietnam", mpn: "CJ1682-010" },
  );
  assertEquals(withTagAttributes(null, { garment_care: "Machine wash cold" }), {
    garment_care: "Machine wash cold",
  });
});
