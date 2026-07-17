// US-1991: verify the intimates/loungewear/shapewear content (migration 00471)
// is correct + consumable by the engine.
//
// SKIMS, Spanx, Victoria's Secret, PINK, Aerie, Savage X Fenty, Calvin Klein,
// Tommy John. Six were passthrough-only; Calvin Klein is PROMOTED from its shallow
// 00389 shell; Aerie and PINK are the two sub-brand calls.
//
// What binds the group: THE FIT + THE SIZE SYSTEM IS THE PRODUCT, and the size
// system is NOT one system. The assertions below protect the four things that
// follow:
//
//   1. The size charts carry THREE incompatible systems (BRA band+cup, SHAPEWEAR
//      alpha, APPAREL/underwear alpha/waist) — the story's stated key signal —
//      reachable for every brand across its categories, with the cup-difference
//      math written into the note.
//   2. ZERO DECODERS — none of the eight prints a code that clears the bar; the
//      candidates (Calvin Klein U-number, Spanx style number) are refused.
//   3. AERIE is PROMOTED to its own canonical (out of the US-1739 American Eagle
//      fold) and is never minted from prose (an eagle's nest).
//   4. PINK is its own canonical (NOT Victoria's Secret) and is never minted from
//      prose (an ordinary colour word).
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

const GROUP = [
  "SKIMS",
  "Spanx",
  "Victoria's Secret",
  "PINK",
  "Aerie",
  "Savage X Fenty",
  "Calvin Klein",
  "Tommy John",
];

function style(
  styleName: string,
  productLine: string,
  visualFingerprint: string,
): BrandStyleKnowledge {
  return {
    styleName,
    aliases: [],
    productLine,
    department: "Women",
    category: "shapewear",
    visualFingerprint,
    fabricTech: [],
    era: null,
    msrpBand: null,
    keywords: [],
  };
}

function pack(
  brand: string,
  key: string,
  styles: BrandStyleKnowledge[],
): BrandKnowledgePack {
  return {
    brand,
    key,
    known: true,
    aliases: [],
    categoryFocus: ["intimates"],
    authenticationTells: [],
    tagEras: [],
    styles,
    decoders: [],
    colorways: [],
    sizingCharts: [],
    source: "db",
  };
}

function migrationSql(): string {
  return Deno.readTextFileSync(
    new URL(
      "../../../../supabase/migrations/00471_intimates_loungewear_shapewear_brand_knowledge.sql",
      import.meta.url,
    ),
  );
}

Deno.test("US-1991: the intimates group aliases canonicalize", () => {
  for (const brand of GROUP) {
    assertEquals(
      canonicalizeBrand(brand.toLowerCase()),
      brand,
      `${brand} canonicalizes from a lowercase tag`,
    );
    assert(isKnownBrand(brand), `${brand} is a curated entry, not a passthrough`);
  }

  // The sub-lines / spellings / short forms a seller is likely to type.
  assertEquals(canonicalizeBrand("victoriasecret"), "Victoria's Secret"); // single-s misspelling
  assertEquals(canonicalizeBrand("Spanx Inc"), "Spanx");
  assertEquals(canonicalizeBrand("CK"), "Calvin Klein");
  assertEquals(canonicalizeBrand("Calvin Klein Jeans"), "Calvin Klein"); // a line folds
  assertEquals(canonicalizeBrand("Savage X"), "Savage X Fenty");
  assertEquals(canonicalizeBrand("Tommy John Underwear"), "Tommy John");
});

