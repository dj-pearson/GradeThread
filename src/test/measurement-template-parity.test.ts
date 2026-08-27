// US-2225 AC4: the two measurement-template copies must not drift.
//
// src/lib/measurement-templates.ts and
// services/edge-functions/src/lib/measurement-templates.ts are byte-identical
// today and NOTHING pinned them — the third instance of that shape this repo
// has found, after the rubric definitions (US-1997) and title-sync (US-1995).
// Both of those got a shared behavioural fixture only after a divergence became
// possible; this one is pinned before.
//
// A divergence here is quiet and expensive in a specific way: measurements are
// stored on inventory_items.measurements keyed by the field `key`, so if one
// side renames a key the web form writes `strap_drop` and the edge extractor
// reads `strapDrop`, and the measurement simply does not exist as far as the
// listing description, the size estimate and the MeasureCard accuracy gate are
// concerned. Nothing errors; a number the seller typed just stops arriving.
//
// A SOURCE COMPARISON is the right guard here, unlike title-sync where the two
// implementations legitimately differ. These two files are meant to be the same
// file, so byte equality is the actual contract — and it fails with a diff a
// human can read rather than a behavioural mismatch they have to localise.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { GARMENT_CATEGORIES } from "../lib/constants";
import { templateGroupFor } from "../lib/listing-templates";
import {
  ebayCategoryLeaf,
  garmentDescriptorFor,
  MEASUREMENT_TEMPLATES,
  measurementGroupFor,
  measurementGroupForItem,
} from "../lib/measurement-templates";

const WEB = "src/lib/measurement-templates.ts";
const EDGE = "services/edge-functions/src/lib/measurement-templates.ts";

/** Line endings differ by checkout; content must not. */
function normalized(path: string): string {
  return readFileSync(path, "utf8").split("\r\n").join("\n");
}

describe("US-2225: the measurement templates are one definition in two files", () => {
  it("the web and edge copies are identical", () => {
    expect(normalized(EDGE)).toBe(normalized(WEB));
  });
});

// ── US-2798: a group is only reachable if some WORD names it ────────────────
//
// GROUP_WORDS is a Record<NamedGroup, string[]>, so the compiler guarantees
// every group has an entry. It does not guarantee the entry contains the words
// that actually arrive. `neckwear` is a GARMENT_CATEGORIES value the extraction
// classifier emits — US-2571 made sure of that — and no human types it, so it
// was in nobody's word list. A tie therefore resolved to `generic`, whose
// length and width are OPTIONAL, instead of `accessory`, where they are
// REQUIRED and a belt gets its hole span. US-2224 created the accessory group
// for ties and belts; the one category named after ties could not reach it.
//
// This is the same shape as US-2797 one table over: a value exists, a
// destination exists, and nothing connects the two. Both halves look correct
// read on their own.
describe("US-2798: every taxonomy value reaches a real measurement group", () => {
  it("no garment category falls through to generic", () => {
    // `other` is the one honest exception: it means "we could not classify
    // this", and generic — length and width, both optional — is the correct
    // answer to that.
    const fellThrough = GARMENT_CATEGORIES.filter(
      (c) => c !== "other" && measurementGroupFor(c) === "generic",
    );
    expect(
      fellThrough,
      `these garment categories resolve to the generic template, so the seller ` +
        `is offered length and width as OPTIONAL fields instead of the group ` +
        `built for them: ${fellThrough.join(", ")}. Add the value itself to ` +
        `that group's GROUP_WORDS — it is a taxonomy value, not a word anyone ` +
        `says, so no ordinary synonym will ever match it.`,
    ).toEqual([]);
  });

  it("every group is reachable by naming it", () => {
    // Guards the reverse: a group whose own name does not resolve to it is one
    // no caller can select deliberately, whatever else is in the word list.
    for (const group of Object.keys(MEASUREMENT_TEMPLATES)) {
      if (group === "generic") continue; // the fallback, never named
      expect(measurementGroupFor(group), `group "${group}" cannot name itself`)
        .toBe(group);
    }
  });

  it("the accessory group really is stricter than generic", () => {
    // The assertion above is only worth making if landing in `accessory`
    // changes something. If these two templates ever converge, the first test
    // becomes a no-op that still passes.
    const acc = MEASUREMENT_TEMPLATES.accessory;
    const gen = MEASUREMENT_TEMPLATES.generic;
    expect(acc.filter((f) => f.required).length).toBeGreaterThan(
      gen.filter((f) => f.required).length,
    );
  });
});

