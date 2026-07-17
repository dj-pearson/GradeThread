// US-1987: verify the preppy & contemporary men's content (migration 00467) is
// correct + consumable by the engine.
//
// All nine brands were passthrough-only before this pack, so a "peter millar" tag
// rendered the seller's own casing into the prompt block and the eBay Brand aspect
// on some of the highest sell-through menswear in resale. What the assertions
// below protect is the four things this group has that no prior pack did:
//
//   1. THE FIT NAME IS THE GARMENT-DEFINING FACT, AND IT IS TAG-ONLY. 00466 was
//      about the SIZE SYSTEM (a Zara "38" is an EU size, a Lucky "38" is inches).
//      This is one axis over: the size grade is NOT in dispute — a Bonobos 32x32
//      is a 32x32 in every fit, a Slim UNTUCKit L and a Relaxed L are both "L" —
//      what changes is the CUT, by up to 5 INCHES, and only a WORD ON THE TAG
//      says which.
//   2. AND THE LADDER'S ORDER IS COUNTERINTUITIVE IN **TWO** BRANDS, with the
//      open web backwards on both and the brand's OWN chart refuting it: Bonobos'
//      Tailored is TRIMMER than its Slim, and Brooks Brothers' Madison is the
//      ROOMIEST suit fit. Asserted here because a model cannot be rescued by
//      retrieval — the aggregators are split.
//   3. MENSWEAR RUNS FOUR SIZE SYSTEMS AT ONCE, often on ONE brand (Brooks
//      Brothers sells all four; UNTUCKit's system is category-conditional).
//   4. ONE DECODER, EIGHT REFUSALS — and the difference is PROVENANCE, not shape.
//
// The decoder + every refusal are fixtured in brand-knowledge-golden_test.ts.
// This file asserts the CONTENT: that the prompt block carries the corrections,
// that the charts are reachable, and that the alias table's refusals hold.
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
  "Vineyard Vines",
  "Brooks Brothers",
  "Bonobos",
  "Faherty",
  "Peter Millar",
  "Todd Snyder",
  "Buck Mason",
  "UNTUCKit",
  "Johnnie-O",
];

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
    categoryFocus: ["menswear"],
    authenticationTells: [],
    tagEras: [],
    styles,
    decoders,
    colorways: [],
    sizingCharts: [],
    source: "db",
  };
}

Deno.test("US-1987: the preppy/contemporary men's aliases canonicalize", () => {
  for (const brand of GROUP) {
    assertEquals(
      canonicalizeBrand(brand.toLowerCase()),
      brand,
      `${brand} canonicalizes from a lowercase tag`,
    );
    assert(isKnownBrand(brand), `${brand} is a curated entry, not a passthrough`);
  }

  // The SUB-LABELS and TIER names, which are often the only string on the tag —
  // a Crown Crafted garment carries its own dark navy label, and a Maide tag
  // never says "Bonobos". The BDG play from 00466.
  assertEquals(canonicalizeBrand("Crown Crafted"), "Peter Millar");
  assertEquals(canonicalizeBrand("Crown Sport"), "Peter Millar");
  assertEquals(canonicalizeBrand("Golden Fleece"), "Brooks Brothers");
  assertEquals(canonicalizeBrand("Red Fleece"), "Brooks Brothers");
  assertEquals(canonicalizeBrand("Brooksgate"), "Brooks Brothers");
  assertEquals(canonicalizeBrand("Maide"), "Bonobos");
  assertEquals(canonicalizeBrand("Tweener Button"), "Johnnie-O");

  // The misspellings these brands actually attract.
  assertEquals(canonicalizeBrand("vinyard vines"), "Vineyard Vines");
  assertEquals(canonicalizeBrand("Peter Miller"), "Peter Millar");
  assertEquals(canonicalizeBrand("Johnny O"), "Johnnie-O");
  assertEquals(canonicalizeBrand("Brooks Bros"), "Brooks Brothers");

  // JOHNNIE-O'S PUNCTUATION COLLAPSES FOR FREE, which is why it needs only one
  // key: brandKey() strips the hyphen, so every spelling a seller types lands on
  // the same entry. Contrast Rag & Bone / Aimé Leon Dore, where the punctuation
  // produced genuinely DIFFERENT keys and both had to be listed.
  for (const spelling of ["Johnnie-O", "Johnnie O", "JohnnieO", "johnnie-o"]) {
    assertEquals(
      canonicalizeBrand(spelling),
      "Johnnie-O",
      `${spelling} collapses onto the one canonical`,
    );
  }

  // THE COLLAB ATTRIBUTION RULE. A tag naming BOTH brands resolves to Todd
  // Snyder: TS owns the design and prices it at ~3x a standard Reverse Weave, so
  // Champion is the manufacturing input and TS is the commercial identity.
  // Resolving it the other way drags a $168 garment onto a mass-market canonical.
  assertEquals(canonicalizeBrand("Todd Snyder + Champion"), "Todd Snyder");
  assertEquals(canonicalizeBrand("Todd Snyder x Champion"), "Todd Snyder");
});

