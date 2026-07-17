// US-1986: verify the fast-fashion & mall tier-2 content (migration 00466) is
// correct + consumable by the engine.
//
// ALL TEN BRANDS WERE PASSTHROUGH-ONLY before this pack — not even the bare
// alias-only shells 00389 left for the activewear group — so a "brandy melville"
// tag rendered the seller's own casing into the prompt block and the eBay Brand
// aspect on some of the highest-VOLUME garments in resale. What the assertions
// below protect is the four things this group has that no prior pack did:
//
//   1. THE SAME NUMBER IS TWO DIFFERENT SIZE SYSTEMS. 00458's pack was about the
//      SPREAD (a Uniqlo M vs an Old Navy M — same letters, different bodies).
//      This is one level up and far more expensive: a Zara/H&M "38" is an EU size
//      (≈27.5in waist) and an Express/Lucky "38" is a WAIST IN INCHES. Same two
//      digits, ~10in apart, and ONLY the brand says which.
//   2. AND THE CONVERSION ITSELF IS DISPUTED — by a full size. Sources map EU 38
//      to US 6 (via the UK grade) or US 8 (via EU = US+30). The pack seeds the
//      disagreement as a RANGE instead of picking a side and inventing precision.
//   3. MOST OF THIS GROUP ARE RETAILERS, NOT MAKERS. PacSun's own 10-K puts
//      ~70% of sales in third-party brands, and UO/PacSun house labels never
//      print the store's name. So the store is not the brand — seeded as a
//      first-class row (the 00457 Anthropologie precedent).
//   4. TWO BRANDS ARE ORDINARY WORDS THIS PRODUCT'S OWN TEXT EMITS — "express
//      shipping" and the "loft" of a down jacket, the latter emitted by the KB's
//      OWN outdoor packs. Asserted empirically, not argued.
//
// THE PACK SEEDS **ZERO** DECODERS AND ZERO COLORWAYS, and both are deliberate —
// see the REFUSAL fixtures in brand-knowledge-golden_test.ts and the migration
// header. No block here should invite a code transcription.
//
// brand-knowledge.ts + sizing-charts.ts import supabase at load → dummy env first.
import { assert, assertEquals } from "@std/assert";

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { brandPackPromptBlock } = await import("../lib/brand-knowledge.ts");
const { findSizingCharts, SIZING_CHARTS } = await import(
  "../lib/sizing-charts.ts"
);
const { canonicalizeBrand, isKnownBrand, detectBrandInText } = await import(
  "../lib/brand-normalize.ts"
);
import type {
  BrandKnowledgePack,
  BrandStyleKnowledge,
} from "../lib/brand-knowledge.ts";

const GROUP = [
  "Zara",
  "H&M",
  "Urban Outfitters",
  "Express",
  "LOFT",
  "Ann Taylor",
  "Talbots",
  "Lucky Brand",
  "Brandy Melville",
  "PacSun",
];

/** The two whose canonical is an ordinary word that listing copy emits. */
const ORDINARY_WORD_BRANDS = ["Express", "LOFT"];

function style(
  styleName: string,
  productLine: string,
  visualFingerprint: string,
  fabricTech: string[] = [],
): BrandStyleKnowledge {
  return {
    styleName,
    aliases: [],
    productLine,
    department: "Women",
    category: "top",
    visualFingerprint,
    fabricTech,
    era: null,
    msrpBand: null,
    keywords: [],
  };
}

function pack(
  brand: string,
  key: string,
  styles: BrandStyleKnowledge[],
  decoders: BrandKnowledgePack["decoders"] = [],
): BrandKnowledgePack {
  return {
    brand,
    key,
    known: true,
    aliases: [],
    categoryFocus: ["fast fashion"],
    authenticationTells: [],
    tagEras: [],
    styles,
    decoders,
    colorways: [],
    sizingCharts: [],
    source: "db",
  };
}