describe("US-2225 AC4: bags can actually be measured", () => {
  it("offers width, height and depth, all required", () => {
    // Depth is the one that matters: a 30cm tote and a 30cm clutch are
    // different objects, and before this the bag fell through to `generic`,
    // which offers length and width and neither of them required.
    const fields = MEASUREMENT_TEMPLATES.bag;
    const required = fields.filter((f) => f.required).map((f) => f.key);
    expect(required).toEqual(["width", "height", "depth"]);
  });

  it("offers BOTH strap drop and handle drop, both optional", () => {
    // A top-handle bag has no strap and a crossbody has no handles. One shared
    // field would sit blank on half of all bags, and a blank measurement reads
    // as "the seller did not measure it" rather than "this bag has no strap".
    const keys = MEASUREMENT_TEMPLATES.bag.map((f) => f.key);
    expect(keys).toContain("strap_drop");
    expect(keys).toContain("handle_drop");
    for (const k of ["strap_drop", "handle_drop"]) {
      expect(MEASUREMENT_TEMPLATES.bag.find((f) => f.key === k)?.required).toBe(false);
    }
  });

  it("every bag dimension uses the in/cm length unit", () => {
    // `shoe` and `mm` exist for the two categories that need them; a bag
    // measured in millimetres would render as "300 mm depth".
    for (const f of MEASUREMENT_TEMPLATES.bag) {
      expect(f.unit, f.key).toBe("length");
    }
  });
});

describe("US-2223 AC2: hats can be measured", () => {
  it("requires the circumference and nothing else", () => {
    const required = MEASUREMENT_TEMPLATES.headwear
      .filter((f) => f.required)
      .map((f) => f.key);
    expect(required).toEqual(["circumference"]);
  });

  it("treats circumference as a LENGTH, not a size label", () => {
    // "7 3/8" is a size label nobody put a tape to, and it belongs in the
    // item's size field. Half of resale headwear is snapback or strapback with
    // no numeric size at all, so a size-only template leaves those
    // unmeasurable — which is why this is a length in inches or centimetres.
    for (const f of MEASUREMENT_TEMPLATES.headwear) {
      expect(f.unit, f.key).toBe("length");
    }
    expect(MEASUREMENT_TEMPLATES.headwear.map((f) => f.key))
      .toEqual(["circumference", "crown_height", "brim_length"]);
  });

  it("routes the words sellers actually type, including visors", () => {
    for (
      const c of [
        "hat", "cap", "beanie", "snapback", "trucker hat",
        "bucket hat", "fedora", "beret", "visor",
      ]
    ) {
      expect(measurementGroupFor(c), c).toBe("headwear");
    }
  });

  it("still loses to bags, which own the noun", () => {
    expect(measurementGroupFor("hat bag")).toBe("bag");
  });
});

describe("US-2224 AC4: ties, belts, scarves and gloves can be measured", () => {
  it("requires the two numbers all four are sold on", () => {
    const required = MEASUREMENT_TEMPLATES.accessory
      .filter((f) => f.required)
      .map((f) => f.key);
    expect(required).toEqual(["length", "width"]);
  });

  it("offers a belt's wearable range as a SPAN, not a hole count", () => {
    // A hole count tells a buyer nothing without the spacing. First-to-last
    // hole is the number that answers "will this fit me".
    const span = MEASUREMENT_TEMPLATES.accessory.find((f) => f.key === "hole_span");
    expect(span).toBeDefined();
    expect(span!.required).toBe(false);
    expect(span!.label.toLowerCase()).toContain("hole");
  });

  it("routes the four categories, and the words sellers actually type", () => {
    for (
      const c of [
        "tie", "necktie", "bow tie", "belt", "scarf", "scarves",
        "gloves", "mittens", "shawl", "pocket square", "suspenders",
      ]
    ) {
      expect(measurementGroupFor(c), c).toBe("accessory");
    }
  });

  it("does not claim socks", () => {
    // Deliberately absent: socks sell by size, not by measurement, and asking
    // a seller to measure one would ask for a number nobody publishes.
    expect(measurementGroupFor("socks")).toBe("generic");
  });

  it("loses to bags, which is the right precedence", () => {
    // A "tie bag" is a bag. Bags are tested first for exactly this reason.
    expect(measurementGroupFor("tie bag")).toBe("bag");
  });
});