Deno.test("US-1987: a bare 'Brooks' never resolves to Brooks Brothers", () => {
  // THE PACK'S HEADLINE ALIAS REFUSAL, and it is not hypothetical: Brooks Running
  // (Ghost, Adrenaline — a Berkshire Hathaway company) is a DIFFERENT COMPANY
  // that is not in this KB, and the two actually litigated the name (Brooks
  // Sports sued Brooks Brothers in 2020 over their 1980 coexistence agreement).
  //
  // `brooks: "Brooks Brothers"` would silently retitle every Brooks Running shoe
  // whose brand field is literally "Brooks" — and unlike "mother" or "spider", a
  // bare "Brooks" is not merely an ordinary WORD that is safe as an exact key:
  // it is a genuinely AMBIGUOUS BRAND FIELD, so it must not be a key either.
  // This assertion is empirical: adding the alias turns it red.
  assertEquals(
    canonicalizeBrand("Brooks"),
    "Brooks",
    "a bare 'Brooks' passes through untouched — it may be Brooks Running",
  );
  assert(
    !isKnownBrand("Brooks"),
    "a bare 'Brooks' must NOT be a curated entry",
  );
  assertEquals(
    detectBrandInText("Brooks Ghost 15 running shoe mens 10.5"),
    null,
    "a Brooks Running title must not mint Brooks Brothers",
  );

  // The long form still works, which is the whole point of the AG Jeans play.
  assertEquals(
    detectBrandInText("Brooks Brothers Golden Fleece blazer 42R"),
    "Brooks Brothers",
  );

  // And the chart table must not leak either: findSizingCharts matches brandMatch
  // as a LEADING-word substring, so a bare "brooks" token there would hand every
  // Brooks Running garment BB's dress-shirt charts (the US-1735 hazard).
  assert(
    !findSizingCharts("Brooks", "running shoe").some((c) =>
      c.brand === "Brooks Brothers"
    ),
    "Brooks Running must not reach Brooks Brothers' charts",
  );

  // Same shape, different brand: a bare "Buck" is not an alias (Buck Knives).
  assert(!isKnownBrand("Buck"), "a bare 'Buck' must not resolve to Buck Mason");
});

