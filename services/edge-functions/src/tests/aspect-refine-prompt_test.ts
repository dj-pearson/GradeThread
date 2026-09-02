// 2026-09-02: what the aspect-refine pass is told, and what it is not.
//
// Two things changed on the refine call so Theme, Fabric Type, Garment Care,
// Country of Origin, MPN and Product Line stop coming back blank: the tag-OCR
// read reaches the prompt as its own block, and RECOMMENDED aspects are named
// as such in the tool schema. Both are additive, and the tests pin that a call
// without them produces the byte-identical prompt it did before.
//
//   deno test --allow-env --allow-read --allow-net src/tests/aspect-refine-prompt_test.ts
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  buildAspectUserPrompt,
  type EbayAspectSpec,
  tagGroundTruthAspectContext,
} from "../lib/ai-extract.ts";

const SPECS: EbayAspectSpec[] = [
  { name: "Brand", required: true, cardinality: "SINGLE", mode: "FREE_TEXT" },
  {
    name: "Theme",
    required: false,
    cardinality: "SINGLE",
    mode: "SELECTION_ONLY",
    allowedValues: ["Sports", "Casual"],
    usage: "RECOMMENDED",
  },
];

Deno.test("no tag read -> the prompt is byte-identical to before", () => {
  const base = buildAspectUserPrompt({
    aspects: SPECS,
    categoryPath: "Clothing > Activewear",
  });
  assertEquals(
    buildAspectUserPrompt({
      aspects: SPECS,
      categoryPath: "Clothing > Activewear",
      tagGroundTruth: null,
    }),
    base,
  );
  assertEquals(
    buildAspectUserPrompt({
      aspects: SPECS,
      categoryPath: "Clothing > Activewear",
      tagGroundTruth: {},
    }),
    base,
  );
  assert(!base.includes("TAG GROUND TRUTH"));
});

Deno.test("a tag read renders as its own block, only the non-empty fields", () => {
  const text = buildAspectUserPrompt({
    aspects: SPECS,
    tagGroundTruth: {
      brand: "Nike",
      country_of_manufacture: "Vietnam",
      garment_care: "Machine wash cold, tumble dry low",
      product_line: "",
    },
  });
  assert(text.includes("TAG GROUND TRUTH"));
  assert(text.includes('"country_of_manufacture": "Vietnam"'));
  assert(text.includes('"garment_care": "Machine wash cold, tumble dry low"'));
  assert(!text.includes("product_line"), "an empty read is not a fact");
});

Deno.test("tagGroundTruthAspectContext is empty for nothing, never a header alone", () => {
  assertEquals(tagGroundTruthAspectContext(null), "");
  assertEquals(tagGroundTruthAspectContext({}), "");
  assertEquals(tagGroundTruthAspectContext({ brand: "  " }), "");
});
