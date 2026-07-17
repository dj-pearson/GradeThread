// US-1983: verify the new-generation streetwear & hype content (migration 00462)
// is correct + consumable by the engine.
//
// This group's through-line is THE GRAPHIC IS THE GARMENT AND THE DROP IS THE
// PRICE, and it makes the tier different in KIND from every group before it. A
// Birkin has a leather grade and a construction to read (00461); a Moncler has a
// down fill (00460). Most of this tier is a BLANK HOODIE WITH A PRINT — strip the
// graphic and a Hellstar, a Sp5der and a bootleg of either are the same cotton
// hoodie. So the price lives in WHICH DROP a piece is from, and that is usually
// not on the tag at all. The pack's job is therefore mostly NEGATIVE: never guess
// the drop, never authenticate, never read the design as damage.
//
// The legs this file asserts:
//   1. THE OFF-WHITE COLOUR-WORD GUARD — the group's headline hazard, and the one
//      that needed a code change. "Off-White" is a real hype brand AND the most
//      common neutral colour word in clothing.
//   2. Authentication tells are INFORMATIONAL ONLY (the story's hard constraint),
//      on the tier that is bootlegged hardest and publishes least.
//   3. THE DESIGN IS NOT DAMAGE — Gallery Dept.'s hand-distressing and Hellstar's
//      cracked prints are the product, and grading them as wear inverts the price.
//   4. The Denim Tears / Levi's dual-branding trap: the tag says Levi's and the
//      piece is still a Denim Tears.
//   5. Fit intent SPLITS across the tier (oversized vs runs-small).
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
const { buildTrustedBrandFactsBlock } = await import("../lib/garment-baselines.ts");
const { normalizeTells } = await import("../lib/brand-authenticity.ts");
const { findSizingCharts } = await import("../lib/sizing-charts.ts");
const { canonicalizeBrand, isKnownBrand, detectBrandInText } = await import(
  "../lib/brand-normalize.ts"
);
import type {
  BrandKnowledgePack,
  BrandStyleKnowledge,
} from "../lib/brand-knowledge.ts";

const GROUP = [
  "Off-White",
  "Chrome Hearts",
  "Aimé Leon Dore",
  "Gallery Dept.",
  "Denim Tears",
  "Rhude",
  "Sp5der",
  "Hellstar",
  "Anti Social Social Club",
];

// The fit intent splits, and that IS the sizing story here — kept as data so the
// tests read as the claim they make.
const OVERSIZED = ["Hellstar", "Gallery Dept."];
const RUNS_SMALL = ["Sp5der", "Chrome Hearts", "Anti Social Social Club"];

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
    department: "Unisex",
    category: "hoodie",
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
    categoryFocus: ["streetwear", "hype"],
    authenticationTells: [],
    tagEras: [],
    styles,
    decoders,
    colorways: [],
    sizingCharts: [],
    source: "db",
  };
}

// Packs shaped as the US-1711 resolver returns for the 00462-seeded rows,
// carrying the seeded fingerprints verbatim.
function seededOffWhitePack(): BrandKnowledgePack {
  return pack("Off-White", "offwhite", [
    style(
      "Diagonals",
      "Off-White",
      "NOT a single garment — the house's diagonal-stripe block. The stripes are the fastest Off-White read in a photo AND they are the single most imitated mark in streetwear, so they identify the HOUSE and nothing else: they cannot date a piece (the logo did not change when Abloh died in 2021) and they cannot price it. CHECK THE ZIP TIE and the care-label season code instead — those are the two things that actually carry information.",
      ["cotton jersey"],
    ),
    style(
      "Industrial Belt",
      "Off-White",
      "The oversized industrial-webbing belt printed with the OFF-WHITE wordmark, worn with a long tail hanging. Confirm the buckle hardware is complete and the webbing is not frayed at the tail: both are photographable and both move the price.",
      ["polyester webbing"],
    ),
  ]);
}

function seededGalleryDeptPack(): BrandKnowledgePack {
  return pack("Gallery Dept.", "gallerydept", [
    style(
      "Painted Flare Jeans",
      "Gallery Dept.",
      "A flared/bootcut jean, frequently UPCYCLED from vintage Levi's, hand-painted with splatter and hand-repaired with visible patching. THE DISTRESSING IS THE PRODUCT — the paint, the frayed hems, the holes and the visible repairs are applied on purpose and must NOT be graded as damage. No two pairs are identical, so a mismatch against a stock photo is not a fake tell. THE SIZE TAG MAY BE THE DONOR LEVI'S TAG — measure rather than trusting it.",
      ["upcycled denim", "hand-applied paint"],
    ),
    style(
      "Upcycled Vintage",
      "Gallery Dept.",
      "NOT a model — the construction method. Pieces are built on RECLAIMED VINTAGE garments (frequently Levi's or Carhartt). The base garment's ORIGINAL interior tag commonly survives, so the tag can read ANOTHER BRAND'S NAME and ANOTHER BRAND'S SIZE. That is normal construction and not a mislabel — but it means the tag is not the size.",
      ["upcycled denim"],
    ),
  ]);
}