Deno.test("US-1987: the fit-ladder INVERSIONS reach the extract prompt", () => {
  // THE PACK'S HEADLINE FACT, and the reason it must live in a FINGERPRINT rather
  // than a tell: brandPackPromptBlock renders visual_fingerprint VERBATIM but
  // collapses every authentication tell to ONE GENERIC LINE (US-1740). A fit
  // ladder seeded as a tell would never reach the model that has to read the tag.
  //
  // Two independent brands, same shape of error, both refuted by the brand's OWN
  // published chart — and the aggregators are SPLIT on both, so retrieval cannot
  // rescue a model here. This is exactly the fabrication-that-reads-as-
  // confirmation case the KB exists for.
  const bonobos = brandPackPromptBlock(
    pack("Bonobos", "bonobos", [
      style(
        "Fit vocabulary (Tailored / Slim Taper / Slim / Straight / Athletic / Classic)",
        "Fit system",
        "⚠ **TAILORED IS TRIMMER THAN SLIM.** Tailored is \"trimmest in the hips and thighs\" while Slim merely removes \"billowing\". SIX pant fits, not four. ⚠ THE FIT DOES NOT CHANGE THE SIZE GRADE, only the cut — the same model wears a 32x32 in BOTH Athletic and Slim. ⚠ \"STANDARD\" IS CURRENT, NOT HISTORICAL.",
      ),
    ]),
  );
  assert(
    /TAILORED IS TRIMMER THAN SLIM/i.test(bonobos),
    "Bonobos' inversion must render verbatim into the extract prompt",
  );
  assert(
    /DOES NOT CHANGE THE SIZE GRADE/i.test(bonobos),
    "the fit-is-orthogonal-to-the-grade rule must reach the prompt",
  );

  const bb = brandPackPromptBlock(
    pack("Brooks Brothers", "brooksbrothers", [
      style(
        "Suit fit ladder (Milano / Regent / Madison)",
        "Fit system",
        "⚠ **MADISON IS THE ROOMIEST SUIT FIT, NOT A TRIM ONE** — SEO fit-guides state the reverse. Madison is \"OUR CLASSIC CUT, RELAXED through the chest, body and sleeves\" (+3\" chest / +5\" waist). Milano = slimmest, Regent = middle, MADISON = ROOMIEST. ⚠ AND THE WORD MOVES BETWEEN CATEGORIES: Madison is 4th of 5 rungs on the shirt ladder but the roomiest of 3 here.",
      ),
    ]),
  );
  assert(
    /MADISON IS THE ROOMIEST SUIT FIT/i.test(bb),
    "Brooks Brothers' inversion must render verbatim into the extract prompt",
  );
  assert(
    /THE WORD MOVES BETWEEN CATEGORIES/i.test(bb),
    "the shirts-and-suits-are-different-ladders rule must reach the prompt",
  );
});

Deno.test("US-1987: the fit does not change the size grade — the chart notes say so", () => {
  // The size-side half of the same fact. The fit ladders live in brand_styles;
  // the charts must independently tell a model that the NUMBER is unaffected, or
  // it will "correct" a size for a fit it read off the tag.
  const bonobos = findSizingCharts("Bonobos", "chino")[0];
  assert(
    /FIT NAME DOES NOT CHANGE THIS GRADE/i.test(bonobos.note ?? ""),
    "Bonobos' bottoms chart states the fit does not move the grade",
  );
  assert(
    /TAILORED IS TRIMMER THAN SLIM/i.test(bonobos.note ?? ""),
    "and repeats the inversion where a sizing decision is actually made",
  );

  const bbShirt = findSizingCharts("Brooks Brothers", "dress shirt")[0];
  assert(
    /16-34 Milano and a 16-34 Madison are both\s+16-34/i.test(
      (bbShirt.note ?? "").replace(/\s+/g, " "),
    ),
    "BB's dress-shirt chart states the fit does not move the grade",
  );

  const untuckit = findSizingCharts("UNTUCKit", "button down")[0];
  assert(
    /THE FIT DOES NOT CHANGE THIS GRADE/i.test(untuckit.note ?? ""),
    "UNTUCKit's chart states the fit does not move the grade",
  );
  assert(
    /NO\s+'Athletic' fit/i.test((untuckit.note ?? "").replace(/\s+/g, " ")),
    "and refuses the invented Athletic fit outright",
  );
});

