// US-1737: verify the streetwear & hype content (migration 00456) is correct +
// consumable by the engine.
//
// What these assertions are really protecting:
//
//   * THE SEASON IS THE PRICE and the garment cannot show it. Everywhere else in
//     this epic the garment identifies itself; here the Box Logo Tee is the same
//     photograph across many drops at very different values. So "never guess the
//     drop" has to survive into the prompt.
//   * NO DECODERS AT ALL — the first group in the epic with none. A graphic is
//     not a code, and the season notation is not tag-printed. So NO brand here
//     may invite a code transcription.
//   * THE SIZING SPLIT RUNS IN OPPOSITE DIRECTIONS off the SAME alpha letter: a
//     BAPE L is ≈US M (Japanese, runs small), an Essentials L drapes ≈US XL
//     (deliberately oversized). Nothing on the tag announces which.
//   * Two sibling traps (AAPE is not BAPE, Essentials is not mainline Fear of
//     God) and two ordinary-word traps ("essentials", "fog").
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
const { findSizingCharts } = await import("../lib/sizing-charts.ts");
const { canonicalizeBrand, isKnownBrand, detectBrandInText } = await import(
  "../lib/brand-normalize.ts"
);
import type {
  BrandKnowledgePack,
  BrandStyleKnowledge,
} from "../lib/brand-knowledge.ts";

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
    department: "Men",
    category: "tee",
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
  authenticationTells: BrandKnowledgePack["authenticationTells"] = [],
): BrandKnowledgePack {
  return {
    brand,
    key,
    known: true,
    aliases: [],
    categoryFocus: ["streetwear"],
    authenticationTells,
    tagEras: [],
    styles,
    decoders,
    colorways: [],
    sizingCharts: [],
    source: "db",
  };
}

Deno.test("US-1737: the Supreme block says the SEASON is the price and cannot be guessed", () => {
  // Packs shaped as the US-1711 resolver returns for the 00456-seeded rows,
  // carrying the seeded fingerprints verbatim.
  const block = brandPackPromptBlock(
    pack("Supreme", "supreme", [
      style(
        "Box Logo Tee",
        "Box Logo",
        'THE Supreme icon: a red rectangle with "Supreme" in white Futura Heavy Oblique, printed on the CHEST of a boxy tee. vs the Box Logo Hoodie: same graphic, different garment. vs the Small Box Logo: this one is chest-width, the Small Box is a much smaller badge worn high on the left chest. CRITICAL — the graphic identifies the STYLE and says nothing about the SEASON, and the season is the price: this tee has been reissued across many seasons and colorways at very different values. Identify the style; do NOT guess the drop.',
      ),
    ]),
  );
  // The inversion that defines this group: identification is easy and nearly
  // worthless, because the expensive question is which drop — and the garment
  // does not answer it.
  assert(/the season is the price/.test(block), "the season-is-price fact reaches the block");
  assert(/do NOT guess the drop/i.test(block), "the block forbids guessing the drop");
  assert(
    /says nothing about the SEASON/.test(block),
    "the graphic is explicitly disqualified as a season signal",
  );
});

Deno.test("US-1737: the Supreme block separates the box logo family by SIZE and PLACEMENT", () => {
  const block = brandPackPromptBlock(
    pack("Supreme", "supreme", [
      style(
        "Box Logo Tee",
        "Box Logo",
        "A red rectangle with Supreme in white Futura Heavy Oblique across the CHEST of a boxy tee. vs the Small Box Logo: this one is chest-width, the Small Box is a much smaller badge worn high on the left chest.",
      ),
      style(
        "Small Box Logo Tee",
        "Small Box Logo",
        "A MUCH SMALLER box logo badge worn high on the left chest rather than across it. vs the Box Logo Tee: the separator is the graphic's SIZE and PLACEMENT, and the two are different styles at different values.",
      ),
    ]),
  );
  // Same graphic, two styles, two bands — the only thing a photo can use is how
  // big it is and where it sits.
  assert(/Small Box/.test(block), "the Small Box Logo is named");
  assert(
    /SIZE. and .PLACEMENT|SIZE' and 'PLACEMENT|SIZE. and PLACEMENT/.test(block) ||
      /size.*placement/i.test(block),
    "size + placement is the stated separator",
  );
});