describe("US-2225: routing a bag to the bag template", () => {
  it("recognises the words sellers actually use", () => {
    for (
      const c of [
        "bags", "handbag", "Purse", "tote bag", "clutch", "satchel",
        "crossbody", "backpack", "duffel", "wallet", "briefcase",
      ]
    ) {
      expect(measurementGroupFor(c), c).toBe("bag");
    }
  });

  it("wins over a keyword an earlier branch would have claimed", () => {
    // The noun that matters is the LAST one. Tested before shoes precisely
    // because these three exist and every one of them is a bag — routing them
    // to the shoe template would ask the seller for an insole length.
    expect(measurementGroupFor("boot bag")).toBe("bag");
    expect(measurementGroupFor("shoe bag")).toBe("bag");
    expect(measurementGroupFor("cargo bag")).toBe("bag");
  });

  it("does not steal categories that are not bags", () => {
    expect(measurementGroupFor("t-shirt")).toBe("top");
    expect(measurementGroupFor("jeans")).toBe("bottom");
    expect(measurementGroupFor("boots")).toBe("shoes");
    expect(measurementGroupFor("watch")).toBe("watch");
    expect(measurementGroupFor("")).toBe("generic");
    expect(measurementGroupFor(null)).toBe("generic");
  });
});

describe("US-2464 AC1/AC2: 'dress' is a modifier more often than a noun", () => {
  // The bug this pins: the dress branch is tested BEFORE both `bottom` and
  // `top`, so every "dress <noun>" compound was measured as a dress. A seller
  // listing dress pants was asked for a bust and never once for an inseam —
  // which is the exact complaint that opened this epic.
  it("routes dress bottoms to the bottom template", () => {
    for (const c of ["dress pants", "dress trousers", "dress slacks", "dress shorts"]) {
      expect(measurementGroupFor(c), c).toBe("bottom");
    }
  });

  it("routes a dress shirt to the top template", () => {
    // Same bug, opposite direction, and the reason the fix is a compound guard
    // rather than a branch reorder.
    for (const c of ["dress shirt", "Dress Shirts", "dress blouse"]) {
      expect(measurementGroupFor(c), c).toBe("top");
    }
  });

  it("still routes an actual dress to the dress template", () => {
    for (const c of ["dress", "sundress", "shirtdress", "maxi dress", "romper", "jumpsuit"]) {
      expect(measurementGroupFor(c), c).toBe("dress");
    }
  });

  it("keeps the compounds an earlier branch already owned", () => {
    // These never hit the dress branch — they are claimed before it — and the
    // guard must not change that.
    expect(measurementGroupFor("dress shoes")).toBe("shoes");
    expect(measurementGroupFor("dress belt")).toBe("accessory");
    expect(measurementGroupFor("dress coat")).toBe("outerwear");
  });
});