Deno.test("US-1991: AERIE is promoted to its own canonical (reversing the US-1739 fold)", () => {
  // The US-1739 mall fold onto American Eagle is superseded for intimates: eBay
  // has a first-class "Aerie" brand and it comps on its own ladder.
  assertEquals(
    canonicalizeBrand("aerie"),
    "Aerie",
    "a bare 'aerie' now resolves to Aerie, NOT American Eagle",
  );
  assertEquals(canonicalizeBrand("Aerie"), "Aerie");
  assert(isKnownBrand("Aerie"), "Aerie is a curated entry, reachable by tag");
  assert(
    canonicalizeBrand("aerie") !== "American Eagle",
    "the US-1739 fold onto American Eagle is reversed",
  );
  // OFFLINE (Aerie's activewear line) folds onto Aerie; a bare "offline" does not.
  assertEquals(canonicalizeBrand("OFFLINE by Aerie"), "Aerie");
  // American Eagle's OWN store forms still resolve to American Eagle.
  assertEquals(canonicalizeBrand("American Eagle Outfitters"), "American Eagle");

  // "aerie" is an ordinary noun (an eagle's nest) — reachable by TAG, never minted
  // from prose (it is now on the prose-scan path for the first time).
  assertEquals(
    detectBrandInText("cotton tee with an aerie of birds printed on the chest"),
    null,
    "'aerie' in free text must not mint the brand",
  );
  assertEquals(
    detectBrandInText("a keen eye — Nike windbreaker, aerie of hawks graphic, large"),
    "Nike",
    "the real brand wins; 'aerie' in prose is never guessed",
  );
});

Deno.test("US-1991: PINK is its own canonical (NOT Victoria's Secret) and never minted from prose", () => {
  assertEquals(
    canonicalizeBrand("PINK"),
    "PINK",
    "a 'PINK' tag resolves to the PINK brand",
  );
  assert(isKnownBrand("PINK"), "PINK is a curated entry, reachable by tag");
  // The compound forms fold onto PINK (the sub-brand), not Victoria's Secret.
  assertEquals(canonicalizeBrand("Victoria's Secret PINK"), "PINK");
  assertEquals(canonicalizeBrand("VS PINK"), "PINK");
  assert(
    canonicalizeBrand("PINK") !== "Victoria's Secret",
    "PINK must not fold onto Victoria's Secret (the Hollister rule)",
  );
  // Victoria's Secret itself still resolves to its own canonical.
  assertEquals(canonicalizeBrand("Victoria's Secret"), "Victoria's Secret");

  // "pink" is an ordinary colour word — reachable by TAG, never minted from prose.
  assertEquals(
    detectBrandInText("dusty pink floral blouse, size M"),
    null,
    "an ordinary colour 'pink' in prose must not mint the brand",
  );
  assertEquals(
    detectBrandInText("Nike running shorts, hot pink accents, size L"),
    "Nike",
    "the real brand wins; 'pink' in prose is never guessed",
  );
  // But Victoria's Secret (not excluded) IS detectable from a title.
  assertEquals(
    detectBrandInText("Victoria's Secret Bombshell push-up bra 34B"),
    "Victoria's Secret",
    "'Victoria's Secret' still resolves from prose",
  );
});

Deno.test("US-1991: every brand's size charts are reachable across its categories", () => {
  const cases: Array<[string, string]> = [
    ["SKIMS", "shapewear"],
    ["Spanx", "legging"],
    ["Victoria's Secret", "bra"],
    ["PINK", "hoodie"],
    ["Aerie", "legging"],
    ["Savage X Fenty", "bra"],
    ["Calvin Klein", "boxer brief"],
    ["Tommy John", "underwear"],
  ];
  for (const [brand, category] of cases) {
    const charts = findSizingCharts(brand, category);
    assert(charts.length > 0, `${brand} must reach a chart for "${category}"`);
  }
});

Deno.test("US-1991: the BRA charts are BAND+CUP translators (the story's key signal)", () => {
  // ⚠ THE HARD SIGNAL: a bra size is TWO axes and the cup-difference math lives in
  // the note (where formatSizingChartsForPrompt renders it).
  const vsBra = findSizingCharts("Victoria's Secret", "bra")[0];
  assert(
    /Band 3\d/.test(vsBra.rows[0].size),
    "the VS bra chart labels carry the BAND number",
  );
  assert(
    /CUP letter is RELATIVE/i.test(vsBra.note ?? "") &&
      /sister sizes/i.test(vsBra.note ?? ""),
    "the VS bra note explains the cup = bust-minus-band math + sister sizes",
  );
  assert(
    /BOMBSHELL ADDS TWO CUP SIZES/i.test(vsBra.note ?? ""),
    "the VS bra note carries the Bombshell add-2-cups caveat",
  );

  // Savage X Fenty — the INCLUSIVE band+cup translator (30A-46DDD).
  const savageBra = findSizingCharts("Savage X Fenty", "bra")[0];
  assert(
    /SIZE-INCLUSIVE/i.test(savageBra.note ?? "") &&
      /Band 46/.test(savageBra.rows.map((r) => r.size).join(" ")),
    "the Savage X bra chart is the inclusive band+cup translator up to Band 46",
  );

  // SKIMS shapewear — size-inclusive + compressive (size to the body).
  const skims = findSizingCharts("SKIMS", "shapewear")[0];
  assert(
    /SIZE-INCLUSIVE/i.test(skims.note ?? "") && /COMPRESSIVE/i.test(skims.note ?? ""),
    "the SKIMS note states size-inclusive + compressive (size to the body)",
  );

  // Calvin Klein men's underwear — the logo waistband is the grade.
  const ck = findSizingCharts("Calvin Klein", "boxer brief")[0];
  assert(
    /LOGO WAISTBAND IS THE PRODUCT/i.test(ck.note ?? ""),
    "the CK men's underwear note carries the logo-waistband grade rule",
  );
});