Deno.test("US-1986: Express and LOFT are never minted out of prose", () => {
  // THE trap this group has to defend against, and it is DENSER than any prior
  // pack's: two of ten brands are ordinary words, and both are words that appear
  // in the exact copy detectBrandInText is pointed at (the barcode/UPC title
  // intake, US-598). Longest-first ordering is what makes each ACTIVELY HARMFUL
  // rather than merely noisy — the ordinary word BEATS the real brand beside it.
  //
  // These assertions are empirical: removing either entry from
  // DETECT_EXCLUDED_FROM_TEXT turns them red.

  // "Express" (7 chars) would beat the real "Nike" (4) in the same string.
  assertEquals(
    detectBrandInText("Nike tee, free express shipping, size M"),
    "Nike",
    "the real brand wins; 'express shipping' must not mint Express",
  );
  assertEquals(
    detectBrandInText("Ships express, brand new with tags"),
    null,
    "an ordinary-word brand is never guessed from prose",
  );

  // "LOFT" (4) would beat a real "Gap" (3). And the match is case-INSENSITIVE, so
  // the all-caps canonical is no defence on its own. This is the nastier of the
  // two because the KB's OWN outdoor/luxury-outerwear packs (00453, 00460) emit
  // "loft" constantly — it is the standard word for a down garment's fill.
  assertEquals(
    detectBrandInText("Gap puffer jacket, 800 fill power loft, mens"),
    "Gap",
    "the real brand wins; a down jacket's 'loft' must not mint LOFT",
  );
  assertEquals(
    detectBrandInText("Down vest, the loft has flattened with wear"),
    null,
    "a condition description of loft never mints a brand",
  );

  // But BOTH stay fully reachable by TAG — which is what the eBay Brand aspect
  // and the comp filter actually read. Excluding them from prose must not cost
  // the tag path.
  for (const brand of ORDINARY_WORD_BRANDS) {
    assertEquals(canonicalizeBrand(brand.toLowerCase()), brand);
    assert(isKnownBrand(brand), `${brand} is a curated entry`);
  }

  // The exclusion is narrow: the pack's unambiguous brands are still detected.
  assertEquals(detectBrandInText("Zara Woman blazer size EU 38"), "Zara");
  assertEquals(detectBrandInText("Talbots petite wool coat 8P"), "Talbots");
  assertEquals(
    detectBrandInText("Brandy Melville one size cropped tee"),
    "Brandy Melville",
  );

  // The prior groups' exclusions must still hold (the set is shared).
  assertEquals(
    detectBrandInText("Vintage blouse with mother of pearl buttons"),
    null,
    "00464's MOTHER exclusion still holds",
  );
  assertEquals(
    detectBrandInText("Nike shoes, great grip on running trails"),
    "Nike",
    "00465's On Running exclusion still holds",
  );
});

