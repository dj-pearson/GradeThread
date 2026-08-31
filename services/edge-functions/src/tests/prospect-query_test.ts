// US-3026: the three strings /prospect builds from one identity.
//
// The reported failure is the first test in this file and it is a real scan: a
// We The Free off-the-shoulder cropped top whose sold-comps link opened eBay's
// completed search for the brand alone. Everything else here is a rule that
// failure exposed.
//
// Pure module - no eBay, no Anthropic, no database, no dummy env needed.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildBroadSearchQuery,
  buildCompQuerySeed,
  buildDisplayTitle,
  buildSoldSearchQuery,
  emptyIdentity,
  type GarmentIdentity,
  identityFromKeywords,
  identityFromListingTitle,
  identityIsUsable,
  identityKeywords,
  MAX_SOLD_QUERY_TOKENS,
} from "../lib/prospect-query.ts";

function weTheFree(): GarmentIdentity {
  return {
    ...emptyIdentity(),
    brand: "We The Free",
    garmentType: "cropped top",
    color: "blue",
    descriptors: ["off the shoulder"],
    gender: "women",
    size: "M",
    confidence: 0.8,
  };
}

Deno.test("the reported scan: the sold link carries the cut, not just the brand", () => {
  const q = buildSoldSearchQuery(weTheFree());
  // The brand is one phrase, or eBay ANDs "free" against every listing whose
  // seller wrote "free shipping".
  assertStringIncludes(q, '"We The Free"');
  assertStringIncludes(q, "blue");
  assertStringIncludes(q, "shoulder");
  assertStringIncludes(q, "top");
  // The old behaviour, which is what the seller complained about.
  assert(q !== "We The Free");
});

Deno.test("sold query: a single-word brand is not quoted", () => {
  const id = { ...emptyIdentity(), brand: "Patagonia", garmentType: "fleece" };
  assertEquals(buildSoldSearchQuery(id), "Patagonia fleece");
});

Deno.test("sold query: filler words are dropped, because eBay ANDs them", () => {
  const q = buildSoldSearchQuery(weTheFree());
  assertEquals(q.split(/\s+/).includes("the"), false, `"the" survived in: ${q}`);
});

Deno.test("sold query: capped, so a specific search cannot return an empty page", () => {
  const id: GarmentIdentity = {
    ...emptyIdentity(),
    brand: "Lululemon",
    garmentType: "half zip pullover",
    color: "teal",
    descriptors: ["thumbhole", "swirl scroll", "brushed", "cropped"],
    material: "warpstreme",
  };
  const tail = buildSoldSearchQuery(id).split(/\s+/).slice(1);
  assertEquals(tail.length, MAX_SOLD_QUERY_TOKENS);
});

Deno.test("sold query: a style code replaces the descriptive words", () => {
  const id = { ...weTheFree(), styleCode: "LW7DVCS" };
  assertEquals(buildSoldSearchQuery(id), '"We The Free" LW7DVCS');
});

Deno.test("sold query: brand tokens are never repeated in the tail", () => {
  const id: GarmentIdentity = {
    ...emptyIdentity(),
    brand: "Free People",
    garmentType: "people dress",
    descriptors: ["free"],
  };
  const tail = buildSoldSearchQuery(id).split(/\s+/).slice(1);
  assertEquals(tail.includes("free"), false);
  assertEquals(tail.includes("people"), false);
});

Deno.test("broad query: brand plus garment type, and it is a different link", () => {
  const id = weTheFree();
  const broad = buildBroadSearchQuery(id);
  assertEquals(broad, '"We The Free" cropped top');
  assert(broad !== buildSoldSearchQuery(id));
});

Deno.test("broad query: never empty while anything is known", () => {
  assertEquals(buildBroadSearchQuery({ ...emptyIdentity(), brand: "Nike" }), "Nike");
  assertEquals(
    buildBroadSearchQuery({ ...emptyIdentity(), garmentType: "denim jacket" }),
    "denim jacket",
  );
});

Deno.test("comp seed: colour is stripped, because a red one and a blue one are one product", () => {
  const seed = buildCompQuerySeed(weTheFree());
  assertEquals(seed.split(/\s+/).includes("blue"), false, seed);
  assertStringIncludes(seed, "shoulder");
  assertStringIncludes(seed, "cropped top");
});

Deno.test("comp seed: the brand is not joined in - it travels as its own field", () => {
  const seed = buildCompQuerySeed(weTheFree());
  assertEquals(seed.includes("free"), false, seed);
});

Deno.test("display title: brand casing is preserved verbatim", () => {
  const id = { ...emptyIdentity(), brand: "L'AGENCE", garmentType: "silk blouse" };
  assertStringIncludes(buildDisplayTitle(id), "L'AGENCE");
  const lulu = { ...emptyIdentity(), brand: "lululemon", garmentType: "tank" };
  assertStringIncludes(buildDisplayTitle(lulu), "lululemon");
});

Deno.test("display title: reads like English and keeps the cut", () => {
  assertEquals(
    buildDisplayTitle(weTheFree()),
    "We The Free Blue Off the Shoulder Cropped Top",
  );
});

Deno.test("display title: a word already in the brand is not repeated", () => {
  const id: GarmentIdentity = {
    ...emptyIdentity(),
    brand: "The North Face",
    garmentType: "north face jacket",
  };
  assertEquals(buildDisplayTitle(id), "The North Face Jacket");
});

Deno.test("usable: a brand alone is comp-able, a bare garment type is not", () => {
  assert(identityIsUsable({ ...emptyIdentity(), brand: "Carhartt" }));
  assert(!identityIsUsable({ ...emptyIdentity(), garmentType: "top" }));
  assert(identityIsUsable({ ...emptyIdentity(), garmentType: "top", color: "blue" }));
  assert(!identityIsUsable(emptyIdentity()));
});

Deno.test("listing title: a seller's SEO becomes a product description", () => {
  const id = identityFromListingTitle(
    "NWT Free People We The Free Womens Blue Off The Shoulder Crop Top Size M Boho",
  );
  assertEquals(id.color, "blue");
  // Chatter and sizes are gone.
  const all = [...id.descriptors, id.garmentType ?? ""].join(" ");
  for (const junk of ["nwt", "womens", "size", "m"]) {
    assertEquals(all.split(/\s+/).includes(junk), false, `${junk} survived in: ${all}`);
  }
  // The head noun goes last in English.
  assertEquals(id.garmentType, "boho");
});

Deno.test("listing title: a known brand's tokens are removed rather than repeated", () => {
  const id = identityFromListingTitle(
    "We The Free Blue Off The Shoulder Crop Top",
    "We The Free",
  );
  const all = [...id.descriptors, id.garmentType ?? ""].join(" ");
  assertEquals(all.split(/\s+/).includes("free"), false, all);
  assertEquals(id.brand, "We The Free");
});

Deno.test("keywords: the flat list both phone clients decode still comes out", () => {
  const kw = identityKeywords(weTheFree());
  assertEquals(kw[0], "blue");
  assert(kw.includes("cropped"));
  assert(kw.includes("top"));
});

Deno.test("keywords: from a seller's corrected free text", () => {
  const id = identityFromKeywords("We The Free", ["blue off the shoulder cropped top"]);
  assertEquals(id.color, "blue");
  assertEquals(id.garmentType, "top");
  assertEquals(id.brand, "We The Free");
});