Deno.test("US-1737: the BAPE block says AAPE is BAPE's own line, not a fake and not BAPE", () => {
  const block = brandPackPromptBlock(
    pack("BAPE", "bape", [
      style(
        "Shark Full Zip Hoodie",
        "Shark",
        "THE BAPE icon: a full-zip hood whose zipper runs THROUGH THE HOOD so the shark's mouth closes over the wearer's face. It is also the single most counterfeited garment in streetwear — the face proves the STYLE, never authenticity.",
      ),
      style(
        "Baby Milo",
        "Baby Milo",
        "NOT a garment — BAPE's own CHARACTER LINE (the soft cartoon ape). It is a line of this same brand, not a separate brand and not a collaboration, so it belongs in the style and never in `brand`.",
      ),
    ]),
  );
  // The Shark hoodie's face is the most-copied thing in streetwear, so the block
  // has to say plainly that recognizing it proves the style and nothing else.
  assert(/THROUGH THE HOOD/.test(block), "the shark zip's construction reaches the block");
  assert(
    /proves the STYLE, never authenticity/.test(block),
    "the icon is explicitly disqualified as an authenticity tell",
  );
  // Baby Milo is a LINE of BAPE; AAPE is a SIBLING of BAPE. Getting either wrong
  // moves the price by a lot, in opposite directions.
  assert(
    /not a separate brand and not a collaboration/.test(block),
    "Baby Milo is stated to be a line of this brand",
  );
});

Deno.test("US-1737: the Essentials block calls the OVERSIZED drape the design, not a defect", () => {
  const block = brandPackPromptBlock(
    pack("Fear of God Essentials", "fearofgodessentials", [
      style(
        "Essentials Pullover Hoodie",
        "Essentials",
        "The brand's volume piece: a DELIBERATELY OVERSIZED pullover hood — dropped shoulders, boxy body, long sleeve. The drape IS the design: an Essentials L hangs like a US XL. Do not grade that as stretching, wear or a mislabel.",
      ),
    ]),
  );
  // This is a GRADING fact, not just a listing one — the garment is supposed to
  // hang off the body, and every plausible misread of that (stretching, wear, a
  // mislabel) costs the seller a grade.
  assert(/DELIBERATELY OVERSIZED/.test(block), "the oversized cut is stated");
  assert(/The drape IS the design/.test(block), "the drape is claimed as intent");
  assert(
    /Do not grade that as stretching, wear or a mislabel/.test(block),
    "the block blocks all three misreads of the drape",
  );
});

Deno.test("US-1737: the Fear of God blocks keep mainline and Essentials apart", () => {
  const mainline = brandPackPromptBlock(
    pack("Fear of God", "fearofgod", [
      style(
        "Fear of God Mainline",
        "Mainline",
        "NOT a garment — the MAINLINE label, and the tier that mainline comps apply to. vs Fear of God ESSENTIALS: an ORDER OF MAGNITUDE apart in price, which is why they are seeded as two separate brands. Both labels print their own name — read the label, never the silhouette, and never comp one against the other.",
      ),
    ]),
  );
  // The pair is the whole reason this brand needs two rows: they look related,
  // they are related, and they are 10x apart.
  assert(/ORDER OF MAGNITUDE apart in price/.test(mainline), "the price gap is stated");
  assert(
    /never comp one against the other/.test(mainline),
    "the mis-comp is explicitly blocked",
  );
  assert(/read the label/.test(mainline), "the label is named as the separator");
});

Deno.test("US-1737: every brand in the group refuses to assert authenticity", () => {
  // The story's hard line, and it binds hardest here: these are among the most
  // counterfeited garments in the world and the fakes are specifically good at
  // the tells a photo can show.
  const brands: Array<[string, string]> = [
    ["Supreme", "supreme"],
    ["Stüssy", "stssy"],
    ["BAPE", "bape"],
    ["Kith", "kith"],
    ["Palace", "palace"],
    ["Fear of God", "fearofgod"],
    ["Fear of God Essentials", "fearofgodessentials"],
  ];
  for (const [brand, key] of brands) {
    const block = brandPackPromptBlock(
      pack(brand, key, [], [], [
        {
          tell: "NEVER auto-authenticate",
          detail:
            `NEVER label a ${brand} item authentic; flag inconsistencies in condition notes only.`,
        },
      ]),
    );
    assert(
      /NEVER assert authenticity/.test(block),
      `${brand} block carries the never-assert-authenticity instruction`,
    );
  }
});