Deno.test("US-1987: menswear's four size systems are each named in the garment string", () => {
  // A miss silently hands a garment the wrong system, and this group is where
  // that bites hardest: BROOKS BROTHERS SELLS ALL FOUR AT ONCE. category_match is
  // a plain substring test (deliberately), so the systems must be kept apart by
  // tight, non-overlapping category lists AND named where the model reads them.
  const bbShirt = findSizingCharts("Brooks Brothers", "dress shirt");
  assert(
    bbShirt.some((c) => /NECK x SLEEVE/i.test(c.garment)),
    "BB dress shirts resolve the neck x sleeve chart",
  );
  const bbSuit = findSizingCharts("Brooks Brothers", "suit");
  assert(
    bbSuit.some((c) => /CHEST in inches \+ a LENGTH LETTER/i.test(c.garment)),
    "BB suits resolve the chest + length-letter chart",
  );
  // The two must not collide: a suit must not be handed the shirt's grade.
  assert(
    !bbSuit.some((c) => /NECK x SLEEVE/i.test(c.garment)),
    "a BB suit must never resolve the dress-shirt chart",
  );

  // UNTUCKIT IS THE SAME TRAP IN MINIATURE — the system is CATEGORY-CONDITIONAL,
  // so "UNTUCKit is alpha-sized" is only half true and the note must say so.
  const untuckit = findSizingCharts("UNTUCKit", "shirt")[0];
  assert(
    /CATEGORY-\s*CONDITIONAL/i.test((untuckit.note ?? "").replace(/\s+/g, " ")),
    "UNTUCKit's chart states its system is category-conditional",
  );

  // Bottoms are inches on this side of the KB — the FOIL to 00466's EU brands,
  // named explicitly so a model does not carry the EU reading across packs.
  const pm = findSizingCharts("Peter Millar", "pant")[0];
  assert(
    /WAIST IN INCHES/i.test(pm.garment),
    "Peter Millar's bottoms chart names inches in the garment string",
  );
  assert(
    /contrast Zara/i.test(pm.note ?? ""),
    "and names the 00466 EU brands as the explicit contrast",
  );
});

Deno.test("US-1987: Peter Millar's chart admits the brand RE-CUT it", () => {
  // THE GROUP'S BEST SIZING HAZARD, and the reason the aggregators disagree
  // without either being "wrong": Peter Millar re-cut its grade between 2023 and
  // 2025 (men's S chest 36-38 → 37-39), so "Peter Millar M" means a different
  // body depending on the garment's age. A chart that hid this would be
  // confidently wrong on half the resale supply.
  const note = findSizingCharts("Peter Millar", "polo")
    .map((c) => c.note ?? "").join(" ").replace(/\s+/g, " ");
  assert(
    /RE-CUT THIS CHART BETWEEN 2023 AND 2025/i.test(note),
    "the re-cut is stated outright",
  );
  assert(
    /AGGREGATORS DISAGREE/i.test(note),
    "and it explains WHY the aggregators disagree, so neither is trusted blindly",
  );

  // Peter Millar has NO neck x sleeve system — a real refusal, since every peer
  // in this pack that sells dress shirts does have one.
  assert(
    /NOT neck x sleeve/i.test(note),
    "PM's chart refuses the dress-shirt system it does not have",
  );
});

Deno.test("US-1987: the honest charts say the numbers are not the brand's own", () => {
  // The Brandy Melville rule from 00466, applied to two brands whose size guides
  // simply could not be obtained. The temptation is to fill them from an
  // aggregator; the failure mode is that a model RECALLS exactly those numbers,
  // so a seeded fabrication reads as confirmation. These rows carry the SIZE
  // SYSTEM and say outright that the numbers are not the brand's.
  for (const brand of ["Todd Snyder", "Buck Mason"]) {
    const charts = findSizingCharts(brand, null).filter((c) =>
      c.brand === brand
    );
    assert(charts.length > 0, `${brand} still reaches its own chart`);
    const note = charts.map((c) => c.note ?? "").join(" ").replace(/\s+/g, " ");
    assert(
      /NOT THE BRAND'S OWN/i.test(note),
      `${brand}'s chart admits the numbers are not the brand's`,
    );
    assert(
      /NONE IS INVENTED/i.test(note),
      `${brand}'s chart says outright that nothing was invented`,
    );
    assert(
      /SIZE SYSTEM/i.test(c0(charts)),
      `${brand}'s chart carries the system rather than fabricated measurements`,
    );
  }

  // Bonobos is the middle case: the SYSTEM is confirmed three independent ways,
  // the GRID is not published anywhere reachable. So it gets a real chart that
  // restates the label-is-the-waist rule and nothing more.
  const bonobos = findSizingCharts("Bonobos", "chino")[0];
  assert(
    /NO REACHABLE NUMERIC GRID/i.test((bonobos.note ?? "").replace(/\s+/g, " ")),
    "Bonobos' chart admits its grid is unpublished",
  );

  // Faherty's ARE the brand's own — but the assets are 2019, so it must hedge
  // rather than present a stale chart as current.
  const faherty = findSizingCharts("Faherty", "flannel")[0];
  assert(
    /DATED 2019/i.test(faherty.note ?? ""),
    "Faherty's chart discloses that the brand's published assets are stale",
  );
});

