// US-3211 AC3: the prose may not claim a fact the item row cannot back.
//
// The case the story is named for is first: "linen blend" on a cotton
// garment. Everything after it is a way that check could be wrong in the
// direction that matters -- refusing prose that is perfectly true, which is
// how a seller learns to switch the feature off.

import { assert, assertEquals } from "@std/assert";
import {
  brandTokens,
  groundProse,
  MIN_BRAND_TOKEN,
  splitSentences,
  unsupportedClaims,
  type GroundingFacts,
} from "../lib/listing-grounding.ts";

function facts(over: Partial<GroundingFacts> = {}): GroundingFacts {
  return {
    brand: "Carhartt",
    size: "L",
    material: "Cotton",
    color: "Brown",
    title: "Carhartt Detroit jacket",
    ...over,
  };
}

Deno.test("US-3211: 'linen blend' is removed from a cotton garment", () => {
  const prose =
    "A great everyday jacket. The linen blend gives it a soft hand. " +
    "Roomy through the shoulders.";
  const r = groundProse(prose, facts());
  assert(!r.text.includes("linen"), `linen survived: ${r.text}`);
  assert(r.text.includes("A great everyday jacket."));
  assert(r.text.includes("Roomy through the shoulders."));
  assertEquals(r.removed.map((x) => x.token), ["linen"]);
  assertEquals(r.removed[0]!.kind, "material");
});

Deno.test("US-3211: the material the item DOES carry is left alone", () => {
  // The direction that matters. A check that eats true sentences is a check
  // a seller switches off, and then nothing is grounded.
  const prose = "Heavy cotton duck. Cotton softens with every wash.";
  const r = groundProse(prose, facts());
  assertEquals(r.removed, []);
  assertEquals(r.text, prose);
});

Deno.test("US-3211: a fibre the TAG said is grounded even if the row is blank", () => {
  // The tag OCR is a source the seller can point at, which is the test AC3
  // actually sets: the item row, ai_field_sources, and the grade report.
  const r = groundProse("Soft merino wool.", facts({
    material: null,
    ocrText: ["100% MERINO WOOL", "MADE IN ITALY"],
  }));
  assertEquals(r.removed, []);
});

Deno.test("US-3211: a grade report's own words count as a source", () => {
  const r = groundProse("The velvet has light crushing at the elbows.", facts({
    material: null,
    gradeText: ["velvet nap crushed at both elbows"],
  }));
  assertEquals(r.removed, []);
});

Deno.test("US-3211: an invented country of origin goes", () => {
  const r = groundProse("Made in Portugal from lovely stuff.", facts());
  assertEquals(r.removed.map((x) => x.kind), ["origin"]);
  assertEquals(r.text, "");
});

Deno.test("US-3211: the country the tag names stays", () => {
  const r = groundProse("Made in Italy.", facts({ ocrText: ["MADE IN ITALY"] }));
  assertEquals(r.removed, []);
});

Deno.test("US-3211: a size that contradicts the row goes", () => {
  const r = groundProse("Fits like a size M.", facts({ size: "L" }));
  assertEquals(r.removed.map((x) => x.kind), ["size"]);
});

Deno.test("US-3211: the row's own size is fine, in either direction", () => {
  assertEquals(groundProse("Marked size L.", facts({ size: "L" })).removed, []);
  // The row says "Large" and the prose says "L": the same claim.
  assertEquals(groundProse("Marked size L.", facts({ size: "L (42)" })).removed, []);
});

Deno.test("US-3211: an era claim with nothing behind it goes", () => {
  const r = groundProse("A lovely 1970s piece.", facts());
  assertEquals(r.removed.map((x) => x.kind), ["era"]);
});

Deno.test("US-3211: 'vintage' survives when the seller typed it", () => {
  const r = groundProse("True vintage, and it shows.", facts({
    conditionNotes: "vintage, some honest wear",
  }));
  assertEquals(r.removed, []);
});

Deno.test("US-3211: another brand's name goes", () => {
  const r = groundProse(
    "Pairs beautifully with Levi's 501s.",
    facts({ brand: "Carhartt" }),
  );
  assertEquals(r.removed.map((x) => x.kind), ["brand"]);
  assertEquals(r.text, "");
});

Deno.test("US-3211: the garment's OWN brand is never flagged", () => {
  const r = groundProse("Classic Carhartt build.", facts({ brand: "Carhartt" }));
  assertEquals(r.removed, []);
});

Deno.test("US-3211: a short brand token cannot fire on an English word", () => {
  // ⚠ THE TRAP THIS REPO HAS PAID FOR TWICE. The sizing corpus holds "alo"
  // for Alo Yoga and "duluth" for Duluth Trading; a substring match turns
  // "also" into a brand claim and Duluth Pack into Duluth Trading (US-3319).
  for (const prose of [
    "Also great for layering.",
    "A gap at the placket.",
    "Next-day shipping.",
    "Free of odors.",
    "True to size.",
  ]) {
    const r = groundProse(prose, facts());
    assertEquals(
      r.removed.filter((x) => x.kind === "brand"),
      [],
      `"${prose}" was read as a brand claim`,
    );
  }
  for (const [token] of brandTokens()) {
    assert(
      token.length >= MIN_BRAND_TOKEN,
      `brand token "${token}" is shorter than the minimum`,
    );
  }
});

Deno.test("US-3211: a sentence with two bad claims is reported once per claim", () => {
  const r = groundProse("Vintage linen from the 1970s.", facts());
  const kinds = r.removed.map((x) => x.kind).sort();
  assertEquals(kinds, ["era", "era", "material"]);
  // But it is dropped once.
  assertEquals(r.text, "");
});

Deno.test("US-3211: a decimal inside a measurement does not split a sentence", () => {
  const parts = splitSentences("Chest is 25.5 inches. Length is 30 inches.");
  assertEquals(parts.length, 2);
});

Deno.test("US-3211: the kept prose is byte-identical when nothing is removed", () => {
  // Rewriting whitespace on a clean pass would make this check visible to
  // every seller whose prose was fine, which is most of them.
  const prose = "Line one.\n\nLine two is longer, and it ends here.";
  assertEquals(groundProse(prose, facts()).text, prose);
});

Deno.test("US-3211: empty and whitespace prose pass through", () => {
  assertEquals(groundProse("", facts()).text, "");
  assertEquals(groundProse("   ", facts()).removed, []);
});

Deno.test("US-3211: the check is a floor, and the vocabulary is closed", () => {
  // A claim phrased in words nobody listed is NOT caught, and this test
  // exists so that is a stated limit rather than a surprise.
  const r = groundProse("Woven from unobtanium.", facts());
  assertEquals(r.removed, []);
  // What IS listed must be complete enough to matter: the fibres a garment
  // listing actually names.
  for (const token of ["cotton", "linen", "wool", "polyester", "silk", "rayon"]) {
    assert(
      unsupportedClaims(`Made of ${token}.`, facts({ material: null })).length === 1,
      `${token} is not in the material vocabulary`,
    );
  }
});