Deno.test("US-1737: NO brand in this group invites a code transcription", () => {
  // The group's defining stance, asserted directly. 00456 seeds no decoders at
  // all — the first group in the epic with none — because streetwear identity is
  // a GRAPHIC (not on the tag, not parseable) and the season notation that
  // actually drives the price is not tag-printed either. If a future seed adds a
  // decoder over an ordinary token like "FW17", this fails.
  for (
    const [brand, key] of [
      ["Supreme", "supreme"],
      ["Stüssy", "stssy"],
      ["BAPE", "bape"],
      ["Kith", "kith"],
      ["Palace", "palace"],
      ["Fear of God", "fearofgod"],
      ["Fear of God Essentials", "fearofgodessentials"],
    ]
  ) {
    const block = brandPackPromptBlock(
      pack(brand, key, [style("X", "X", "a fingerprint")]),
    );
    assert(
      !/transcribe it VERBATIM/i.test(block),
      `${brand} must not invite a code transcription (it has no decodable code)`,
    );
  }
});

Deno.test("US-1737: the new streetwear aliases canonicalize (were passthrough-only before)", () => {
  // Without these, canonicalizeBrand PASSED THROUGH the seller's own casing
  // ("bape", "fear of god") into the prompt block and the eBay Brand aspect.
  assertEquals(canonicalizeBrand("bape"), "BAPE");
  assertEquals(canonicalizeBrand("A Bathing Ape"), "BAPE");
  assertEquals(canonicalizeBrand("kith"), "Kith");
  assertEquals(canonicalizeBrand("palace"), "Palace");
  assertEquals(canonicalizeBrand("Palace Skateboards"), "Palace");
  assertEquals(canonicalizeBrand("fear of god"), "Fear of God");
  assertEquals(canonicalizeBrand("Supreme New York"), "Supreme");
  assert(isKnownBrand("bape"), "BAPE is now a curated entry");
  assert(isKnownBrand("kith"), "Kith is now a curated entry");

  // Stüssy already canonicalized, and its KEY is 'stssy' — brandKey() strips the
  // umlaut with every other non-[a-z0-9] character. The KB row is seeded under
  // that key on purpose; a "corrected" key would simply never be found.
  assertEquals(canonicalizeBrand("stussy"), "Stüssy");
});

Deno.test("US-1737: Essentials is its OWN brand, never folded into Fear of God", () => {
  // The pair is an order of magnitude apart in price, so folding them (the MK
  // play, where every tier canonicalizes to one eBay brand) would comp a $90
  // hoodie against a $900 one. This follows the AGOLDE precedent instead.
  assertEquals(canonicalizeBrand("Fear of God Essentials"), "Fear of God Essentials");
  assertEquals(canonicalizeBrand("Essentials Fear of God"), "Fear of God Essentials");
  assertEquals(canonicalizeBrand("FOG Essentials"), "Fear of God Essentials");
  assert(
    canonicalizeBrand("Fear of God Essentials") !== canonicalizeBrand("Fear of God"),
    "the two lines never collapse onto one brand",
  );

  // detectBrandInText scans CANONICAL_BRANDS longest-first, which is exactly what
  // saves the pair here: "Fear of God Essentials" is tested BEFORE the "Fear of
  // God" it contains. Assert the outcome rather than trusting the sort order.
  assertEquals(
    detectBrandInText("Fear of God Essentials Pullover Hoodie Moss Large"),
    "Fear of God Essentials",
    "an Essentials title must not detect as mainline Fear of God",
  );
  assertEquals(
    detectBrandInText("Fear of God Seventh Collection Overcoat"),
    "Fear of God",
    "a mainline title still detects as mainline",
  );
});

Deno.test("US-1737: an ordinary word must never mint a brand in this group", () => {
  // Two traps, both handled the way 00453 refused a bare "bean" and 00455 refused
  // a bare "tory": the short/ordinary form is NOT a curated alias.

  // "essentials" is an ordinary retail word — adidas, Nike and H&M all ship an
  // "Essentials" line. This is the load-bearing one.
  assert(!isKnownBrand("essentials"), "a bare 'essentials' is not a curated entry");
  assertEquals(canonicalizeBrand("essentials"), "essentials");
  assertEquals(
    canonicalizeBrand("adidas Essentials"),
    "adidas Essentials",
    "another brand's Essentials line is not Fear of God",
  );

  // "fog" is an ordinary English word.
  assert(!isKnownBrand("fog"), "a bare 'fog' is not a curated entry");
  assertEquals(canonicalizeBrand("fog"), "fog");

  // AAPE ("AAPE BY *A BATHING APE*") is BAPE's own DIFFUSION sibling at a
  // fraction of the price — entirely authentic, and NOT BAPE. It must stay a
  // passthrough rather than fold in, exactly as Miu Miu stays off Prada and
  // AGOLDE stays off AG Jeans. Reading the four letters as a typo of BAPE
  // overprices it by a wide margin.
  assert(!isKnownBrand("aape"), "AAPE is not silently folded into BAPE");
  assertEquals(canonicalizeBrand("AAPE"), "AAPE");
  assertEquals(canonicalizeBrand("AAPE BY A BATHING APE"), "AAPE BY A BATHING APE");

  // A bare "ape" likewise.
  assert(!isKnownBrand("ape"), "a bare 'ape' is not a curated entry");
});