Deno.test("US-1986: the fast-fashion aliases canonicalize", () => {
  // Every brand in the group resolves, and — the actual work here — so do the
  // HOUSE LABELS, which are the only string on the tag. A seller reading a BDG
  // jean's tag types "BDG" and, before this pack, got "BDG" straight through into
  // the eBay Brand aspect.
  for (const brand of GROUP) {
    assert(isKnownBrand(brand), `${brand} canonicalizes`);
    assertEquals(canonicalizeBrand(brand), brand, `${brand} is its own canonical`);
  }

  // House labels fold onto the store whose garment they are.
  assertEquals(canonicalizeBrand("BDG"), "Urban Outfitters");
  assertEquals(canonicalizeBrand("Out From Under"), "Urban Outfitters");
  assertEquals(canonicalizeBrand("kimchi blue"), "Urban Outfitters");
  assertEquals(canonicalizeBrand("Bullhead"), "PacSun");
  assertEquals(canonicalizeBrand("Bullhead Denim Co"), "PacSun");
  assertEquals(canonicalizeBrand("LA Hearts"), "PacSun");
  assertEquals(canonicalizeBrand("Divided"), "H&M");
  assertEquals(canonicalizeBrand("L.O.G.G."), "H&M");
  assertEquals(canonicalizeBrand("Zara TRF"), "Zara");
  assertEquals(canonicalizeBrand("Trafaluc"), "Zara");

  // brandKey() STRIPS the ampersand, so "H&M" keys as "hm" — and a seller who
  // types "H and M" produces a DIFFERENT key that needs its own entry. Both must
  // land on the one canonical (the Rag & Bone rule).
  assertEquals(canonicalizeBrand("H&M"), "H&M");
  assertEquals(canonicalizeBrand("hm"), "H&M");
  assertEquals(canonicalizeBrand("H and M"), "H&M");
  assertEquals(canonicalizeBrand("Hennes & Mauritz"), "H&M");

  // An "Ann Taylor LOFT" tag is a LOFT garment, so it resolves to LOFT — NOT to
  // the parent whose name it literally carries.
  assertEquals(canonicalizeBrand("Ann Taylor LOFT"), "LOFT");
  assertEquals(canonicalizeBrand("Ann Taylor"), "Ann Taylor");

  // The long-canonical play: "Lucky" is an ordinary adjective, so the canonical
  // is the long form and the short one survives as an exact-key alias only.
  assertEquals(canonicalizeBrand("lucky"), "Lucky Brand");
  assertEquals(canonicalizeBrand("Lucky Brand Jeans"), "Lucky Brand");

  // ⚠ THE FOLDS THAT MUST **NOT** HAPPEN. Each of these looks exactly like the
  // folds above and is a different fact — the parent COMPANY never decides a fold.
  for (
    const [input, why] of [
      ["COS", "an H&M Group brand priced ABOVE H&M — not an H&M line"],
      ["Arket", "an H&M Group brand at its own tier"],
      ["Monki", "an H&M Group brand at its own tier"],
      ["Weekday", "an H&M Group brand at its own tier"],
      ["Zara Home", "a SEPARATE homewares chain, not a Zara clothing line"],
      ["Inditex", "Zara's PARENT — it also owns Bershka, Pull&Bear, Massimo Dutti"],
      ["Anthropologie", "a URBN SIBLING with its own pack (00457)"],
      ["Free People", "a URBN SIBLING with its own pack (00449)"],
      ["Modern Amusement", "LICENSED by PacSun from a third party, not a house label"],
    ] as Array<[string, string]>
  ) {
    assert(
      canonicalizeBrand(input) !== "H&M" &&
        canonicalizeBrand(input) !== "Zara" &&
        canonicalizeBrand(input) !== "Urban Outfitters" &&
        canonicalizeBrand(input) !== "PacSun",
      `${input} must not fold — ${why}`,
    );
  }

  // Anthropologie and Free People must still reach their OWN canonicals — the
  // point is that they are separate, not that they are unknown.
  assertEquals(canonicalizeBrand("Anthropologie"), "Anthropologie");
  assertEquals(canonicalizeBrand("Free People"), "Free People");
});

Deno.test("US-1986: the same NUMBER is two size systems — the pack's signature problem", () => {
  // The most expensive error available in this group, and unlike 00465's dual
  // system (where category_match separates a shoe chart from a garment chart)
  // NOTHING in the item separates these — only the brand does. Verified against
  // the shipped table rather than asserted in a comment.
  const zara = findSizingCharts("Zara", "jeans");
  assert(zara.length > 0, "Zara resolves a bottoms chart");
  const zaraNote = zara.map((c) => c.note ?? "").join(" ");
  assert(
    /EU SIZE, NOT A WAIST IN INCHES/i.test(zaraNote),
    "the Zara chart states its system in the note",
  );
  assert(
    zara.some((c) => /EU/i.test(c.garment)),
    "the Zara chart states its system in the garment string too",
  );
  // The size LABEL itself carries the cross-map, where the model actually reads
  // it (the US-1739 convention).
  assert(
    zara.some((c) => c.rows.some((r) => /EU 38/.test(r.size) && /US/.test(r.size))),
    "the EU 38 row names its US equivalent inline",
  );

  // And the American brands in the SAME pack are inches — that contrast is the
  // whole fact, so the Express chart must say so explicitly.
  const express = findSizingCharts("Express", "pants");
  assert(express.length > 0, "Express resolves a bottoms chart");
  assert(
    /US numeric/i.test(express.map((c) => c.garment).join(" ")),
    "the Express chart states that its numbers are US sizes",
  );

  // A Zara 38 and an Express 38 must not describe the same body. This is the
  // assertion that would catch someone "helpfully" harmonising the two tables.
  const zara38 = zara
    .flatMap((c) => c.rows)
    .find((r) => /EU 38/.test(r.size))?.measurements.waist;
  assert(zara38 !== undefined, "the Zara EU 38 row carries a waist");
  assert(
    parseFloat(zara38!) < 30,
    `an EU 38 is a ~27.5in waist, not 38in — got ${zara38}`,
  );
});