function seededDenimTearsPack(): BrandKnowledgePack {
  return pack("Denim Tears", "denimtears", [
    style(
      "Cotton Wreath 501",
      "Denim Tears x Levi's",
      "THE Denim Tears piece: the cotton-flower WREATH printed all over an ACTUAL LEVI'S 501 as an official collaboration. So the interior tags read LEVI'S, the care label is Levi's, and THE SIZE IS A LEVI'S WAIST NUMBER (W x L) — not the alpha sizing the rest of this pack uses. Both brands are true at once: title it as the collaboration, and read the size off the Levi's tag. A resolver that concludes \"this is a Levi's 501\" from the tag has thrown away an order of magnitude of value.",
      ["Levi's denim", "screen print"],
    ),
    style(
      "Cotton Wreath",
      "Denim Tears",
      "NOT a model — the house's entire signature: a wreath of cotton flowers, made by Tremaine Emory as a statement about cotton, slavery and Black American history. It is a work, not decoration. It appears across every collaboration and identifies the HOUSE only — never the collaborator, never the drop and never the authenticity.",
      ["screen print"],
    ),
  ]);
}

function seededSp5derPack(): BrandKnowledgePack {
  return pack("Sp5der", "sp5der", [
    style(
      "Web Hoodie",
      "Sp5der",
      "THE Sp5der piece and the group's through-line at its purest: a heavyweight hoodie with the SPIDERWEB print and the rhinestone-set SP5DER wordmark. Strip the graphic and it is a blank hoodie — which is exactly why it is bootlegged at scale and why the bootleg is not separable from it in a photo. CHECK THE RHINESTONES ARE COMPLETE: they fall off, the gaps are visible, and it is a genuine price-moving defect. THE DROP IS THE PRICE AND THE TAG DOES NOT SAY WHICH DROP IT IS — do not guess.",
      ["heavyweight cotton fleece", "rhinestones"],
    ),
  ]);
}

function seededHellstarPack(): BrandKnowledgePack {
  return pack("Hellstar", "hellstar", [
    style(
      "Flame Hoodie",
      "Hellstar",
      "THE Hellstar piece: a heavyweight hoodie with flame/star iconography and the HELLSTAR STUDIOS wordmark, cut OVERSIZED by design. THE PRINT IS INTENTIONALLY DISTRESSED AND CRACKED FROM NEW — a cracked graphic here is frequently the DESIGN rather than wear. Do not automatically grade print cracking as a defect; describe it and route an unclear call to human review. The drop is the price and the tag does not say which drop it is — never guess.",
      ["heavyweight cotton fleece", "distressed screen print"],
    ),
  ]);
}

// ── 1. THE OFF-WHITE COLOUR-WORD GUARD ──────────────────────────────────────

Deno.test("US-1983: 'off-white' the COLOUR must never mint Off-White the BRAND", () => {
  // THE group's headline hazard and the only one in this story that needed a code
  // change rather than data. It is structural: CANONICAL_BRANDS is built from
  // BRAND_ALIASES' VALUES and detectBrandInText regex-scans them over prose. An
  // ordinary-word alias KEY is safe (exact whole-field lookup — the "ag"/"spider"
  // play), but an ordinary-word canonical VALUE has no such protection, and the
  // word-boundary guard cannot help because an off-white garment's title contains
  // the brand name EXACTLY.
  //
  // Worse: CANONICAL_BRANDS is sorted LONGEST-FIRST, so "Off-White" (9 chars) is
  // tested BEFORE the real "Nike" sitting in the same string — the false positive
  // would WIN. The KB already treats the phrase as a colour: 00455 seeds
  // "off-white" as an alias of Prada's Talco COLORWAY.
  for (
    const text of [
      "Nike Men's Tee Off-White Medium",
      "off-white cotton crewneck sweater, size L",
      "J.Crew blouse in off white, never worn",
      "Ralph Lauren OFF-WHITE oxford shirt",
    ]
  ) {
    assert(
      detectBrandInText(text) !== "Off-White",
      `"${text}" must not be branded Off-White from the colour word, got: ${detectBrandInText(text)}`,
    );
  }
  // And the real brands in those strings still resolve — the exclusion removes
  // Off-White from free-text detection, it does not break detection generally.
  assertEquals(detectBrandInText("Nike Men's Tee Off-White Medium"), "Nike");
  assertEquals(detectBrandInText("Ralph Lauren OFF-WHITE oxford shirt"), "Ralph Lauren");

  // ⚠ THE OTHER HALF, and the reason this is an exclusion rather than a deletion:
  // the brand is still fully reachable from a TAG. canonicalizeBrand is what the
  // eBay Brand aspect and the comp filter read, and it must still work — a comp
  // filter with no brand prices against an unfiltered category.
  assertEquals(canonicalizeBrand("off-white"), "Off-White");
  assertEquals(canonicalizeBrand("OFF WHITE"), "Off-White");
  assertEquals(canonicalizeBrand("Off-White c/o Virgil Abloh"), "Off-White");
  assert(isKnownBrand("off white"), "Off-White is a curated entry");
});