function c0(charts: Array<{ garment: string }>): string {
  return charts.map((c) => c.garment).join(" ");
}

Deno.test("US-1987: the hemmed-to-order trap is stated wherever it applies", () => {
  // A REAL grading trap that three of these brands share and that no prior pack
  // had: they hem pants to the ordered inseam BEFORE shipping. So a SECONDHAND
  // garment's inseam is frequently a CUSTOM hem rather than a catalogue length —
  // measuring it and matching it against a size grid is meaningless.
  for (const [brand, cat] of [
    ["Peter Millar", "pant"],
    ["Bonobos", "chino"],
    ["Buck Mason", "jean"],
  ] as Array<[string, string]>) {
    const note = findSizingCharts(brand, cat).map((c) => c.note ?? "").join(" ")
      .replace(/\s+/g, " ");
    // Matched loosely on purpose: Peter Millar and Bonobos say "a CUSTOM HEM, not
    // a catalogue length" while Buck Mason (which hems free rather than to order)
    // says "a CUSTOM, NON-FACTORY INSEAM AND HEM". Same fact, different wording —
    // asserting one exact phrase would be asserting prose, not the rule.
    assert(
      /CUSTOM[^.]{0,60}HEM/i.test(note),
      `${brand}'s chart warns that a used inseam may be a custom hem`,
    );
  }
});

Deno.test("US-1987: the vanity-sizing offsets are quantified, not hand-waved", () => {
  // 00466's BDG/Bullhead rule ("the label is not the body waist"), one axis
  // larger — and here it is QUANTIFIED, which is what makes it usable rather than
  // a vibe. Peter Millar's is exactly regular (+1.5in across the run); Faherty's
  // is ~2-2.5in AND COMPRESSES at the top, which a linear rule would miss.
  const pm = findSizingCharts("Peter Millar", "pant")[0].note ?? "";
  assert(
    /TAG SIZE \+ 1\.5in/i.test(pm.replace(/\s+/g, " ")),
    "PM's chart gives the offset as a checkable rule",
  );

  const fah = (findSizingCharts("Faherty", "pant")[0].note ?? "").replace(
    /\s+/g,
    " ",
  );
  assert(
    /~2-2\.5in SMALLER/i.test(fah),
    "Faherty's chart quantifies its vanity offset",
  );
  assert(
    /COMPRESSES AT THE TOP/i.test(fah),
    "and says the offset is NOT linear, which a naive rule would get wrong",
  );
});

Deno.test("US-1987: the brands' own chart errors are reproduced, not silently fixed", () => {
  // Three of these brands publish charts with genuine discontinuities. The
  // instinct is to interpolate them away; that would invent measurements and
  // hide a signal that the chart itself is unreliable at that point. Each note
  // flags it and sends the reader to the garment instead.
  const vv = (findSizingCharts("Vineyard Vines", "polo")[0].note ?? "").replace(
    /\s+/g,
    " ",
  );
  assert(
    /WAIST progression is DISCONTINUOUS/i.test(vv),
    "VV's men's chart flags its own waist gap",
  );
  assert(
    /do not interpolate it away/i.test(vv),
    "and forbids smoothing it",
  );

  const jo = (findSizingCharts("Johnnie-O", "polo")[0].note ?? "").replace(
    /\s+/g,
    " ",
  );
  assert(
    /do NOT silently 'fix' it/i.test(jo),
    "Johnnie-O's chart forbids fixing its XXL→XXXL gap",
  );

  // UNTUCKit's is the strongest version: an impossible cell (XXL and XXXL both at
  // chest 48-50) is OMITTED rather than guessed at.
  const ut = findSizingCharts("UNTUCKit", "shirt").find((c) =>
    c.department === "Men"
  )!;
  assert(
    /XXXL CHEST CELL IS DELIBERATELY OMITTED/i.test(
      (ut.note ?? "").replace(/\s+/g, " "),
    ),
    "UNTUCKit's chart omits the impossible chest cell",
  );
  const xxxl = ut.rows.find((r) => r.size === "XXXL")!;
  assertEquals(
    xxxl.measurements.chest,
    undefined,
    "the suspect XXXL chest is genuinely absent from the row, not just discussed",
  );
});