Deno.test("US-1986: the EU->US conversion is seeded as a RANGE, not a false point", () => {
  // The research finding that survived contact with the sources: they disagree by
  // a FULL SIZE (EU 38 = US 6 via the UK grade, or US 8 via EU = US+30), and
  // neither brand's own chart is machine-reachable. Stating "EU 38 = US 6" would
  // be a precision the evidence does not support, so every EU label carries a
  // range and the note says the EU number is the certain part.
  for (const brand of ["Zara", "H&M"]) {
    const charts = findSizingCharts(brand, "jeans");
    assert(charts.length > 0, `${brand} resolves a chart`);
    const rows = charts.flatMap((c) => c.rows);
    const eu38 = rows.find((r) => /EU 38/.test(r.size));
    assert(eu38, `${brand} has an EU 38 row`);
    assert(
      /US 6-8/.test(eu38!.size),
      `${brand}'s EU 38 must state the disputed US range, got "${eu38!.size}"`,
    );
    assert(
      /disputed|DISPUTED/.test(charts.map((c) => c.note ?? "").join(" ")),
      `${brand}'s note must disclose that the conversion is disputed`,
    );
  }
});

Deno.test("US-1986: the H&M chart admits its numbers are not H&M's", () => {
  // The honest-confidence case. No trustworthy published H&M inch chart could be
  // sourced at all, so the chart carries the SYSTEM (sourced) and says out loud
  // that the inches are the standard EU grade's approximation rather than passing
  // them off as the brand's own. An unsourced number presented as sourced is the
  // failure mode this whole pack is written against.
  const charts = findSizingCharts("H&M", "jeans");
  const note = charts.map((c) => c.note ?? "").join(" ");
  assert(
    /NOT H&M'S OWN PUBLISHED NUMBERS/i.test(note),
    "the H&M chart discloses that its measurements are not brand-published",
  );
  assert(/LOW confidence/i.test(note), "and that its confidence is low");

  // Divided is an H&M line and must reach the same grade — the line does not
  // change the size system.
  const divided = findSizingCharts(canonicalizeBrand("Divided"), "jeans");
  assert(
    divided.some((c) => c.brand === "H&M"),
    "an H&M line resolves H&M's chart",
  );
});

Deno.test("US-1986: Brandy Melville's 'One Size' is stated to mean SMALL", () => {
  // The group's designed-vs-damage equivalent: a fact that reads as the opposite
  // of what it says. "One Size" sounds universal/generous and means US 00-4 — a
  // model that reads it the natural way mis-sets buyer expectation on every
  // listing. There is exactly ONE row, which is the point: the brand has no grade.
  const charts = findSizingCharts("Brandy Melville", "top");
  assert(charts.length > 0, "Brandy Melville resolves a chart");
  const bm = charts.find((c) => c.brand === "Brandy Melville")!;
  assertEquals(bm.rows.length, 1, "the brand has ONE size, so the chart has one row");
  assert(
    /MEANS SMALL, NOT UNIVERSAL/i.test(bm.note ?? ""),
    "the note says One Size means small",
  );
  assert(/US 00-4/.test(bm.note ?? ""), "and quantifies it");

  // THE REFUSAL, WHICH IS THE REAL DELIVERABLE: every "Brandy size chart" on the
  // open web is SEO fabrication, and that is exactly what a model recalls. The
  // note must send the reader to the garment instead of to a remembered table.
  assert(
    /PUBLISHES NO SIZE CHART/i.test(bm.note ?? ""),
    "the note states no official chart exists",
  );
  assert(
    /MEASURE THE GARMENT/i.test(bm.note ?? ""),
    "and redirects to the garment's own measurements",
  );

  // The flat-lay trap: Brandy's own product pages list a ~15in "bust", which is a
  // PIT-TO-PIT half measurement. Ingesting it as a circumference halves the
  // garment.
  assert(
    /PIT-TO-PIT/i.test(bm.note ?? ""),
    "the note warns that Brandy's own 'bust' figure is a half measurement",
  );
});