Deno.test("US-1983: the ordinary-word ALIAS KEYS are safe (exact lookup, never free text)", () => {
  // The other side of the same rule. These keys are ordinary words, and they are
  // safe ONLY because BRAND_ALIASES is an exact WHOLE-FIELD lookup — the "ag"/AG
  // Jeans precedent. They are never in CANONICAL_BRANDS (that is built from the
  // VALUES), so detectBrandInText can never mint them out of prose.
  assertEquals(canonicalizeBrand("spider"), "Sp5der");
  assertEquals(canonicalizeBrand("ch"), "Chrome Hearts");
  assertEquals(canonicalizeBrand("assc"), "Anti Social Social Club");
  assertEquals(canonicalizeBrand("ald"), "Aimé Leon Dore");

  // ...but a spider in PROSE is a spider. This one is live: a spider is a common
  // graphic SUBJECT, so this product's own description text emits the word.
  for (
    const text of [
      "vintage tee with a spider graphic on the back",
      "Champion hoodie, spider web print, size XL",
      "small spider embroidery at the chest",
    ]
  ) {
    assert(
      detectBrandInText(text) !== "Sp5der",
      `"${text}" must not be branded Sp5der from the word 'spider'`,
    );
  }
  // Same for the short abbreviations — far too short to mint from prose.
  assert(detectBrandInText("the ch collar was stained") !== "Chrome Hearts");
  assert(detectBrandInText("ald wool blend, minor pilling") !== "Aimé Leon Dore");

  // DELIBERATELY ABSENT ordinary words — the "bean"/"moth"/"goose" rule.
  for (const word of ["gallery", "tears", "hell", "star", "white", "hearts"]) {
    assert(!isKnownBrand(word), `a bare "${word}" is not a curated entry`);
    assertEquals(canonicalizeBrand(word), word, `a bare "${word}" passes through`);
  }
});

Deno.test("US-1983: the new hype aliases canonicalize (all nine were passthrough-only)", () => {
  // Without these, canonicalizeBrand PASSED THROUGH the seller's own casing
  // ("sp5der") into the prompt block and the eBay Brand aspect on some of the
  // fastest-moving garments in resale.
  assertEquals(canonicalizeBrand("chrome hearts"), "Chrome Hearts");
  assertEquals(canonicalizeBrand("CHROMEHEARTS"), "Chrome Hearts");
  assertEquals(canonicalizeBrand("gallery dept"), "Gallery Dept.");
  assertEquals(canonicalizeBrand("Gallery Dept."), "Gallery Dept.");
  assertEquals(canonicalizeBrand("gallery department"), "Gallery Dept.");
  assertEquals(canonicalizeBrand("denim tears"), "Denim Tears");
  assertEquals(canonicalizeBrand("rhude"), "Rhude");
  assertEquals(canonicalizeBrand("sp5der"), "Sp5der");
  assertEquals(canonicalizeBrand("Spider Worldwide"), "Sp5der");
  assertEquals(canonicalizeBrand("hellstar"), "Hellstar");
  assertEquals(canonicalizeBrand("Hellstar Studios"), "Hellstar");
  assertEquals(canonicalizeBrand("anti social social club"), "Anti Social Social Club");
  for (const brand of GROUP) {
    assert(isKnownBrand(brand), `${brand} is now a curated entry`);
  }

  // ⚠ brandKey() STRIPS ACCENTS, so BOTH spellings must resolve or a seller who
  // types the accent gets nothing. "Aimé Leon Dore" keys as "aimleondore" — which
  // is why migration 00462 seeds the row under that brand_key and not
  // 'aimeleondore' (the Hermès/'herms' precedent, 00461).
  assertEquals(canonicalizeBrand("Aimé Leon Dore"), "Aimé Leon Dore");
  assertEquals(canonicalizeBrand("Aime Leon Dore"), "Aimé Leon Dore");
  assertEquals(canonicalizeBrand("aimeleondore"), "Aimé Leon Dore");
});