Deno.test("US-1987: Johnnie-O's Tweener Button is a brand fact, NOT a fingerprint", () => {
  // THE SHARPEST "REAL BUT NOT VISIBLE" CASE IN THE KB. The Tweener Button is
  // genuinely patented (US9538791B2) and genuinely trademarked (reg. 4633112) —
  // and it is INVISIBLE IN A PHOTO BY DESIGN, because concealment is literally
  // the patent's purpose. Seeding it as a visual fingerprint would produce
  // confident FALSE NEGATIVES on genuine garments (invisible → "not Johnnie-O").
  //
  // And the folklore it replaces is worse than useless: there is NO "hangover
  // collar", it is not a snap, and it is not on the collar.
  const block = brandPackPromptBlock(
    pack("Johnnie-O", "johnnieo", [
      style(
        "Tweener Button®",
        "Brand detail",
        "⚠ **THERE IS NO \"HANGOVER COLLAR\" AND IT IS NOT A SNAP AND IT IS NOT ON THE COLLAR.** A small INTERMEDIATE BUTTON concealed inside a FLY-FRONT SEGMENT of the placket. ⚠ **IT IS INVISIBLE IN A PHOTO BY DESIGN.** POSITIVE-EVIDENCE-ONLY: seeing it is weak-positive, NOT seeing it means NOTHING. ⚠ AND IT IS ABSENT FROM THE ORIGINAL 4-BUTTON POLO.",
      ),
    ]),
  );
  assert(
    /INVISIBLE IN A PHOTO BY DESIGN/i.test(block),
    "the invisibility must reach the prompt or the model will look for it",
  );
  assert(
    /POSITIVE-EVIDENCE-ONLY/i.test(block),
    "and the never-use-it-as-a-negative rule must reach it too",
  );
  assert(
    /NO "HANGOVER COLLAR"/i.test(block),
    "the folklore is refused explicitly, not merely omitted",
  );
});

Deno.test("US-1987: Buck Mason's Made-in-USA is a PRODUCT fact, never a brand fact", () => {
  // Proven on a SINGLE collection page: the Loomstate Selvedge jeans ARE badged
  // Made in USA and the higher-volume Ford Standard / Maverick Slim on the same
  // page are NOT. So the brand-level inference is wrong on exactly the garments
  // that arrive most — and "Japanese denim" names the MILL, not the sewing
  // country. This is a legally-sensitive claim, so it must reach the prompt.
  const block = brandPackPromptBlock(
    pack("Buck Mason", "buckmason", [
      style(
        "Made in USA VARIES BY PRODUCT — read the tag",
        "Origin rule",
        "⚠ origin is a **PRODUCT-level fact, never a brand-level one**. The Loomstate Selvedge jeans ARE badged Made in USA while the Ford Standard and Maverick Slim, same page, are NOT. ⚠ **\"JAPANESE DENIM\" NAMES THE MILL, NOT THE SEWING COUNTRY**. Never infer origin from the brand, the mill name, or the marketing.",
      ),
    ]),
  );
  assert(
    /PRODUCT-level fact, never a brand-level one/i.test(block),
    "the origin rule must reach the extract prompt",
  );
  assert(
    /NAMES THE MILL, NOT THE SEWING COUNTRY/i.test(block),
    "and the Japanese-denim conflation must be refused there",
  );
});