describe("US-2464 AC3: a suit set is measured as a top AND a bottom", () => {
  it("offers both halves, with the four a buyer cannot size without required", () => {
    const required = MEASUREMENT_TEMPLATES.suit.filter((f) => f.required).map((f) => f.key);
    expect(required).toEqual(["chest", "length", "waist", "inseam"]);
    expect(MEASUREMENT_TEMPLATES.suit.map((f) => f.key))
      .toEqual(["chest", "length", "shoulder", "sleeve", "waist", "inseam", "rise"]);
  });

  it("reuses the outerwear and bottom keys rather than inventing new ones", () => {
    // A suit's jacket chest IS a chest. Inventing `jacket_chest` would make a
    // suit invisible to the listing description, the eBay specifics sync and
    // the fit widget, all of which already know these keys.
    const suitKeys = new Set(MEASUREMENT_TEMPLATES.suit.map((f) => f.key));
    for (const f of MEASUREMENT_TEMPLATES.outerwear) expect(suitKeys).toContain(f.key);
    for (const k of ["waist", "inseam", "rise"]) expect(suitKeys).toContain(k);
  });

  it("labels every field with which piece it belongs to", () => {
    // On a two-piece the seller is holding two garments, and "Waist" alone is
    // genuinely ambiguous between the jacket's and the trouser's.
    for (const f of MEASUREMENT_TEMPLATES.suit) {
      expect(f.label.toLowerCase(), f.key).toMatch(/jacket|pant/);
    }
  });

  it("routes the words sellers actually type", () => {
    for (
      const c of [
        "suit", "Suit Set", "two piece suit", "three-piece suit", "tuxedo",
        "pantsuit", "coveralls", "overalls", "tracksuit", "sweatsuit",
        "pajamas", "scrubs",
      ]
    ) {
      expect(measurementGroupFor(c), c).toBe("suit");
    }
  });

  it("does not claim words that merely contain 'suit'", () => {
    // A swimsuit and a bodysuit are single garments; a jumpsuit is measured
    // like a dress. Tracksuits and sweatsuits are NOT excluded — they are two
    // pieces and a buyer needs both sets of numbers.
    expect(measurementGroupFor("swimsuit")).toBe("dress");
    expect(measurementGroupFor("jumpsuit")).toBe("dress");
    expect(measurementGroupFor("wetsuit")).toBe("generic");
  });

  it("yields to a single named piece", () => {
    // A standalone suit jacket is outerwear and suit pants are a bottom. Only
    // the set gets both halves.
    expect(measurementGroupFor("suit jacket")).toBe("outerwear");
    expect(measurementGroupFor("suit pants")).toBe("bottom");
    expect(measurementGroupFor("tuxedo trousers")).toBe("bottom");
  });
});

describe("US-2464 AC4: the garments that used to fall to 'generic'", () => {
  it("routes swimwear and open-front layers", () => {
    expect(measurementGroupFor("bikini")).toBe("dress");
    expect(measurementGroupFor("one piece swimsuit")).toBe("dress");
    expect(measurementGroupFor("swim trunks")).toBe("bottom");
    expect(measurementGroupFor("board shorts")).toBe("bottom");
    expect(measurementGroupFor("bathrobe")).toBe("outerwear");
    expect(measurementGroupFor("kimono")).toBe("outerwear");
    expect(measurementGroupFor("poncho")).toBe("outerwear");
  });
});

describe("US-2595: 'clothing' is a vertical, not a garment", () => {
  // items_full.category is COALESCE(item_category, garment_category), so the
  // moment an item's vertical is set the web surfaces read "clothing" — and
  // measurementGroupFor("clothing") is `generic`, the length-and-width
  // fallback. Every blazer stopped being asked for a chest, a shoulder or a
  // sleeve, and every pair of shorts stopped being asked for a waist and an
  // inseam. The specific word was one column over the whole time.
  it("the coarse vertical alone still resolves to generic", () => {
    expect(measurementGroupFor("clothing")).toBe("generic");
  });

  it("resolves the garment column ahead of the vertical", () => {
    expect(
      measurementGroupForItem({
        item_category: "clothing",
        category: "clothing",
        garment_category: "jacket",
        garment_type: "outerwear",
      }),
    ).toBe("outerwear");
    expect(
      measurementGroupForItem({
        item_category: "clothing",
        category: "clothing",
        garment_category: "shorts",
      }),
    ).toBe("bottom");
  });

  it("falls back through garment_type, then the title", () => {
    expect(
      measurementGroupForItem({ item_category: "clothing", garment_type: "tops" }),
    ).toBe("top");
    expect(
      measurementGroupForItem({
        item_category: "clothing",
        title: "Vintage Levi's 550 Denim Shorts",
      }),
    ).toBe("bottom");
  });

  it("hands back a usable descriptor even when nothing resolves", () => {
    // The caller still needs something to label a field with — "" would be a
    // worse answer than the string we were actually given.
    expect(garmentDescriptorFor({ item_category: "clothing" })).toBe("clothing");
    expect(garmentDescriptorFor({})).toBe("");
  });

  it("the composer feeds the garment into the measurement card", () => {
    // The wiring is the fix — the resolver alone changes nothing if the page
    // keeps passing item.category.
    const composer = readFileSync("src/pages/flipdesk/composer.tsx", "utf8");
    expect(composer).toContain("garmentDescriptorFor({");
    expect(composer).toContain("garment={measurementGarment}");
    const card = readFileSync(
      "src/components/flipdesk/composer/measurements-card.tsx",
      "utf8",
    );
    expect(card).toContain("const category = garment ?? item.category;");
  });
});