// ── 2. AUTHENTICATION TELLS ARE INFORMATIONAL ONLY ──────────────────────────

// The seeded tell #1 for each brand, verbatim from 00462. Every one of them is the
// never-auto-authenticate guard, and that ORDER is load-bearing.
const SEEDED_FIRST_TELL: Record<string, { tell: string; detail: string }> = {
  "Off-White": {
    tell: "NEVER auto-authenticate — the care-label code is a DATE, not a certificate",
    detail:
      "Off-White is among the most counterfeited labels in modern streetwear and the house does not authenticate for third parties. The season/style code is a manufacturer-side mark that bootlegs reproduce along with everything else. Describe what is present, flag inconsistencies in condition_notes, and route authenticity to human review. Never emit an authentic/fake verdict.",
  },
  "Chrome Hearts": {
    tell: "NEVER auto-authenticate",
    detail:
      "Chrome Hearts is heavily counterfeited, publishes no authentication standard, prints no regular garment-side code, and does not authenticate for third parties. There is nothing here we could act on programmatically. Grade condition only and route authenticity to human review; never emit an authentic/fake verdict.",
  },
  "Aimé Leon Dore": {
    tell: "NEVER auto-authenticate",
    detail:
      "ALD publishes no authentication standard we can act on and does not authenticate for third parties. Its internal SKU is neither regular across categories nor brand-unique in shape, which is why it gets no decoder. Grade condition only and route authenticity to human review; never emit an authentic/fake verdict.",
  },
  "Gallery Dept.": {
    tell: "NEVER auto-authenticate",
    detail:
      "Gallery Dept. publishes no authentication standard, prints no regular garment-side code, and does not authenticate for third parties. Grade condition only and route authenticity to human review; never emit an authentic/fake verdict.",
  },
  "Denim Tears": {
    tell: "NEVER auto-authenticate",
    detail:
      "Denim Tears publishes no authentication standard, prints no regular garment-side code of its own, and does not authenticate for third parties. Grade condition only and route authenticity to human review; never emit an authentic/fake verdict.",
  },
  Rhude: {
    tell: "NEVER auto-authenticate",
    detail:
      "Rhude publishes no authentication standard, prints no regular garment-side code, and does not authenticate for third parties. Grade condition only and route authenticity to human review; never emit an authentic/fake verdict.",
  },
  Sp5der: {
    tell: "NEVER auto-authenticate — this is the most bootlegged garment in the pack",
    detail:
      "Sp5der is bootlegged at enormous scale and the brand publishes NO authentication standard, NO serial and NO regular code, and does not authenticate for third parties. The structural problem is the group's through-line at its worst: THE GARMENT IS A BLANK HOODIE AND THE PRINT IS THE PRODUCT, so a bootleg reproduces essentially all of it and the two are not separable in a photo. There is nothing here we could act on. Grade condition only and route authenticity to human review; never emit an authentic/fake verdict.",
  },
  Hellstar: {
    tell: "NEVER auto-authenticate",
    detail:
      "Hellstar is bootlegged at very large scale and publishes NO authentication standard, NO serial and NO regular code, and does not authenticate for third parties. Same structural problem as Sp5der beside it: the garment is a blank hoodie and the print is the product, so a bootleg reproduces essentially all of it and the two are not separable in a photo. Grade condition only and route authenticity to human review; never emit an authentic/fake verdict.",
  },
  "Anti Social Social Club": {
    tell: "NEVER auto-authenticate",
    detail:
      "ASSC was among the most bootlegged brands of the 2010s and publishes no authentication standard, no serial and no regular code; it does not authenticate for third parties. The garment is a printed blank, so a bootleg reproduces essentially all of it. Grade condition only and route authenticity to human review; never emit an authentic/fake verdict.",
  },
};