Deno.test("US-1987: the parent brands never claim their premium siblings", () => {
  // The AGOLDE / Hollister rule, three ways — and each fold would be expensive in
  // a DIFFERENT direction:
  //   • Todd Snyder is AMERICAN EAGLE's (00458). Folding it prices a $1,498
  //     cashmere chore coat against $50 mall jeans.
  //   • G/FORE was a Peter Millar SUBSIDIARY 2018-2025 and is now a SEPARATE
  //     Richemont Maison. Either way it is a different brand with its own tags.
  //   • AYR launched UNDER Bonobos and became INDEPENDENT — the Modern Amusement
  //     rule: a line's origin is not ownership forever.
  assertEquals(canonicalizeBrand("Todd Snyder"), "Todd Snyder");
  assertEquals(canonicalizeBrand("American Eagle"), "American Eagle");
  assert(
    canonicalizeBrand("Todd Snyder") !== canonicalizeBrand("American Eagle"),
    "Todd Snyder must never fold onto its American Eagle parent",
  );

  // G/FORE and AYR must stay passthrough — being NEAR a curated brand is not
  // being it, and a wrong fold is worse than a passthrough.
  assert(!isKnownBrand("G/FORE"), "G/FORE must not fold onto Peter Millar");
  assert(!isKnownBrand("gfore"), "nor via its unpunctuated spelling");
  assert(!isKnownBrand("AYR"), "AYR must not fold onto Bonobos");

  // Brooks Brothers and Lucky Brand (00466) now share a parent (Catalyst Brands)
  // and must still be two canonicals — the parent company never decides a fold.
  assert(
    canonicalizeBrand("Brooks Brothers") !== canonicalizeBrand("Lucky Brand"),
    "a shared parent (Catalyst) never merges two brands",
  );
});

Deno.test("US-1987: Bonobos' Weekday Warrior is the only colourway convention seeded", () => {
  // THE COLOURWAY RULE, and why exactly one row survived it. Eight of these nine
  // brands name colours evocatively (Bonobos alone ships "Brownstones", "Clean
  // Slates", "Bluechippers") and NONE of it is seeded: it is per-season, per-SKU
  // marketing copy, interleaved with plain descriptors on the SAME product, so a
  // seeded LIST both rots and licenses a model to confirm any plausible
  // invention. The Weekday Warrior is a CONVENTION, not a list — and the day is
  // EMBROIDERED INSIDE THE WAISTBAND, so the garment can still prove it after the
  // hangtag is gone. That is the distinction that decides seeding.
  const block = brandPackPromptBlock(
    pack("Bonobos", "bonobos", [
      style(
        "Stretch Weekday Warrior Dress Pant",
        "Signature",
        "**THE DAY OF THE WEEK IS EMBROIDERED INSIDE THE WAISTBAND**, alongside a branded interior button. The colourway IS a weekday (Monday Steel Blue, Tuesday Black, Wednesday Micro Olive Houndstooth, Thursday True Khaki, Friday Steel).",
      ),
    ]),
  );
  assert(
    /EMBROIDERED INSIDE THE WAISTBAND/i.test(block),
    "the one colour fact tied to a physical feature reaches the prompt",
  );
});