Deno.test("US-1737: the group's charts are reachable per brand", () => {
  const cases: Array<[string, string, string]> = [
    ["Supreme", "tee", "Men"],
    ["Supreme", "hoodie", "Men"],
    ["Supreme", "pant", "Men"],
    ["Stüssy", "tee", "Men"],
    ["Stüssy", "fleece", "Men"],
    ["BAPE", "hoodie", "Men"],
    ["BAPE", "tee", "Men"],
    ["Kith", "hoodie", "Men"],
    ["Palace", "tee", "Men"],
    ["Fear of God Essentials", "hoodie", "Unisex"],
    ["Fear of God Essentials", "sweatpant", "Unisex"],
  ];
  for (const [brand, category, department] of cases) {
    const found = findSizingCharts(brand, category);
    assert(
      found.some((c) => c.brand === brand && c.department === department),
      `${brand} ${department} chart reachable for "${category}"`,
    );
  }

  // Stüssy's canonical carries an UMLAUT and norm() only lowercases — it does not
  // strip accents — so the chart needs BOTH spellings in brandMatch. The raw
  // seller spelling has to reach the chart too.
  assert(
    findSizingCharts("stussy", "tee").some((c) => c.brand === "Stüssy"),
    "the un-umlauted seller spelling still resolves Stüssy's chart",
  );
});

Deno.test("US-1737: mainline Fear of God must not inherit the Essentials charts (or vice versa)", () => {
  // The subtle one, and the reason mainline is deliberately chartless.
  // findSizingCharts matches brandMatch by SUBSTRING, and "fear of god
  // essentials" CONTAINS "fear of god" — so a mainline chart with brandMatch
  // ["fear of god"] would ALSO fire on every Essentials garment, handing the
  // oversized line the wrong (and differently-shaped) numbers. Mainline is
  // unsourceable anyway, so it stays chartless and falls through to the generics,
  // exactly as Coach/LV/Gucci do. If someone later adds a mainline chart, this
  // test is what tells them why they can't.
  const essentials = findSizingCharts("Fear of God Essentials", "hoodie");
  assert(essentials.length > 0, "Essentials resolves a chart");
  assert(
    essentials.every((c) => c.brand === "Fear of God Essentials"),
    "Essentials resolves ONLY its own charts — no mainline chart may bleed in",
  );

  const mainlineCharts = findSizingCharts("Fear of God", "hoodie");
  assert(
    mainlineCharts.every((c) => c.brandMatch.length === 0),
    "mainline Fear of God falls through to the generic charts",
  );
});

Deno.test("US-1737: a short streetwear token must never bleed onto another brand", () => {
  // brandMatch is a SUBSTRING test, so a short entry false-fires inside other
  // brands' names. Check the group's own tokens land only on their own charts.
  for (const brand of ["Supreme", "BAPE", "Kith", "Palace", "Stüssy"]) {
    const charts = findSizingCharts(brand, "tee");
    assert(charts.length > 0, `${brand} resolves a chart`);
    assert(
      charts.every((c) => c.brand === brand),
      `${brand} resolves only its own charts`,
    );
  }

  // "essentials" is deliberately absent from every brandMatch, so another brand's
  // Essentials line cannot pick up Fear of God's oversized numbers.
  const adidas = findSizingCharts("adidas Essentials", "hoodie");
  assert(
    adidas.every((c) => c.brand !== "Fear of God Essentials"),
    "another brand's Essentials line does not inherit Fear of God's charts",
  );
});