// US-2673: a real pair of jeans was offered a chest and a sleeve.
//
// Reported on a live listing: "Polo Ralph Lauren Women's Skinny Jeans Size 27".
// The row held garment_type "tops" and garment_category "other" — not a
// classification, but the pair deriveGarmentFields() writes for ANY clothing
// item intake never classified. The resolver read that vertical second, ahead
// of the title, so the measurement card, the photo tags and the description
// template all said Top while the eBay category on the same row said Jeans.
describe("US-2673: a fabricated vertical does not outrank a real garment word", () => {
  it("the reported item resolves as a bottom", () => {
    const row = {
      garment_category: "other",
      garment_type: "tops",
      category: "clothing",
      title: "Polo Ralph Lauren Women's Skinny Jeans Size 27 Floral Print Denim RL",
    };
    expect(measurementGroupForItem(row)).toBe("bottom");
    const keys = MEASUREMENT_TEMPLATES[measurementGroupForItem(row)].map((f) => f.key);
    expect(keys).toContain("waist");
    expect(keys).toContain("inseam");
    expect(keys).not.toContain("sleeve");
  });

  it("a vertical still wins when it is the only garment word on the row", () => {
    // iOS genuinely stores the coarse value here, and "bottoms" with nothing
    // else to go on beats `generic`. The change is precedence, not exclusion.
    expect(
      measurementGroupForItem({ garment_type: "bottoms", title: "Levi's 501 W34 L32" }),
    ).toBe("bottom");
    expect(measurementGroupForItem({ garment_type: "tops" })).toBe("top");
    expect(measurementGroupForItem({ garment_type: "accessories" })).toBe("accessory");
  });

  it("a real classification is still preferred over the title", () => {
    expect(
      measurementGroupForItem({
        garment_category: "jeans",
        garment_type: "bottoms",
        title: "Brooks Brothers Blazer 42R",
      }),
    ).toBe("bottom");
  });
});