Deno.test("US-1987: the group's charts are reachable per brand + category", () => {
  const cases: Array<[string, string]> = [
    ["Vineyard Vines", "polo"],
    ["Vineyard Vines", "dress"],
    ["Brooks Brothers", "dress shirt"],
    ["Brooks Brothers", "suit"],
    ["Bonobos", "chino"],
    ["Faherty", "flannel"],
    ["Faherty", "pant"],
    ["Faherty", "dress"],
    ["Peter Millar", "polo"],
    ["Peter Millar", "pant"],
    ["Todd Snyder", "blazer"],
    ["Buck Mason", "tee"],
    ["UNTUCKit", "shirt"],
    ["Johnnie-O", "polo"],
  ];
  for (const [brand, category] of cases) {
    const charts = findSizingCharts(canonicalizeBrand(brand), category);
    assert(
      charts.some((c) => c.brand === brand),
      `${brand} + ${category} resolves ${brand}'s own chart, not a generic one`,
    );
  }

  // Every brand in the group must reach SOME brand-specific chart rather than
  // silently falling through to the generic tables — the failure mode this whole
  // pack exists to prevent. Note this holds even for Todd Snyder and Buck Mason,
  // whose charts carry a SYSTEM rather than measurements: a system-only chart is
  // still strictly better than a generic alpha table, because it tells the model
  // which question it is answering.
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

Deno.test("US-1987: a short/ordinary brandMatch token is never in the chart table", () => {
  // The US-1735 bug, guarded directly. findSizingCharts matches brandMatch as a
  // LEADING-word substring, so any of these would leak onto an unrelated brand:
  //   • "buck"   → Buck Knives.
  //   • "todd" / "peter" / "millar" → ordinary given names/surnames.
  //   • "crown"  → an ordinary word this product's own copy emits.
  // All are reachable via their canonical, which is what brand-knowledge.ts
  // passes in anyway.
  //
  // ⚠ "brooks" IS DELIBERATELY NOT BANNED (US-1990). Brooks RUNNING (a Berkshire
  // Hathaway company) is now a sized brand in its own right and its charts must
  // carry "brooks" so a "Brooks" brand field reaches them. The invariant the ban
  // used to protect — a BROOKS BROTHERS garment must not get the running charts,
  // and vice versa — now holds structurally: BB charts carry the LONGER
  // "brooks brothers" (which "brooks" does not match), and category narrowing
  // keeps a shirt off a footwear chart. That specific invariant is asserted below.
  const banned = new Set([
    "buck",
    "mason",
    "todd",
    "snyder",
    "peter",
    "millar",
    "crown",
    "vineyard",
    "legend",
    "movement",
  ]);
  for (const c of SIZING_CHARTS) {
    for (const m of c.brandMatch) {
      assert(
        !banned.has(m),
        `chart ${c.brand} must not carry the brandMatch token "${m}"`,
      );
    }
  }

  // The precise Brooks invariant (US-1990): a Brooks BROTHERS chart must never
  // carry the bare "brooks" token (that would hand a Brooks Running shoe the BB
  // dress charts — the US-1735 hazard), while the Brooks RUNNING charts must.
  for (const c of SIZING_CHARTS) {
    if (c.brand === "Brooks Brothers") {
      assert(
        !c.brandMatch.includes("brooks"),
        `Brooks Brothers chart must not carry the bare "brooks" token`,
      );
    }
  }
  assert(
    SIZING_CHARTS.some(
      (c) => c.brand === "Brooks" && c.brandMatch.includes("brooks"),
    ),
    "the Brooks RUNNING charts must carry the bare 'brooks' token to be reachable",
  );

  // The prior groups' exclusions must still hold (the sets are shared).
  assertEquals(
    detectBrandInText("Nike tee, free express shipping, size M"),
    "Nike",
    "00466's Express exclusion still holds",
  );
  assertEquals(
    detectBrandInText("Gap puffer jacket, 800 fill power loft, mens"),
    "Gap",
    "00466's LOFT exclusion still holds",
  );
});

Deno.test("US-1987: no block invites a code transcription for a refused brand", () => {
  // The pack has ONE decoder (Peter Millar) and EIGHT refusals. A fingerprint
  // that name-drops a refused brand's code would coach the model to transcribe
  // something the resolver deliberately cannot use — the codes are inert, and a
  // prompt that asks for one manufactures a false expectation.
  const block = brandPackPromptBlock(
    pack("Buck Mason", "buckmason", [
      style(
        "Slub vs Pima Curved Hem Tee",
        "Signature",
        "⚠ THEY ARE NOT PHOTOGRAPHICALLY SEPARABLE FROM EACH OTHER. The ONLY difference is YARN TEXTURE. ⚠ 'SLUB' AND 'PIMA' ARE GENERIC TEXTILE TERMS, not Buck Mason technology.",
      ),
    ]),
  );
  assert(
    !/style code|style number|B007|D018|BM11001/i.test(block),
    "Buck Mason's block must not invite a code transcription",
  );
  // The generic-terms warning is the load-bearing half here: "slub" in a listing
  // title is NOT brand evidence for Buck Mason, and a model will assume it is.
  assert(
    /GENERIC TEXTILE TERMS/i.test(block),
    "the slub/pima-are-not-proprietary rule must reach the prompt",
  );
});