Deno.test("US-1983: the seeded tells normalize onto the structured authenticity read path", () => {
  // THE STORY'S HARD CONSTRAINT, CHECKED WHERE IT IS ACTUALLY LOAD-BEARING.
  //
  // The renderer that matters is NOT buildTrustedBrandFactsBlock (grading) — that
  // spends its 900-char budget on fingerprints BY DESIGN and truncates tell prose
  // as a matter of course (the US-1981 lesson: do not "fix" it). The real consumer
  // is the US-1767/1768 authenticity add-on: normalizeTells → getEffectiveTells →
  // ai-authenticity, which is confidence-capped, disclaimer-bounded and routes low
  // confidence to human review BY CONSTRUCTION.
  //
  // These rows use the {tell, detail} shape every brand-group migration has used
  // (00443..00461); coerceTell maps that legacy shape onto claim/check on read.
  for (const brand of GROUP) {
    const seeded = SEEDED_FIRST_TELL[brand];
    const tells = normalizeTells([
      seeded,
      { tell: "A second tell", detail: "some detail" },
    ]);
    assert(tells.length === 2, `${brand}: both tells normalize`);
    assertEquals(tells[0].claim, seeded.tell, `${brand}: the guard's claim survives coercion`);
    assertEquals(tells[0].check, seeded.detail, `${brand}: the guard's detail becomes the check`);
    assert(
      /human review/i.test(tells[0].check),
      `${brand}: the guard routes authenticity to human review`,
    );
    for (const t of tells) {
      assert(
        !/\bis authentic\b|\bgenuine article\b|\bverified authentic\b/i.test(
          `${t.claim} ${t.check}`,
        ),
        `${brand}: no tell asserts an authenticity verdict`,
      );
    }
  }
});

Deno.test("US-1983: no seeded tell claims a garment can be verified authentic", () => {
  // The inverse guard: a refusal being present is not enough — nothing in the pack
  // may read as a licence to authenticate. This tier is bootlegged harder than any
  // the KB has seeded, and several of these brands publish nothing at all.
  for (const brand of GROUP) {
    const detail = SEEDED_FIRST_TELL[brand].detail;
    assert(/human review/i.test(detail), `${brand} routes authenticity to human review`);
    assert(
      /never emit an authentic\/fake verdict/i.test(detail),
      `${brand} forbids an authenticity verdict outright`,
    );
    assert(
      /does not authenticate for third parties/i.test(detail),
      `${brand} states the house does not authenticate for us`,
    );
  }
  // Off-White is the live temptation, because it is the one brand here that ships
  // a code that LOOKS like a verification device.
  assert(
    /bootlegs reproduce/i.test(SEEDED_FIRST_TELL["Off-White"].detail),
    "Off-White states the care-label code is reproduced by bootlegs",
  );
  // Sp5der/Hellstar name the STRUCTURAL reason this tier cannot be authenticated:
  // when the print is the whole product, copying the print copies the product.
  for (const brand of ["Sp5der", "Hellstar"]) {
    assert(
      /the print is the product/i.test(SEEDED_FIRST_TELL[brand].detail),
      `${brand} names why a blank-plus-print cannot be authenticated from a photo`,
    );
  }
});

// ── 3. THE DESIGN IS NOT DAMAGE ─────────────────────────────────────────────

Deno.test("US-1983: 'the distressing is the product' reaches the GRADING block", () => {
  // The most consequential grading rule in this pack, and it has to reach the
  // renderer that actually grades. buildTrustedBrandFactsBlock caps tells hard, so
  // this fact is deliberately carried in a STYLE FINGERPRINT — the US-1740 lesson:
  // a fact that must reach identification/grading belongs in a fingerprint or a
  // chart note, never in a tell.
  //
  // What is at stake: a grader who reads hand-applied paint splatter, frayed hems
  // and deliberate holes as wear marks a MINT piece down to Poor — inverting the
  // price of a garment that is worth more precisely because it looks destroyed.
  const block = buildTrustedBrandFactsBlock(seededGalleryDeptPack());
  assert(block.includes("Gallery Dept."), "the block names the brand");
  assert(
    /THE DISTRESSING IS THE PRODUCT/.test(block),
    "the design-is-not-damage rule reaches the grading block",
  );
  assert(
    /must NOT be graded as damage/.test(block),
    "the block says not to grade the distressing as damage",
  );
  // The corollary: variation is the product too, so a stock-photo mismatch is not
  // a fake tell.
  assert(
    /No two pairs are identical/.test(block),
    "per-piece variation reaches the grading block",
  );

  // Hellstar carries the same trap in a different form: the print is cracked FROM
  // NEW. Two brands in one pack where the obvious defect is the design.
  const hellstar = buildTrustedBrandFactsBlock(seededHellstarPack());
  assert(
    /INTENTIONALLY DISTRESSED AND CRACKED FROM NEW/.test(hellstar),
    "Hellstar's intentional print cracking reaches the grading block",
  );
});

Deno.test("US-1983: the completeness facts reach the block (they are not damage either)", () => {
  // The flip side: on this tier the REAL defects are missing components, and they
  // are photographable. Same shape as the Birkin clochette / City tassels (00461).
  const offwhite = brandPackPromptBlock(seededOffWhitePack());
  assert(/ZIP TIE/.test(offwhite), "the Off-White zip tie reaches the block");
  const sp5der = buildTrustedBrandFactsBlock(seededSp5derPack());
  assert(
    /RHINESTONES ARE COMPLETE/.test(sp5der),
    "Sp5der rhinestone completeness reaches the grading block",
  );
});