Deno.test("US-1986: the retailer trap is a first-class row, not a footnote", () => {
  // The pack's structural fact: most of this group are RETAILERS. PacSun's own
  // 10-K puts ~70% of sales in third-party brands, so "from PacSun" is not a
  // brand claim at all. Seeded as a style row (the 00457 Anthropologie
  // precedent) because brandPackPromptBlock renders fingerprints VERBATIM — the
  // only place a fact this important is guaranteed to reach the extract prompt.
  const block = brandPackPromptBlock(
    pack("PacSun", "pacsun", [
      style(
        "Third-Party Brand at PacSun",
        "Retailer",
        "NOT a garment and NOT a line — THE RETAILER TRAP. PacSun is primarily a MULTI-BRAND RETAILER: by its own 10-K, roughly 70% of its sales are OTHER companies' brands (Vans, Nike, Billabong, Quiksilver...). A garment bought at PacSun is only a PacSun garment if it carries a HOUSE label (Bullhead, Kirra, LA Hearts, Nollie, On the Byas, Black Poppy). If the tag names some other brand, THAT is the brand — the store is not.",
      ),
    ]),
  );
  assert(/RETAILER TRAP/.test(block), "the trap reaches the prompt block verbatim");
  assert(
    /the store is not/i.test(block),
    "the block states that the store is not the brand",
  );
  assert(/Bullhead/.test(block), "and names the house labels that ARE PacSun");
});

Deno.test("US-1986: no block invites a code transcription (the pack has no decoders)", () => {
  // brandPackPromptBlock emits the "transcribe it VERBATIM into style_code" hint
  // ONLY when the pack carries decoders. This group seeds ZERO — every candidate
  // code was refused (see the REFUSAL fixtures in brand-knowledge-golden_test.ts)
  // — so no block here may ask for one. Inviting a transcription for a code
  // nothing can decode spends prompt budget and model attention for nothing.
  for (const brand of GROUP) {
    const block = brandPackPromptBlock(
      pack(brand, brand.toLowerCase().replace(/[^a-z0-9]/g, ""), [
        style("Some Style", "Line", "a fingerprint"),
      ]),
    );
    assert(
      !/transcribe it VERBATIM/i.test(block),
      `${brand}'s block must not invite a code transcription`,
    );
  }
});

Deno.test("US-1986: the KnitWell three stay three brands under one parent", () => {
  // The pack's counter-example to itself. Ann Taylor, LOFT and Talbots share ONE
  // owner (KnitWell Group) and still must not merge: different price bands,
  // separate eBay brand nodes, separate buyers. The parent COMPANY never decides
  // a fold — 00458's Hollister rule, and this is its clearest instance since all
  // three sit under one roof.
  assertEquals(canonicalizeBrand("Ann Taylor"), "Ann Taylor");
  assertEquals(canonicalizeBrand("LOFT"), "LOFT");
  assertEquals(canonicalizeBrand("Talbots"), "Talbots");

  // And the outlet TIERS do fold, because eBay has no separate catalogue brand
  // for them — the Gap Factory play. The tier is disclosed via brand_styles.
  assertEquals(canonicalizeBrand("Ann Taylor Factory"), "Ann Taylor");
  assertEquals(canonicalizeBrand("LOFT Outlet"), "LOFT");

  // The sizing consequence, verified against the shipped table: Ann Taylor and
  // LOFT publish the SAME grade, so the shared chart must be reachable from BOTH
  // brands. A future edit that splits them into two tables would drift.
  for (const brand of ["Ann Taylor", "LOFT"]) {
    const charts = findSizingCharts(brand, "blouse");
    assert(
      charts.some((c) => c.brand === "Ann Taylor"),
      `${brand} reaches the shared Ann Taylor / LOFT tops grade`,
    );
  }
  const shared = findSizingCharts("Ann Taylor", "blouse").find(
    (c) => c.brand === "Ann Taylor",
  )!;
  assert(
    /SAME BODY CHART/i.test(shared.note ?? ""),
    "the shared chart says the two grades are the same",
  );
  // But the price bands are NOT the same, and the note must not let that slide.
  assert(/cheaper/i.test(shared.note ?? ""), "and that the bands still differ");
});

Deno.test("US-1986: LOFT's denim is inches while its pants are US sizes", () => {
  // One brand, two systems — the 00465 dual-system shape reappearing inside a
  // single apparel brand. Only the GARMENT says which, and category_match is the
  // only thing separating them.
  const denim = findSizingCharts("LOFT", "jeans");
  assert(
    denim.some((c) => c.brand === "LOFT" && /INCHES/i.test(c.garment)),
    "LOFT + jeans resolves the inch-denim chart",
  );
  const pants = findSizingCharts("LOFT", "pants");
  assert(
    pants.some((c) => /US numeric/i.test(c.garment)),
    "LOFT + pants resolves the US-numeric grade, NOT the inch-denim chart",
  );
  // Ann Taylor must NOT reach the inch-denim chart — it has no such column.
  assert(
    !findSizingCharts("Ann Taylor", "jeans").some(
      (c) => c.brand === "LOFT",
    ),
    "Ann Taylor must not inherit LOFT's inch-denim chart",
  );
});