// US-2673: the matcher reads whole words and takes the LAST garment noun.
describe("US-2673: brand and style words stop hijacking the template", () => {
  it("does not match a garment word inside a longer word", () => {
    // Every one of these was confidently wrong before: /bag/ matched Baggies,
    // /cap/ matched Capri, /boot/ matched Bootcut.
    expect(measurementGroupFor("Patagonia Baggies Shorts 5in Mens M")).toBe("bottom");
    expect(measurementGroupFor("Zara Capri Pants Womens 6")).toBe("bottom");
    expect(measurementGroupFor("Levi's 505 Bootcut Jeans W34 L32")).toBe("bottom");
    expect(measurementGroupFor("Topshop Jamie Jeans W28")).toBe("bottom");
  });

  it("takes the head noun, which in English comes last", () => {
    expect(measurementGroupFor("Nike Tech Fleece Joggers")).toBe("bottom");
    expect(measurementGroupFor("The North Face Fleece Jacket")).toBe("outerwear");
    expect(measurementGroupFor("Carhartt Cargo Jacket")).toBe("outerwear");
    expect(measurementGroupFor("Carhartt Cargo Pants")).toBe("bottom");
    expect(measurementGroupFor("Ralph Lauren Dress Shirt")).toBe("top");
    expect(measurementGroupFor("Reformation Shirt Dress")).toBe("dress");
    // A mini skirt is a skirt. Nobody had listed this one, and the old
    // dress-before-bottom ordering got it wrong.
    expect(measurementGroupFor("Vintage Mini Skirt Size 4")).toBe("bottom");
  });

  it("keeps the exception cases the ordering hacks used to carry", () => {
    // US-2225: the noun that matters is the last one, which is why bags used
    // to be tested first.
    expect(measurementGroupFor("boot bag")).toBe("bag");
    expect(measurementGroupFor("cargo bag")).toBe("bag");
    // US-2464: a standalone suit jacket is outerwear; suit pants are a bottom;
    // a swimsuit and a jumpsuit are not two-piece sets.
    expect(measurementGroupFor("suit jacket")).toBe("outerwear");
    expect(measurementGroupFor("suit pants")).toBe("bottom");
    expect(measurementGroupFor("two piece suit")).toBe("suit");
    expect(measurementGroupFor("tracksuit")).toBe("suit");
    expect(measurementGroupFor("swimsuit")).toBe("dress");
    expect(measurementGroupFor("jumpsuit")).toBe("dress");
    // Compounds have to be spelled out now, so they are covered here.
    expect(measurementGroupFor("shirtdress")).toBe("dress");
    expect(measurementGroupFor("sundress")).toBe("dress");
    expect(measurementGroupFor("pantsuit")).toBe("suit");
    expect(measurementGroupFor("bathrobe")).toBe("outerwear");
    expect(measurementGroupFor("t-shirt")).toBe("top");
    expect(measurementGroupFor("button-down")).toBe("top");
  });

  it("resolves plurals, because resale lists everything plural", () => {
    for (const [text, group] of [
      ["jeans", "bottom"],
      ["shorts", "bottom"],
      ["leggings", "bottom"],
      ["overalls", "suit"],
      ["watches", "watch"],
      ["scarves", "accessory"],
      ["dresses", "dress"],
      ["sneakers", "shoes"],
    ] as const) {
      expect(measurementGroupFor(text), text).toBe(group);
    }
  });
});

