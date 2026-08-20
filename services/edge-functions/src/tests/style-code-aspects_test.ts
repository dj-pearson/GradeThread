// US-2751: evidence from what a seller FILLED IN, not from what they wrote.
//
// Every test here exists because the previous design would have got it wrong:
// it read titles, and a title is assembled by someone who may have bought the
// garment with no tag beyond a size dot.
import { assertEquals } from "@std/assert";
import {
  aspectEvidence,
  classifyListing,
  declaredProductName,
  declaredStyleCode,
  type ListingAspects,
} from "../lib/style-code-aspects.ts";

/** Stands in for canonicalStyleCode without the supabase import chain. */
const canonicalize = (raw: string) => {
  const norm = (raw ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const m = norm.match(/^L?([WM][A-Z0-9]{4}[A-Z])(?:[A-Z]\d{5,6})?$/);
  return m ? m[1]! : norm;
};

const NONE = new Set<string>();

function listing(over: Partial<ListingAspects> = {}): ListingAspects {
  return {
    itemId: "v1|1234|0",
    title: "Lululemon Scuba Oversized Half Zip Hoodie Black Size 6 EUC",
    aspects: {
      Brand: "Lululemon",
      "Style Code": "W6AMYS",
      Model: "Scuba Oversized Half Zip Hoodie",
      Size: "6",
    },
    ...over,
  };
}

Deno.test("US-2751: a structured code that MATCHES makes the listing evidence", () => {
  const c = classifyListing({
    listing: listing(),
    canonicalCode: "W6AMYS",
    canonicalize,
    ownItemIds: NONE,
  });
  assertEquals(c.verdict, "confirmed");
  assertEquals(c.name, "Scuba Oversized Half Zip Hoodie");
});

Deno.test("US-2751: a perfect-looking TITLE with no structured code is not evidence", () => {
  // The heart of it. The old design would have believed this listing.
  const c = classifyListing({
    listing: listing({
      aspects: { Brand: "Lululemon", Size: "6" },
      title: "Lululemon Scuba Oversized Half Zip Hoodie W6AMYS Black 6",
    }),
    canonicalCode: "W6AMYS",
    canonicalize,
    ownItemIds: NONE,
  });
  assertEquals(c.verdict, "unconfirmed");
  assertEquals(c.name, null);
});

Deno.test("US-2751: a listing declaring a DIFFERENT code contradicts, it does not abstain", () => {
  const c = classifyListing({
    listing: listing({ aspects: { "Style Code": "M7A83S", Model: "Commission Short" } }),
    canonicalCode: "W6AMYS",
    canonicalize,
    ownItemIds: NONE,
  });
  assertEquals(c.verdict, "contradicting");
});

Deno.test("US-2751: our OWN listing is excluded, whatever it declares", () => {
  // Our sellers publish with titles our AI wrote. Reading them back as market
  // evidence is three copies of one guess wearing three hats.
  const c = classifyListing({
    listing: listing(),
    canonicalCode: "W6AMYS",
    canonicalize,
    ownItemIds: new Set(["v1|1234|0"]),
  });
  assertEquals(c.verdict, "own_listing");
  assertEquals(c.name, null);
});

Deno.test("US-2751: the code aspect is read under any of its spellings", () => {
  for (const field of ["Style Code", "MPN", "Manufacturer Part Number", "style code"]) {
    const l = listing({ aspects: { [field]: "LW6AMYSP60417", Model: "Scuba Hoodie Oversized" } });
    assertEquals(declaredStyleCode(l, canonicalize), "W6AMYS", field);
  }
});

Deno.test("US-2751: a Model field that is a silhouette or the code is not a name", () => {
  // "Jogger" is a shape. The code repeated back says nothing about the product.
  assertEquals(declaredProductName(listing({ aspects: { Model: "Jogger" } })), null);
  assertEquals(declaredProductName(listing({ aspects: { Model: "W6AMYS" } })), null);
  assertEquals(declaredProductName(listing({ aspects: {} })), null);
  // Model wins over Style when both are present.
  assertEquals(
    declaredProductName(listing({ aspects: { Style: "Pullover", Model: "Scuba Hoodie Oversized" } })),
    "Scuba Hoodie Oversized",
  );
});

Deno.test("US-2751: ONE confirmed listing is enough, unlike three agreeing titles", () => {
  // Categorically stronger evidence: a structured code that matches plus a
  // structured name, from a seller who typed both.
  const ev = aspectEvidence([
    { itemId: "a", verdict: "confirmed", name: "Scuba Oversized Half Zip Hoodie" },
    { itemId: "b", verdict: "unconfirmed", name: null },
    { itemId: "c", verdict: "unconfirmed", name: null },
  ]);
  assertEquals(ev.name, "Scuba Oversized Half Zip Hoodie");
  assertEquals(ev.confirming, 1);
  assertEquals(ev.unconfirmed, 2);
});

Deno.test("US-2751: confirmed listings that DISAGREE yield nothing", () => {
  // Two people who both read the tag and disagree is a question for a human,
  // not something to settle by counting.
  const ev = aspectEvidence([
    { itemId: "a", verdict: "confirmed", name: "Scuba Oversized Half Zip" },
    { itemId: "b", verdict: "confirmed", name: "Define Jacket Luxtreme" },
  ]);
  assertEquals(ev.name, null);
  assertEquals(ev.confirming, 2);
});

Deno.test("US-2751: the same name spelled differently still agrees", () => {
  const ev = aspectEvidence([
    { itemId: "a", verdict: "confirmed", name: "Scuba Oversized Half-Zip Hoodie" },
    { itemId: "b", verdict: "confirmed", name: "scuba oversized half zip hoodie" },
  ]);
  assertEquals(ev.name, "Scuba Oversized Half-Zip Hoodie");
  assertEquals(ev.confirming, 2);
});

Deno.test("US-2751: contradictions are counted, because they mean something", () => {
  // A code with many contradictions is one our canonicalization may be
  // mangling — worth surfacing rather than silently ignoring.
  const ev = aspectEvidence([
    { itemId: "a", verdict: "contradicting", name: null },
    { itemId: "b", verdict: "contradicting", name: null },
    { itemId: "c", verdict: "own_listing", name: null },
  ]);
  assertEquals(ev.name, null);
  assertEquals(ev.confirming, 0);
  assertEquals(ev.contradicting, 2);
  assertEquals(ev.ownListings, 1);
});

Deno.test("US-2751: nothing at all is not an answer", () => {
  assertEquals(aspectEvidence([]).name, null);
  assertEquals(aspectEvidence([]).confirming, 0);
});