Deno.test("US-1986: Talbots' published ranges are the corrected ones", () => {
  // Seeded because the WRONG ranges are what a model recalls: the widely-repeated
  // "misses 2-20 / petite starts at 2P / plus 14W-24W" is wrong on all three
  // counts per Talbots' own live charts. This test is the guard against someone
  // "correcting" the chart back to the folklore.
  const charts = findSizingCharts("Talbots", "blouse");
  const t = charts.find((c) => c.brand === "Talbots")!;
  const sizes = t.rows.map((r) => r.size).join(" ");
  const note = t.note ?? "";

  assert(/0P/.test(sizes), "petite starts at 0P, not 2P");
  assert(/18 \(misses\)/.test(sizes), "misses tops out at 18, not 20");
  assert(/26W/.test(sizes), "plus tops out at 26W, not 24W");
  assert(!/20 \(misses\)/.test(sizes), "there is no misses 20");
  assert(/2-18/.test(note) && /0P-16P/.test(note) && /14W-26W/.test(note),
    "the note states all three corrected ranges");

  // The vanity-sizing claim is deliberately NOT made — the evidence compares
  // published CHARTS, not garments, and an older target customer may simply be
  // fitted accurately. The note must say the larger-than-youth-brands fact
  // WITHOUT the unsupported intent.
  assert(
    /do NOT call this vanity sizing/i.test(note),
    "the note declines the vanity-sizing framing",
  );
});

Deno.test("US-1986: Lucky Brand is the inches foil to Zara's EU number", () => {
  // The pack's headline contrast, asserted against the shipped table: the SAME
  // two digits on two tags in the same pack, ~10 inches apart.
  const lucky = findSizingCharts("Lucky Brand", "jeans");
  const w38 = lucky
    .flatMap((c) => c.rows)
    .find((r) => r.size === "W38")?.measurements.waist;
  assertEquals(w38, "38", "a Lucky 38 IS a 38in waist");

  const zara38 = findSizingCharts("Zara", "jeans")
    .flatMap((c) => c.rows)
    .find((r) => /EU 38/.test(r.size))?.measurements.waist;
  assert(zara38 && parseFloat(zara38) < 30, "a Zara 38 is a ~27.5in waist");

  assert(
    lucky.some((c) => /FOIL TO ZARA/i.test(c.note ?? "")),
    "the Lucky chart names the contrast explicitly",
  );

  // Women's jeans are inches too — the premise that they use a dress size is
  // wrong and the chart must say so.
  const womens = findSizingCharts("Lucky Brand", "denim").find(
    (c) => c.department === "Women",
  );
  assert(
    womens && /NOT by a dress size/i.test(womens.note ?? ""),
    "the women's chart states that the label is inches, not a dress size",
  );
});

Deno.test("US-1986: the 'Lucky You' fly is seeded WITHOUT its uncited myth", () => {
  // The subtlest content call in the pack. The fly message is REAL and
  // primary-sourced (Lucky's own company history: a "message in the fly" reading
  // "Lucky You"). The FAMILIAR version — "two four-leaf clovers stitched on the
  // outside of the fly shield" on ALL Lucky jeans — traces to an UNCITED
  // Wikipedia line that the web laundered into confident prose. That sentence is
  // exactly what a model will recall, so the row must state the sourced half and
  // explicitly refuse the rest.
  const block = brandPackPromptBlock(
    pack("Lucky Brand", "luckybrand", [
      style(
        'The "Lucky You" fly message',
        "Brand detail",
        'SOURCED: co-founder Gene Montesano wanted "a message in the fly" and chose "Lucky You" as a double entendre, c.1990. ⚠ NOT SOURCED and repeated everywhere as fact: that it is "two four-leaf clovers with LUCKY YOU stitched onto the outside of the fly shield" on ALL Lucky jeans — that traces to an UNCITED Wikipedia line. The clover count, the stitching, the placement and the word "all" are unverified. "LUCKY ME" is folklore. It is NOT button-fly-only. USE IT AS SUPPORTING EVIDENCE, NEVER AS A TEST.',
      ),
    ]),
  );
  assert(/Lucky You/.test(block), "the sourced phrase reaches the prompt");
  assert(
    /NEVER AS A TEST/i.test(block),
    "the block refuses to let the detail authenticate a garment",
  );
  assert(
    /NOT SOURCED/i.test(block) && /four-leaf clovers/.test(block),
    "the block names the specific unsourced claim rather than repeating it as fact",
  );
});