Deno.test("US-1737: the same alpha letter means OPPOSITE things across this group", () => {
  // THE trap this group exists to defend against, asserted as a real data
  // conflict rather than a comment. Every tag in this pack says just "L", and
  // that L means a US M on BAPE and a US XL drape on Essentials — two sizes
  // apart, in opposite directions, with nothing on either tag to warn anyone.
  const bapeL = findSizingCharts("BAPE", "hoodie")
    .find((c) => c.brand === "BAPE")!
    .rows.find((r) => r.size.startsWith("JP L"));
  const essL = findSizingCharts("Fear of God Essentials", "hoodie")
    .find((c) => c.brand === "Fear of God Essentials")!
    .rows.find((r) => r.size.startsWith("L "));
  assert(bapeL && essL, "both brands grade an L");
  assert(bapeL!.size.includes("US M"), "a BAPE L is a US M");
  assert(essL!.size.includes("US XL"), "an Essentials L drapes like a US XL");
  // And the conflict is in the DATA, not only in the label text.
  assert(
    bapeL!.measurements.chest !== essL!.measurements.chest,
    "the two Ls carry different chest measurements",
  );

  // The cross-map has to survive into the RENDERED table, which means it must be
  // in the size LABEL — a note alone is not enough, because the label is what
  // sits beside the measurements the model is matching against.
  const bape = findSizingCharts("BAPE", "tee").find((c) => c.brand === "BAPE");
  assert(
    bape!.rows.every((r) => /≈US/.test(r.size)),
    "every BAPE size label carries its US equivalent",
  );
  const ess = findSizingCharts("Fear of God Essentials", "tee")
    .find((c) => c.brand === "Fear of God Essentials");
  assert(
    ess!.rows.every((r) => /drapes ≈US/.test(r.size)),
    "every Essentials size label carries its US drape equivalent",
  );
});

Deno.test("US-1737: the Japanese and oversized halves warn in OPPOSITE directions", () => {
  // Mirrors 00454's vintage-vs-premium and 00455's European-vs-American splits:
  // one blanket "streetwear runs X" rule would be wrong for half the pack.
  const bape = findSizingCharts("BAPE", "").filter((c) => c.brand === "BAPE");
  assert(bape.length > 0, "BAPE has charts");
  for (const c of bape) {
    assert(
      /JAPANESE sizing/.test(c.note ?? ""),
      `BAPE ${c.garment} names its national system`,
    );
    assert(/runs SMALL/.test(c.note ?? ""), `BAPE ${c.garment} says it runs small`);
  }

  const ess = findSizingCharts("Fear of God Essentials", "")
    .filter((c) => c.brand === "Fear of God Essentials");
  assert(ess.length > 0, "Essentials has charts");
  for (const c of ess) {
    assert(
      /DELIBERATELY OVERSIZED/.test(c.note ?? ""),
      `Essentials ${c.garment} states the oversized cut`,
    );
    // The grading half of the fact: the drape must not be read as a defect.
    assert(
      /not a fit error|must NOT be graded as wear|do not grade it as wear/i.test(c.note ?? ""),
      `Essentials ${c.garment} blocks grading the drape as wear`,
    );
  }

  // The US-sized brands say so, which is what stops the JP arithmetic carrying
  // onto a Supreme tag.
  for (const brand of ["Supreme", "Stüssy", "Kith", "Palace"]) {
    const charts = findSizingCharts(brand, "tee").filter((c) => c.brand === brand);
    assert(charts.length > 0, `${brand} has a tops chart`);
    assert(
      charts.some((c) => /US alpha sizing/.test(c.note ?? "")),
      `${brand} states it is US alpha sizing`,
    );
    assert(
      charts.some((c) => /no national cross-map applies/.test(c.note ?? "")),
      `${brand} states that no national cross-map applies`,
    );
  }
});

Deno.test("US-1737: every chart tells the seller to measure, and says the season is not the fit", () => {
  // The only defensible number on a used garment.
  const brands = ["Supreme", "Stüssy", "BAPE", "Kith", "Palace", "Fear of God Essentials"];
  for (const brand of brands) {
    const charts = findSizingCharts(brand, "").filter((c) => c.brand === brand);
    assert(charts.length > 0, `${brand} has charts`);
    for (const c of charts) {
      assert(
        /Measure the (garment|flat waistband)/i.test(c.note ?? ""),
        `${brand} ${c.garment} note tells the seller to measure`,
      );
    }
  }

  // A real and easy inference error, and the mirror of 00455's line-vs-fit trap:
  // the SEASON is the biggest fact on this group, so a model can over-apply it
  // and start adjusting the SIZE by drop. It doesn't work that way.
  const supreme = findSizingCharts("Supreme", "tee").find((c) => c.brand === "Supreme");
  assert(
    /the SEASON changes the price, not the fit/.test(supreme!.note ?? ""),
    "the Supreme chart decouples the season from the fit",
  );
  const ess = findSizingCharts("Fear of God Essentials", "tee")
    .find((c) => c.brand === "Fear of God Essentials");
  assert(
    /the season changes the price, not the fit/.test(ess!.note ?? ""),
    "the Essentials chart decouples the season from the fit",
  );
});
