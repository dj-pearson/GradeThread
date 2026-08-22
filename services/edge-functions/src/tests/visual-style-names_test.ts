// US-2781: recovering the style line from the listings that match the photo.
//
// ── The refusal this respects ────────────────────────────────────────────────
// style-code-aspects.ts opens by recording why titles are not evidence, and it
// is right on both counts:
//
//   1. A title is marketing text. "Lululemon Align Legging 25 Black Size 6 EUC"
//      is assembled by a seller who may have bought the garment with no tag
//      beyond a size dot and guessed the rest.
//   2. Our own sellers publish to eBay with titles our AI wrote, so reading
//      them back counts three copies of one guess as three witnesses.
//
// Nothing here overturns that. The change is one word wide: a title may
// GENERATE a candidate; it may never CONFIRM one. Every test below is about
// keeping those two apart.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  corroborateStyleName,
  MIN_TITLE_SUPPORT,
  mineStyleNames,
} from "../lib/visual-style-names.ts";

const listing = (itemId: string, title: string) => ({ itemId, title });

// ── Mining ───────────────────────────────────────────────────────────────────

Deno.test("a phrase two listings share becomes a candidate", () => {
  const found = mineStyleNames({
    listings: [
      listing("1", "Lululemon Womens Rest Less Half Zip Pullover Gray Size 6"),
      listing("2", "Lululemon Rest Less Half Zip Sweater Womens 8 Grey EUC"),
    ],
    brand: "Lululemon",
    ownItemIds: new Set(),
  });
  assert(
    found.some((f) => f.name.toLowerCase().includes("rest less")),
    `expected a "Rest Less" candidate, got ${JSON.stringify(found)}`,
  );
});

Deno.test("one listing is never a consensus", () => {
  assertEquals(
    mineStyleNames({
      listings: [listing("1", "Lululemon Rest Less Half Zip Pullover")],
      brand: "Lululemon",
      ownItemIds: new Set(),
    }),
    [],
  );
  assertEquals(MIN_TITLE_SUPPORT, 2);
});

Deno.test("the brand is never mined as its own style name", () => {
  const found = mineStyleNames({
    listings: [
      listing("1", "Lululemon Lululemon Athletica Womens Top"),
      listing("2", "Lululemon Athletica Womens Top Gray"),
    ],
    brand: "Lululemon",
    ownItemIds: new Set(),
  });
  for (const f of found) {
    assert(
      !f.name.toLowerCase().includes("lululemon"),
      `brand leaked into a style name: ${f.name}`,
    );
  }
});

Deno.test("sizes, conditions and colours are noise, not names", () => {
  const found = mineStyleNames({
    listings: [
      listing("1", "Patagonia Better Sweater Mens Large Black EUC NWT"),
      listing("2", "Patagonia Better Sweater Mens Large Black EUC NWT"),
    ],
    brand: "Patagonia",
    ownItemIds: new Set(),
  });
  const names = found.map((f) => f.name.toLowerCase());
  assert(names.some((n) => n.includes("better sweater")));
  for (const n of names) {
    assert(!n.includes("euc"), `condition token survived: ${n}`);
    assert(!n.includes("nwt"), `condition token survived: ${n}`);
    assert(!n.includes("large"), `size token survived: ${n}`);
    assert(!n.includes("black"), `colour token survived: ${n}`);
  }
});

Deno.test("our own listings are excluded BEFORE anything is counted", () => {
  // Three copies of one guess agreeing is one guess. Excluding after the tally
  // would still let our own AI's wording set the winner.
  assertEquals(
    mineStyleNames({
      listings: [
        listing("ours-1", "Lululemon Rest Less Half Zip Pullover"),
        listing("ours-2", "Lululemon Rest Less Half Zip Pullover"),
        listing("ours-3", "Lululemon Rest Less Half Zip Pullover"),
      ],
      brand: "Lululemon",
      ownItemIds: new Set(["ours-1", "ours-2", "ours-3"]),
    }),
    [],
  );
});

Deno.test("no brand still mines, because a name is a name", () => {
  const found = mineStyleNames({
    listings: [
      listing("1", "Mens Better Sweater Fleece Jacket Medium"),
      listing("2", "Better Sweater Fleece Jacket Womens Small"),
    ],
    brand: null,
    ownItemIds: new Set(),
  });
  assert(found.length > 0);
});

// ── Corroboration: the half that decides whether it ships ────────────────────

Deno.test("a mined name with no second source is NOT offered", () => {
  assertEquals(
    corroborateStyleName("Rest Less Half Zip", {
      knownStyleNames: [],
      decodedStyleName: null,
      aspectProductNames: [],
    }),
    null,
  );
});

Deno.test("a brand_styles row corroborates", () => {
  const got = corroborateStyleName("Better Sweater", {
    knownStyleNames: ["Better Sweater", "Nano Puff"],
    decodedStyleName: null,
    aspectProductNames: [],
  });
  assertEquals(got?.source, "brand_styles");
});

Deno.test("a style code decoded off the tag corroborates", () => {
  // The strongest of the three: a code printed on the garment is not marketing.
  const got = corroborateStyleName("ABC Pant Classic", {
    knownStyleNames: [],
    decodedStyleName: "ABC Pant Classic",
    aspectProductNames: [],
  });
  assertEquals(got?.source, "style_code");
});

Deno.test("an item-specific Model field corroborates, a title never does", () => {
  // The Model aspect is a field a seller FILLED IN on purpose. That is the
  // distinction style-code-aspects.ts draws and it is the whole basis here.
  const got = corroborateStyleName("Rest Less Half Zip", {
    knownStyleNames: [],
    decodedStyleName: null,
    aspectProductNames: ["Rest Less Half Zip"],
  });
  assertEquals(got?.source, "aspect_model");
});

Deno.test("corroboration ignores case and spacing, not words", () => {
  assert(
    corroborateStyleName("  better   SWEATER ", {
      knownStyleNames: ["Better Sweater"],
      decodedStyleName: null,
      aspectProductNames: [],
    }),
  );
  // A different garment is a different garment.
  assertEquals(
    corroborateStyleName("Better Sweater Vest", {
      knownStyleNames: ["Better Sweater"],
      decodedStyleName: null,
      aspectProductNames: [],
    }),
    null,
  );
});

Deno.test("the strongest source wins when several agree", () => {
  const got = corroborateStyleName("Better Sweater", {
    knownStyleNames: ["Better Sweater"],
    decodedStyleName: "Better Sweater",
    aspectProductNames: ["Better Sweater"],
  });
  assertEquals(got?.source, "style_code");
});