Deno.test("US-1986: the group's charts are reachable per brand + category", () => {
  const cases: Array<[string, string]> = [
    ["Zara", "jeans"],
    ["Zara", "blouse"],
    ["H&M", "jeans"],
    ["H&M", "dress"],
    ["Urban Outfitters", "jeans"],
    ["Urban Outfitters", "dress"],
    ["Express", "pants"],
    ["Express", "blouse"],
    ["PacSun", "jeans"],
    ["Brandy Melville", "top"],
    ["Ann Taylor", "blazer"],
    ["Ann Taylor", "pants"],
    ["Talbots", "dress"],
    ["Talbots", "pants"],
    ["Lucky Brand", "jeans"],
  ];
  for (const [brand, category] of cases) {
    const charts = findSizingCharts(canonicalizeBrand(brand), category);
    assert(
      charts.some((c) => c.brand === brand),
      `${brand} + ${category} resolves ${brand}'s own chart, not a generic one`,
    );
  }

  // LOFT is the exception worth spelling out: its TOPS come from the SHARED
  // Ann Taylor grade (labelled "Ann Taylor"), while its DENIM has a LOFT-only
  // chart. Both are correct — asserting `c.brand === "LOFT"` for a blouse would
  // be asserting a duplicate table we deliberately did not create.
  assert(
    findSizingCharts("LOFT", "blouse").some((c) => c.brand === "Ann Taylor"),
    "LOFT tops resolve the shared Ann Taylor / LOFT grade",
  );
  assert(
    findSizingCharts("LOFT", "jeans").some((c) => c.brand === "LOFT"),
    "LOFT denim resolves LOFT's own inch chart",
  );

  // Every brand in the group must reach SOME brand-specific chart rather than
  // silently falling through to the generic tables — the failure mode this whole
  // pack exists to prevent.
  const generic = new Set(
    SIZING_CHARTS.filter((c) => c.brandMatch.length === 0).map((c) => c.garment),
  );
  for (const brand of GROUP) {
    const charts = findSizingCharts(canonicalizeBrand(brand), null);
    assert(charts.length > 0, `${brand} resolves charts`);
    assert(
      !charts.every((c) => generic.has(c.garment)),
      `${brand} must not fall through to the generic charts`,
    );
  }
});

Deno.test("US-1986: a short/ordinary brandMatch token is never in the chart table", () => {
  // The US-1735 bug, guarded directly rather than trusted to a comment:
  // findSizingCharts matches brandMatch as a LEADING-word substring, so a bare
  // "lucky"/"brandy"/"urban"/"uo"/"trf" is the "ag"-hands-Patagonia-AG's-charts
  // hazard. All are alias KEYS only, where an exact whole-field lookup makes them
  // safe.
  //
  // NOTE "loft" and "express" are NOT banned here and must not be: they are the
  // brands' entire names, so they are the only tokens their charts can carry. The
  // hazard those two pose is in detectBrandInText over PROSE, which is a
  // different matcher and is handled by DETECT_EXCLUDED_FROM_TEXT — findSizingCharts
  // is only ever handed a brand field, never a sentence.
  const banned = new Set(["lucky", "brandy", "urban", "uo", "trf", "hm", "ann"]);
  for (const c of SIZING_CHARTS) {
    for (const m of c.brandMatch) {
      assert(
        !banned.has(m),
        `chart ${c.brand} must not carry the brandMatch token "${m}"`,
      );
    }
  }

  // The empirical half: brandKey strips the ampersand, so a bare "hm" token would
  // never have matched "h&m" anyway — the chart must carry the punctuated form or
  // H&M silently falls through to the generic charts.
  const hm = findSizingCharts("H&M", "jeans");
  assert(
    hm.some((c) => c.brand === "H&M"),
    "H&M resolves its own chart despite the ampersand",
  );
});