Deno.test("US-1991: the style fingerprint reaches the extract prompt", () => {
  // brandPackPromptBlock renders visual_fingerprint VERBATIM (US-1740). For
  // intimates the highest-value fingerprint is the fabric LINE + fit cue.
  const skims = brandPackPromptBlock(
    pack("SKIMS", "skims", [
      style(
        "Fits Everybody",
        "Solutionwear",
        "⚠ Separable from Soft Lounge by the FIRMER, seamless second-skin hand vs Soft Lounge's drapey modal.",
      ),
    ]),
  );
  assert(
    /seamless second-skin hand/i.test(skims),
    "SKIMS' Fits-Everybody fingerprint must render verbatim into the prompt",
  );

  const vs = brandPackPromptBlock(
    pack("Victoria's Secret", "victoriassecret", [
      style(
        "Bombshell",
        "Push-up bra",
        "THE add-2-cup-sizes push-up bra whose labelled size runs SMALL on volume.",
      ),
    ]),
  );
  assert(
    /add-2-cup-sizes push-up/i.test(vs),
    "the VS Bombshell add-2-cups fingerprint must reach the prompt",
  );
});

Deno.test("US-1991: ZERO decoders, and every refusal is recorded", () => {
  const sql = migrationSql();
  assert(
    /ZERO DECODERS/i.test(sql),
    "the migration must record that no decoder clears the bar",
  );
  // The coded candidates are refused, each with its reason.
  assert(
    /CALVIN KLEIN underwear style numbers|NB1476/i.test(sql),
    "the Calvin Klein U-number refusal must be recorded",
  );
  assert(
    /SPANX style numbers|Spanx style number/i.test(sql),
    "the Spanx style-number refusal must be recorded",
  );
  assert(
    /A BRA SIZE IS NOT A STYLE CODE/i.test(sql),
    "the migration must record that a bra size is captured by the charts, not a decoder",
  );
});

Deno.test("US-1991: NO RN is seeded, and tag_eras are documented vs empty by design", () => {
  const sql = migrationSql();
  assert(
    /NONE ARE SEEDED/i.test(sql),
    "the migration must record that RN is refused, not merely absent",
  );
  // The two brands with a genuine vintage chronology carry tag_eras; the six modern
  // brands do not.
  assert(
    /Gold Label/i.test(sql) && /90s Calvin Klein|one-logo/i.test(sql),
    "the VS Gold Label + vintage CK tag-era priors must be seeded",
  );
  assert(
    /EMPTY for the six modern|TAG ERAS EMPTY ON PURPOSE/i.test(sql),
    "the modern brands' empty tag_eras must be recorded as a deliberate call",
  );
});

Deno.test("US-1991: Calvin Klein is promoted from its shallow 00389 shell", () => {
  const sql = migrationSql();
  assert(
    /PROMOTED from the shallow 00389/i.test(sql),
    "the migration must record the Calvin Klein promotion",
  );
  // The promoted pack carries the intimates category focus + the logo-waistband
  // authentication tell.
  assert(
    /LOGO-WAISTBAND boxer briefs/i.test(sql),
    "the promoted CK pack must carry the underwear/logo-waistband identity",
  );
});