// ── 4. THE DENIM TEARS / LEVI'S DUAL-BRANDING TRAP ──────────────────────────

Deno.test("US-1983: the Denim Tears piece is a Levi's AND a Denim Tears", () => {
  // The group's dual-branding trap, and it is NOT a counterfeit one — which is
  // what makes it novel. The Cotton Wreath 501s ARE Levi's garments printed under
  // an official collaboration, so a genuine Denim Tears legitimately carries
  // LEVI'S tags, a LEVI'S waist size and a Levi's care label inside it.
  //
  // Both failure directions are live: read the tag and conclude "Levi's 501" and
  // an order of magnitude of value is gone; ignore the tag and the size is gone
  // with it, because the Levi's number is the only place the size lives.
  const block = brandPackPromptBlock(seededDenimTearsPack());
  assert(/ACTUAL LEVI'S 501/.test(block), "the Levi's base garment reaches the block");
  assert(
    /LEVI'S WAIST NUMBER/.test(block),
    "the block states the size is a Levi's waist number",
  );
  assert(
    /Both brands are true at once/.test(block),
    "the block states both brands are simultaneously true",
  );
  assert(
    /thrown away an order of magnitude of value/.test(block),
    "the block names the cost of resolving it to Levi's",
  );

  // Denim Tears must NOT fold onto Levi's, and Levi's must stay itself.
  assertEquals(canonicalizeBrand("denim tears"), "Denim Tears");
  assertEquals(canonicalizeBrand("levis"), "Levi's");
  assert(
    canonicalizeBrand("Denim Tears") !== "Levi's",
    "Denim Tears must never canonicalize to its base garment's brand",
  );
});

Deno.test("US-1983: THE ONLY WAIST CHART IN THE PACK is Denim Tears', and the reason is the collab", () => {
  // Every other brand here is alpha-sized. Denim Tears breaks the system because
  // the garment underneath is a Levi's — so its chart is a WAIST chart, and the
  // note has to explain why the odd one out is odd.
  const dt = findSizingCharts("Denim Tears", "jeans")
    .find((c) => c.brand === "Denim Tears")!;
  assert(dt, "the Denim Tears denim chart is reachable");
  assert(/WAIST/i.test(dt.garment), "it is a waist chart");
  for (const row of dt.rows) {
    assert(/Levi's/.test(row.size), `row "${row.size}" names the Levi's waist system`);
  }
  assert(/THE ODD ONE OUT IN THIS PACK/.test(dt.note ?? ""), "the note flags it as the exception");
  assert(
    /both brands are true at once/i.test(dt.note ?? ""),
    "the chart note carries the dual-branding rule where the size is read",
  );

  // ...and nothing else in the group has one.
  for (const brand of GROUP.filter((b) => b !== "Denim Tears")) {
    const charts = findSizingCharts(brand, "jeans").filter((c) => c.brand === brand);
    assert(
      charts.every((c) => !/WAIST/i.test(c.garment)),
      `${brand} has no waist chart (the tier is alpha-sized)`,
    );
  }
});

// ── 5. SIZING: NO PUBLISHED CHARTS, AND THE FIT INTENT SPLITS ───────────────

Deno.test("US-1983: the group's charts are reachable per brand + are BODY measurements", () => {
  const cases: Array<[string, string]> = [
    ["Off-White", "hoodie"],
    ["Chrome Hearts", "hoodie"],
    ["Aimé Leon Dore", "polo"],
    ["Gallery Dept.", "tee"],
    ["Rhude", "shirt"],
    ["Sp5der", "hoodie"],
    ["Hellstar", "tee"],
    ["Anti Social Social Club", "hoodie"],
  ];
  for (const [brand, category] of cases) {
    const found = findSizingCharts(brand, category);
    assert(
      found.some((c) => c.brand === brand),
      `${brand} chart reachable for "${category}"`,
    );
  }

  // Every chart must say which BASIS it is — the error the outdoor (00453),
  // outerwear (00460) and luxury RTW (00461) groups each pinned.
  for (const brand of GROUP) {
    const mine = findSizingCharts(brand, "hoodie")
      .concat(findSizingCharts(brand, "jeans"))
      .filter((c) => c.brand === brand);
    assert(mine.length > 0, `${brand} has at least one chart`);
    for (const c of mine) {
      assert(
        /BODY/i.test(c.note ?? ""),
        `${brand} ${c.garment} note states the BODY basis`,
      );
    }
  }
});

Deno.test("US-1983: every chart is HONEST that the brand publishes no size guide", () => {
  // The provenance rule (US-1733's "seed only what a source supports"), applied to
  // a whole tier at once: NONE of these brands publishes a chart. Seeding the
  // standard alpha approximation is right; claiming it came from the brand would
  // be a lie about provenance, and the note is where that gets told.
  for (const brand of GROUP.filter((b) => b !== "Denim Tears")) {
    const chart = findSizingCharts(brand, "hoodie").find((c) => c.brand === brand)!;
    assert(
      /NOT brand-fetched/i.test(chart.note ?? ""),
      `${brand} note states the figures are not brand-fetched`,
    );
    assert(
      /approximation/i.test(chart.note ?? ""),
      `${brand} note calls the chart an approximation`,
    );
  }
});

Deno.test("US-1983: THE FIT INTENT SPLITS — oversized vs runs-small, in the same pack", () => {
  // The sizing fact a body chart cannot express, and the group's real trap: a
  // Hellstar measures far ABOVE its nominal size on purpose while a Sp5der beside
  // it runs SMALL. A grader who carries one brand's fit intent across the tier
  // reports the design as an error — in one direction or the other. Both halves
  // must be stated, and each must name the other so the rule is learned as
  // HOUSE-dependent rather than universal (the 00461 lesson).
  for (const brand of OVERSIZED) {
    const c = findSizingCharts(brand, "hoodie").find((x) => x.brand === brand)!;
    assert(
      /OVERSIZED/i.test(c.note ?? ""),
      `${brand} note states the oversized intent`,
    );
    assert(
      /on purpose|by design/i.test(c.note ?? ""),
      `${brand} note states the oversizing is the design, not a mis-tag`,
    );
  }
  for (const brand of RUNS_SMALL) {
    const c = findSizingCharts(brand, "hoodie").find((x) => x.brand === brand)!;
    assert(
      /RUNS SMALL|runs SMALL/.test(c.note ?? ""),
      `${brand} note states the small-running fit`,
    );
  }
  // The two poles must NAME each other — a note that silently adjusts teaches
  // nothing, and this trap is only survivable if the reader learns it splits.
  const hellstar = findSizingCharts("Hellstar", "hoodie")
    .find((c) => c.brand === "Hellstar")!;
  assert(
    /Sp5der/.test(hellstar.note ?? "") && /opposite/i.test(hellstar.note ?? ""),
    "the Hellstar note names the small-running brands as the opposite pole",
  );
  const sp5der = findSizingCharts("Sp5der", "hoodie").find((c) => c.brand === "Sp5der")!;
  assert(
    /Hellstar/.test(sp5der.note ?? "") && /opposite/i.test(sp5der.note ?? ""),
    "the Sp5der note names the oversized brands as the opposite pole",
  );
});

Deno.test("US-1983: Off-White runs TWO size systems and the charts say which is which", () => {
  // The one brand in the hype tier that touches the 00461 Italian system: it is a
  // MILAN house, so its tailoring carries Italian numbers while its tees are
  // alpha. One brand, two systems — read the OBJECT before the number.
  const alpha = findSizingCharts("Off-White", "hoodie")
    .find((c) => c.brand === "Off-White" && c.department === "Unisex")!;
  assert(alpha, "the Off-White alpha chart is reachable from a hoodie");
  assert(
    /ONE BRAND, TWO SYSTEMS/.test(alpha.note ?? ""),
    "the alpha note warns the brand runs two systems",
  );
  assert(
    /READ THE OBJECT BEFORE THE NUMBER/.test(alpha.note ?? ""),
    "the alpha note says to read the object first",
  );

  const italian = findSizingCharts("Off-White", "blazer")
    .find((c) => c.brand === "Off-White" && c.department === "Men")!;
  assert(italian, "the Off-White Italian tailoring chart is reachable from a blazer");
  // The cross-map goes in the size LABEL — the only uncapped channel that reaches
  // the model (the US-1731/US-1740 lesson), same as the 00461 luxury charts.
  assert(
    italian.rows.some((r) => /^50 /.test(r.size) && /US 40/.test(r.size)),
    "the Italian chart labels a 50 as a US 40 in the LABEL, not just the note",
  );
  for (const row of italian.rows) {
    assert(/US/.test(row.size), `Italian row "${row.size}" carries a US equivalent`);
  }
  assert(
    /ALPHA-SIZED/.test(italian.note ?? ""),
    "the Italian note points back at the alpha half of the same brand",
  );
});

Deno.test("US-1983: every brand resolves ONLY its own charts (no cross-brand leak)", () => {
  // The substring/leading-word hazards this file exists to catch (US-1735/1737/
  // 1738). This group is full of ordinary-word brand names ("Denim Tears",
  // "Gallery Dept.", "Off-White"), which is exactly the shape that leaks.
  for (const brand of GROUP) {
    for (const category of ["hoodie", "tee", "shirt", "jacket", "jeans", "pant"]) {
      const charts = findSizingCharts(brand, category);
      assert(
        charts.every((c) => c.brand === brand),
        `${brand} ("${category}") resolves only its own charts, got: ${
          charts.map((c) => c.brand).join(", ")
        }`,
      );
    }
  }
});

// ── 6. THE DROP IS THE PRICE — AND THE MODEL MUST NOT GUESS IT ──────────────

Deno.test("US-1983: the never-guess-the-drop rule reaches the prompt block", () => {
  // The group's defining constraint. The drop is most of the price and it is
  // usually not on the tag, so a drop attribution is a SCARCITY CLAIM — inventing
  // one prices a common piece as a rare one. This is the never-guess principle
  // (US-1716) applied to the fact that actually carries the money here.
  for (const p of [seededSp5derPack(), seededHellstarPack()]) {
    const block = brandPackPromptBlock(p);
    assert(
      /THE DROP IS THE PRICE/i.test(block) || /drop is the price/i.test(block),
      `${p.brand}: the drop-is-the-price fact reaches the block`,
    );
    assert(
      /do not guess|never guess/i.test(block),
      `${p.brand}: the block forbids guessing the drop`,
    );
  }
});

Deno.test("US-1983: Off-White is the only brand in the group that invites a code transcription", () => {
  const offwhite = pack("Off-White", "offwhite", [], [
    {
      decoderKind: "style_number",
      description:
        "Off-White season/style code printed on the interior care label: OM (men) or OW (women) + a 2-letter category + 3 digits + a season token + 3 letters + 3-4 digits — e.g. OMAA038R21FAB001. Recovers the BRAND off a cut or removed brand tab and the ERA via the season token. NOT an authenticity check: a bootleg copies the care label too.",
      pattern:
        "^(?<code>O(?<gender>[MW])[A-Z]{2}\\d{3}(?<season>[A-Z]\\d{2})[A-Z]{3}\\d{3,4})$",
      extractionRules: {},
      examples: [],
    },
  ]);
  const block = brandPackPromptBlock(offwhite);
  assert(
    /transcribe it VERBATIM/i.test(block),
    "Off-White carries the decoder hint (its care-label code is regular)",
  );
  assert(/care label/i.test(block), "the code's location reaches the block");
  // It is a SEASON code, not a certificate — the description must not over-claim.
  assert(
    /NOT an authenticity check/i.test(block),
    "the block states the code does not authenticate",
  );

  // Every other brand in the group is decoder-less by design, and seven of them
  // print no regular garment-side code AT ALL — there is nothing to decode, so a
  // pattern would be invented rather than read (the Chanel rule, US-1736).
  for (
    const [brand, key] of [
      ["Chrome Hearts", "chromehearts"],
      ["Aimé Leon Dore", "aimleondore"],
      ["Gallery Dept.", "gallerydept"],
      ["Denim Tears", "denimtears"],
      ["Rhude", "rhude"],
      ["Sp5der", "sp5der"],
      ["Hellstar", "hellstar"],
      ["Anti Social Social Club", "antisocialsocialclub"],
    ]
  ) {
    const b = brandPackPromptBlock(pack(brand, key, [style("X", "X", "a fingerprint")]));
    assert(
      !/transcribe it VERBATIM/i.test(b),
      `${brand} must not invite a code transcription (it has no decodable code)`,
    );
  }
});

Deno.test("US-1983: the house marks are stated to place NOTHING", () => {
  // The tier's quiet inversion: on a luxury bag the house mark narrows things. On
  // a hype hoodie the mark is the most-copied thing about it and appears on every
  // drop, so it identifies the house and nothing else. The fingerprints have to
  // say so, or the model will read a logo as evidence of an era or a drop.
  const offwhite = brandPackPromptBlock(seededOffWhitePack());
  assert(
    /identify the HOUSE and nothing else/.test(offwhite),
    "the Off-White diagonals are stated to place nothing",
  );
  // The specific trap: Abloh died in 2021 but the LOGO DID NOT CHANGE, so the
  // logo cannot date a piece either side of the line that actually prices it.
  assert(
    /the logo did not change when Abloh died in 2021/i.test(offwhite),
    "the block states the logo cannot date the piece",
  );
  const denimtears = brandPackPromptBlock(seededDenimTearsPack());
  assert(
    /identifies the HOUSE only/.test(denimtears),
    "the Cotton Wreath is stated to place nothing",
  );
});