// US-2673: switching the eBay category switches the measurements.
//
// "Women's Pants" and "Men's Sweaters" are both `clothing`, so the coarse
// cascade compares clothing to clothing, finds no family change and leaves
// garment_type exactly where it was. The eBay leaf is the only field that
// actually moved, and it is also the most deliberate garment statement on the
// item — somebody picked it and eBay validated it.
describe("US-2673: the eBay leaf leads the measurement template", () => {
  it("reads the leaf off a breadcrumb", () => {
    expect(
      ebayCategoryLeaf("Clothing, Shoes & Accessories › Men › Men's Clothing › Sweaters"),
    ).toBe("Sweaters");
    expect(ebayCategoryLeaf("A > B > C")).toBe("C");
    expect(ebayCategoryLeaf("Jeans")).toBe("Jeans");
    expect(ebayCategoryLeaf(null)).toBe(null);
    expect(ebayCategoryLeaf("")).toBe(null);
  });

  it("a category switch moves the template even when nothing else changes", () => {
    // Same row throughout: the AI's guess still says tops, the title still says
    // jeans. Only the category moves.
    const row = {
      garment_category: "other",
      garment_type: "tops",
      category: "clothing",
      title: "Polo Ralph Lauren Women's Skinny Jeans Size 27",
    };
    const groupFor = (path: string | null) =>
      measurementGroupFor(
        garmentDescriptorFor({ ...row, ebay_leaf: ebayCategoryLeaf(path) }),
      );
    expect(groupFor("Clothing, Shoes & Accessories › Women › Women's Clothing › Jeans"))
      .toBe("bottom");
    expect(groupFor("Clothing, Shoes & Accessories › Men › Men's Clothing › Sweaters"))
      .toBe("top");
    expect(groupFor("Clothing, Shoes & Accessories › Men › Men's Clothing › Coats, Jackets & Vests"))
      .toBe("outerwear");
    expect(groupFor("Clothing, Shoes & Accessories › Women › Women's Shoes › Athletic Shoes"))
      .toBe("shoes");
  });

  it("a leaf NAMED like a vertical still leads", () => {
    // Reported on a live draft: an item categorised
    // "… › Women's Clothing › Tops" was asking for Waist, Inseam and Front Rise.
    //
    // eBay's own tree has leaves called literally "Tops", "Dresses" and
    // "Accessories". Those are real garment statements — a person picked one and
    // eBay validated it — and they are NOT the derived `garment_type` values
    // COARSE_VERTICALS exists to demote.
    //
    // isCoarse() tested the VALUE and not the FIELD it came from, so the leaf
    // was skipped in the first pass and a stale `garment_category: "pants"` won.
    // Every eBay category whose leaf collides with that six-word list was
    // affected; the existing cases here (Jeans, Sweaters, Athletic Shoes) all
    // happen to miss it.
    const row = {
      garment_category: "pants",
      garment_type: "bottoms",
      category: "clothing",
      title: "Womens Blouse",
    };
    const groupFor = (path: string) =>
      measurementGroupFor(
        garmentDescriptorFor({ ...row, ebay_leaf: ebayCategoryLeaf(path) }),
      );
    expect(
      groupFor("Clothing, Shoes & Accessories › Women › Women's Clothing › Tops"),
    ).toBe("top");
    expect(
      groupFor("Clothing, Shoes & Accessories › Women › Women's Clothing › Dresses"),
    ).toBe("dress");
  });

  it("the coarse demotion still applies to the column it was written for", () => {
    // The other half. `garment_type` is filled by deriveGarmentType() from
    // item_category, so on an unclassified item it reads "tops" whether the
    // garment is a t-shirt or a pair of jeans — it must still lose to a real
    // garment noun anywhere else on the row.
    expect(
      measurementGroupFor(
        garmentDescriptorFor({
          garment_type: "tops",
          title: "Polo Ralph Lauren Women's Skinny Jeans Size 27",
        }),
      ),
    ).toBe("bottom");
    // And with nothing else to go on it still resolves rather than falling to
    // generic.
    expect(
      measurementGroupFor(garmentDescriptorFor({ garment_type: "bottoms" })),
    ).toBe("bottom");
  });

  it("a descriptor the caller already resolved is not demoted again", () => {
    // The second site of the same bug. The composer resolves the descriptor
    // (leaf first) and hands the winner to templateGroupFor, which used to pass
    // it back in as `garment_category` — through the coarse demotion a second
    // time. With the leaf "Tops" and a title the seller had not corrected,
    // templateGroupFor returned `bottom`.
    const row = {
      category: "clothing",
      item_title: "Vintage Wrangler Pants 32x34",
    } as never;
    expect(templateGroupFor(row, "Tops")).toBe("top");
    expect(templateGroupFor(row, "Dresses")).toBe("dress");
    // A garment that resolves to nothing is not an answer: fall through to the
    // row, which is the case this signature exists for (US-2595).
    expect(templateGroupFor(row, "clothing")).toBe("bottom");
    expect(templateGroupFor(row, null)).toBe("bottom");
  });

  it("the LEAF only, never the whole path", () => {
    // The path starts "Clothing, Shoes & Accessories". A leaf that names no
    // garment must fall through to the other columns rather than walking back
    // up and matching `shoes` in the marketplace root.
    const row = { garment_type: "tops", title: "Lululemon Align Leggings 25in" };
    const path =
      "Clothing, Shoes & Accessories › Women › Women's Clothing › Activewear › Athletic Apparel";
    expect(
      measurementGroupFor(
        garmentDescriptorFor({ ...row, ebay_leaf: ebayCategoryLeaf(path) }),
      ),
    ).toBe("bottom");
  });

  it("the composer feeds the resolved breadcrumb in, not just a fresh pick", () => {
    // A reopened draft only ever has the category id, so the picker resolves
    // the breadcrumb and reports it separately from onCategoryChange — which
    // means "the seller changed it" and makes a save cascade the coarse
    // category. Firing that one on load would cascade on load.
    const composer = readFileSync("src/pages/flipdesk/composer.tsx", "utf8");
    expect(composer).toContain("ebay_leaf: ebayCategoryLeaf(resolvedCategoryPath)");
    expect(composer).toContain("onResolvedCategoryPath={setResolvedCategoryPath}");
    const picker = readFileSync(
      "src/components/flipdesk/ebay-category-picker.tsx",
      "utf8",
    );
    expect(picker).toContain("onResolvedCategoryPath?: (categoryPath: string | null) => void;");
    expect(picker).toContain("reportResolved.current?.(displayCategoryPath);");
  });
});
