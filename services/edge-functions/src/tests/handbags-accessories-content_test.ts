// US-1988: verify the handbags & accessories content (migration 00468) is
// correct + consumable by the engine.
//
// All nine brands were passthrough-only before this pack. What the assertions
// below protect is the four things this group has that no prior pack did — and
// they all follow from ONE category shift, because this is the KB's first
// ACCESSORY-FIRST group (00443..00467 all graded GARMENTS):
//
//     A BAG CARRIES LESS RECOVERABLE INFORMATION ON ITS BODY THAN A GARMENT.
//
//   1. RN IS A CATEGORY ERROR HERE, NOT A RESEARCH FAILURE. Handbags/luggage are
//      excluded from FTC textile labeling, so there is no RN to find. Prior packs
//      recorded an ACCESS excuse ("the FTC DB is a JS shell"); the real reason is
//      statutory. And the exemption is PROVEN BY ITS EXCEPTION: Marc Jacobs is
//      the only brand here with an RN, and only because it sells RTW.
//   2. THE STYLE CODE IS NOT ON THE BAG — IT LEFT WITH THE HANGTAG. Checkable
//      against our OWN KB rather than merely asserted: Coach (00398) SEWS a creed
//      patch carrying the style number INTO the bag and got a decoder. A bag CAN
//      carry a code; these nine do not.
//   3. ONE DECODER — FOSSIL — AND IT IS THE ONLY BRAND HERE THAT ISN'T A BAG. Its
//      code is on a METAL CASE BACK, which is the pack's cut-tag case.
//   4. THE PACK'S HEADLINE REFUSAL IS AN RN THAT EXISTS AND IS THE WRONG COMPANY.
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
const { findSizingCharts } = await import("../lib/sizing-charts.ts");
const { canonicalizeBrand, isKnownBrand, detectBrandInText } = await import(
  "../lib/brand-normalize.ts"
);
import type {
  BrandKnowledgePack,
  BrandStyleKnowledge,
} from "../lib/brand-knowledge.ts";

const GROUP = [
  "Longchamp",
  "Marc Jacobs",
  "Rebecca Minkoff",
  "Fossil",
  "Vera Bradley",
  "Dooney & Bourke",
  "Brahmin",
  "Tumi",
  "Herschel Supply Co.",
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
    category: "bag",
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
    categoryFocus: ["handbags"],
    authenticationTells: [],
    tagEras: [],
    styles,
    decoders: [],
    colorways: [],
    sizingCharts: [],
    source: "db",
  };
}

Deno.test("US-1988: the handbags/accessories aliases canonicalize", () => {
  for (const brand of GROUP) {
    assertEquals(
      canonicalizeBrand(brand.toLowerCase()),
      brand,
      `${brand} canonicalizes from a lowercase tag`,
    );
    assert(isKnownBrand(brand), `${brand} is a curated entry, not a passthrough`);
  }

  // The SUB-LINES and product names that are often the only string a seller can
  // read. Le Pliage and Roseau are Longchamp LINES; Roseau is NOT a Le Pliage,
  // but both resolve to the house.
  assertEquals(canonicalizeBrand("Le Pliage"), "Longchamp");
  assertEquals(canonicalizeBrand("Roseau"), "Longchamp");
  assertEquals(canonicalizeBrand("All Weather Leather"), "Dooney & Bourke");
  assertEquals(canonicalizeBrand("Alpha Bravo"), "Tumi");
  assertEquals(canonicalizeBrand("Little America"), "Herschel Supply Co.");

  // The misspellings these brands actually attract.
  assertEquals(canonicalizeBrand("Longchamps"), "Longchamp"); // the racecourse is singular
  assertEquals(canonicalizeBrand("Mark Jacobs"), "Marc Jacobs");
  assertEquals(canonicalizeBrand("Hershel"), "Herschel Supply Co.");
  assertEquals(canonicalizeBrand("Vera Bradly"), "Vera Bradley");
  assertEquals(canonicalizeBrand("Dooney & Burke"), "Dooney & Bourke");

  // ⚠ THE AMPERSAND TRAP, AND IT IS NOT A DUPLICATE LINE: brandKey() STRIPS "&"
  // but KEEPS a spelled-out "and", so these are genuinely DIFFERENT keys
  // (dooneybourke vs dooneyandbourke) and sellers type both. The Rag & Bone case.
  for (const spelling of [
    "Dooney & Bourke",
    "Dooney and Bourke",
    "DOONEY & BOURKE",
    "dooney",
  ]) {
    assertEquals(
      canonicalizeBrand(spelling),
      "Dooney & Bourke",
      `${spelling} lands on the one canonical`,
    );
  }
});

Deno.test("US-1988: the alias refusals hold — four collisions stay unmapped", () => {
  // 1. A BARE "minkoff" IS NOT REBECCA MINKOFF. Uri Minkoff is a DISTINCT LABEL
  //    (his own collection page, his own Poshmark brand node), so folding the
  //    surname would mis-brand his menswear. The AYR rule from 00467.
  assertEquals(
    canonicalizeBrand("Minkoff"),
    "Minkoff",
    "a bare 'Minkoff' passes through — it may be Uri Minkoff",
  );
  assert(!isKnownBrand("Minkoff"), "a bare 'Minkoff' must NOT be a curated entry");
  assert(
    !isKnownBrand("Uri Minkoff"),
    "Uri Minkoff must not resolve to Rebecca Minkoff",
  );

  // 2. A BARE "RM" IS NOT MAPPED — real collector shorthand, but a 2-letter key
  //    is the worst possible false positive and it is not brand-unique.
  assert(!isKnownBrand("RM"), "a bare 'RM' must not resolve to Rebecca Minkoff");

  // 3. "D&B" IS A FOUR-WAY COLLISION — Dun & Bradstreet, Dolce & Gabbana in some
  //    seller usage, Dooney's OWN reversed-D monogram, and Dooney's SKU prefix.
  assert(!isKnownBrand("D&B"), "a bare 'D&B' must not resolve to Dooney & Bourke");
  assert(!isKnownBrand("DB"), "a bare 'DB' must not resolve to Dooney & Bourke");

  // 4. FOSSIL GROUP-OWNED BRANDS MUST NOT FOLD ONTO FOSSIL. Fossil's own 10-K
  //    lists SKAGEN/MICHELE/RELIC/ZODIAC as OWNED brands (Skagen is OWNED, not
  //    licensed — a common error), but a shared corporate parent is not a shared
  //    brand. This is the Todd Snyder / American Eagle rule from 00467.
  for (const sibling of ["Skagen", "Relic", "Zodiac", "Michele"]) {
    assert(
      canonicalizeBrand(sibling) !== "Fossil",
      `${sibling} is Fossil GROUP-owned but is NOT the Fossil brand`,
    );
  }

  // And the LICENSED brands, which are ~47% of Fossil Group's output. Michael
  // Kors is ALREADY a canonical here — folding it would be actively destructive.
  assertEquals(
    canonicalizeBrand("Michael Kors"),
    "Michael Kors",
    "a Fossil-MADE Michael Kors watch is a MICHAEL KORS watch",
  );

  // "Marc by Marc Jacobs" is a SEPARATE node, not an alias — different line,
  // different era, different price band. And the mark was RE-FILED in Jun 2026.
  assertEquals(canonicalizeBrand("Marc by Marc Jacobs"), "Marc by Marc Jacobs");
  assertEquals(canonicalizeBrand("MBMJ"), "Marc by Marc Jacobs");
});

Deno.test("US-1988: 'Fossil' is never minted out of free text", () => {
  // "fossil" is an ordinary English noun, and unlike MOTHER/FRAME the false
  // positives are a different DOMAIN entirely. The sharpest case is internal: the
  // KB's OWN seeded prose for Arc'teryx (00453) describes its logo as "a fossil
  // skeleton", so a prose scan can mint "Fossil" off an Arc'teryx description.
  //
  // Note what the FIRST case actually proves, and it is stronger than a bare
  // null: the REAL brand still wins the string. Without the exclusion, "Fossil"
  // (6 chars) would compete with "Arc'teryx" (9) under longest-first ordering on
  // a description the KB itself authored.
  assertEquals(
    detectBrandInText("Arc'teryx Beta AR jacket — the logo is a fossil skeleton"),
    "Arc'teryx",
    "the KB's own Arc'teryx prose resolves to Arc'teryx, never to Fossil",
  );
  assertEquals(
    detectBrandInText("vintage fossil fuel company promo tee, size L"),
    null,
    "'fossil fuel' must not mint the watch brand",
  );

  // But the brand stays fully reachable BY TAG — which is what the eBay Brand
  // aspect and the comp filter actually read. Reachable, never guessed.
  assertEquals(canonicalizeBrand("Fossil"), "Fossil");
  assert(isKnownBrand("Fossil"), "Fossil stays a curated entry, reachable by tag");
});

Deno.test("US-1988: the NON-SEPARABILITY warnings reach the extract prompt", () => {
  // WHY THESE ARE FINGERPRINTS AND NOT TELLS: brandPackPromptBlock renders
  // visual_fingerprint VERBATIM but collapses every authentication tell to ONE
  // GENERIC LINE (US-1740). In a pack of BAGS, "you cannot tell these two apart
  // from a photo" is the single most decision-relevant thing we know — an
  // un-warned model will confidently name any quilted crossbody, because the
  // names are in its weights.

  // THE HERSCHEL CASE IS THE SHARPEST: the OBVIOUS discriminator is WRONG. Both
  // the Little America and the Retreat are, verbatim, "Easy U-pull drawcord
  // closure" + "Magnet fastened straps with metal pin buckles" — so a rule keyed
  // on "magnetic snap ⇒ Little America" MISFIRES on the Retreat.
  const herschel = brandPackPromptBlock(
    pack("Herschel Supply Co.", "herschelsupplyco", [
      style(
        "Little America",
        "Heritage",
        '⚠ **LITTLE AMERICA AND RETREAT ARE *NOT* SEPARABLE BY CLOSURE OR STRAP HARDWARE.** Both are "Easy U-pull drawcord closure" + "Magnet fastened straps with metal pin buckles". THE REAL CUES: a TOP-LID ZIPPER (Retreat has none) and the DEEPEST (7.09in) profile. ⚠ CAPACITY IS NOT AN IDENTIFIER — 30L today, 25L on older stock; both genuine.',
      ),
    ]),
  );
  assert(
    /NOT\* SEPARABLE BY CLOSURE OR STRAP HARDWARE/i.test(herschel),
    "Herschel's wrong-discriminator warning must render verbatim into the prompt",
  );
  assert(
    /CAPACITY IS NOT AN IDENTIFIER/i.test(herschel),
    "the capacity-drifts-by-era rule must reach the prompt",
  );

  // THE REBECCA MINKOFF CASE: Love vs Edie are BOTH chevron-quilted, so quilting
  // cannot separate them — the discriminator is HARDWARE, and if it is not in
  // frame the model must return ambiguous rather than guess.
  const rm = brandPackPromptBlock(
    pack("Rebecca Minkoff", "rebeccaminkoff", [
      style(
        "Love Crossbody",
        "Love (discontinued)",
        '⚠ **NOT PHOTO-SEPARABLE FROM THE EDIE ON QUILTING ALONE.** Both are CHEVRON-QUILTED. The discriminator is HARDWARE: **LOVE = CHAIN STRAP + the "love" SCRIPT PLAQUE; EDIE = DOG-CLIP closure.** If the plaque and hardware are not visible in frame, RETURN AMBIGUOUS — do not guess.',
      ),
    ]),
  );
  assert(
    /NOT PHOTO-SEPARABLE FROM THE EDIE ON QUILTING ALONE/i.test(rm),
    "the Love/Edie confusable pair must render verbatim into the prompt",
  );
  assert(
    /RETURN AMBIGUOUS/i.test(rm),
    "the abstain instruction must reach the prompt",
  );

  // THE FOSSIL CASE: the licensed-brand hazard is ~47% of Fossil Group's output.
  const fossil = brandPackPromptBlock(
    pack("Fossil", "fossil", [
      style(
        "Carlie",
        "Fossil watches",
        "⚠ **CARLIE vs CARLIE MINI IS NOT PHOTO-SEPARABLE** — identical design, differing only in case diameter, and fossil.com itself indexes the SAME code ES5331 under BOTH titles. **READ THE CASE-BACK CODE — the code is reliable, the name is not.**",
      ),
    ]),
  );
  assert(
    /READ THE CASE-BACK CODE/i.test(fossil),
    "the code-beats-the-name rule must reach the prompt",
  );
});

Deno.test("US-1988: the LONGCHAMP RN TRAP is recorded — RN 17257 is not Longchamp", () => {
  // THE PACK'S HEADLINE REFUSAL, and the exact failure mode the sourcing policy
  // exists to prevent: a REAL FEDERAL RECORD, the RIGHT BRAND STRING, and
  // COMPLETELY THE WRONG COMPANY. The FTC register returns exactly one hit for
  // "longchamp" — RN 17257, LONGCHAMP FABRICS CORP, a garment-district FABRIC
  // WHOLESALER at 1412 Broadway. The maison's registrant (S.A.S. Jean Cassegrain)
  // has none, and handbags are outside the Textile Act anyway.
  //
  // The assertion is structural: the pack must carry NO registered_numbers for
  // Longchamp. A future "improvement" that scrapes the register for the brand
  // string and ingests the hit turns this red.
  const sql = Deno.readTextFileSync(
    new URL(
      "../../../../supabase/migrations/00468_handbags_accessories_brand_knowledge.sql",
      import.meta.url,
    ),
  );
  assert(
    /RN 17257 EXISTS, MATCHES THE STRING "LONGCHAMP", AND IS NOT THIS COMPANY/i
      .test(sql),
    "the migration must record WHY Longchamp has no RN — the trap, not a gap",
  );
  assert(
    /LONGCHAMP FABRICS CORP/.test(sql),
    "the colliding registrant must be named so nobody re-derives it",
  );

  // AND THE EXEMPTION IS PROVEN BY ITS EXCEPTION: Marc Jacobs is the ONLY brand
  // in this pack WITH an RN, and only because it sells READY-TO-WEAR — both of
  // its FTC records are for CLOTHING / WOMEN APPAREL, not handbags.
  assert(
    /RN 96919/.test(sql) && /RN 103927/.test(sql),
    "Marc Jacobs' two real RNs are seeded — the exception that proves the rule",
  );
  assert(
    /DO NOT EXPECT RN 96919 ON A SNAPSHOT/i.test(sql),
    "and the pack must say the RN belongs on a GARMENT, not on the bag",
  );
});

Deno.test("US-1988: every brand's charts are reachable, and the axis/unit traps are stated", () => {
  // A "size chart" here is a DIMENSION TABLE, not a body-measurement grid — the
  // first such block in the KB. findSizingCharts must still reach all nine.
  const cases: Array<[string, string]> = [
    ["Longchamp", "tote"],
    ["Marc Jacobs", "crossbody"],
    ["Rebecca Minkoff", "handbag"],
    ["Fossil", "watch"],
    ["Vera Bradley", "backpack"],
    ["Dooney & Bourke", "satchel"],
    ["Brahmin", "satchel"],
    ["Tumi", "carry-on"],
    ["Herschel Supply Co.", "backpack"],
  ];
  for (const [brand, category] of cases) {
    const charts = findSizingCharts(brand, category);
    assert(
      charts.length > 0,
      `${brand} must reach a chart for "${category}"`,
    );
  }

  // ⚠ FOSSIL'S UNIT SPLIT IS WITHIN ONE BRAND — watches in MM, bags in inches. A
  // parser that does not branch on category reads a 44MM case as 44 inches.
  const watch = findSizingCharts("Fossil", "watch")[0];
  assert(
    /MILLIMETRES/i.test(watch.garment),
    "the Fossil watch chart names its unit in `garment`",
  );
  const wallet = findSizingCharts("Fossil", "wallet")[0];
  assert(
    /INCHES/i.test(wallet.garment),
    "the Fossil wallet chart names its DIFFERENT unit in `garment`",
  );

  // ⚠ TUMI PUBLISHES H x D x W, NOT H x W x D — transcribing it the usual way
  // silently swaps depth and width.
  const tumi = findSizingCharts("Tumi", "carry-on")[0];
  assert(
    /H x D x W, NOT H x W x D/i.test(tumi.note ?? ""),
    "Tumi's axis-order trap must be stated where a sizing decision is made",
  );
  assert(
    /DO NOT ASSERT 'AIRLINE COMPLIANT'/i.test(tumi.note ?? ""),
    "and Tumi's un-sourced airline-compliance claim must be refused",
  );

  // ⚠ LONGCHAMP: match on the MODEL, never the size letter — the same reference
  // L2605 089 is sold as "M Tote", "Shoulder Bag S" AND "Shoulder Bag M".
  const longchamp = findSizingCharts("Longchamp", "tote")[0];
  assert(
    /NEVER THE SIZE LETTER/i.test(longchamp.note ?? ""),
    "Longchamp's size-name instability must be stated on the chart",
  );

  // ⚠ HERSCHEL: capacity is NOT a model identifier — a 2015 and a 2025 Little
  // America are both genuine and differently sized.
  const herschel = findSizingCharts("Herschel Supply Co.", "backpack")[0];
  assert(
    /CAPACITY IS NOT A MODEL IDENTIFIER/i.test(herschel.note ?? ""),
    "Herschel's era-drift trap must be stated on the chart",
  );

  // ⚠ REBECCA MINKOFF'S APPAREL CHART SHIPS A KNOWN BRAND TYPO ON PURPOSE: US 6
  // and US 8 both list a 39in hip. Quietly "fixing" a published number is how a
  // fabrication enters a KB, so the chart preserves it and says so.
  const rmApparel = findSizingCharts("Rebecca Minkoff", "dress")[0];
  assert(
    /NOT SILENTLY CORRECTED/i.test(rmApparel.note ?? ""),
    "the RM apparel chart preserves the brand's own typo and flags it",
  );
  const us6 = rmApparel.rows.find((r) => r.size.startsWith("6"));
  const us8 = rmApparel.rows.find((r) => r.size.startsWith("8"));
  assertEquals(
    us6?.measurements.hip,
    us8?.measurements.hip,
    "the typo is preserved as-published (both 39in) — the US-1715 queue owns the fix",
  );
});

Deno.test("US-1988: Vera Bradley's pattern axis is seeded, and NO retirement date is", () => {
  // THIS BRAND INVERTS THE PACK'S WHOLE WEIGHTING: it has NO code at all, but the
  // PATTERN is the identity and the price driver — VB protects ~1,000 COPYRIGHTS
  // on its patterns and trademarks only the NAME.
  //
  // ⚠ AND THE TRAP IS A URL THAT LIES: verabradley.com/collections/
  // retired-patterns-archive serves the CURRENT patterns landing page (its own
  // metadata reads page_handle:"patterns"; the word "retired" appears nowhere in
  // its body). An agent trusting the slug seeds CURRENT patterns LABELLED
  // RETIRED — the exact inversion of the truth, on the field that drives price.
  const sql = Deno.readTextFileSync(
    new URL(
      "../../../../supabase/migrations/00468_handbags_accessories_brand_knowledge.sql",
      import.meta.url,
    ),
  );

  // The 20 patterns ARE seeded — but every one is stamped CURRENT, never retired.
  assert(
    /'verabradley', 'Java Blue'/.test(sql) === false,
    "no fan-wiki-dated retired pattern (e.g. Java Blue) may be seeded",
  );
  assert(
    !/retired (in |on )?(19|20)\d\d/i.test(sql),
    "NO retirement year may appear anywhere in the pack",
  );

  // The revival trap is seeded explicitly: Neutral Rhapsody is a RECOLOUR of Blue
  // Rhapsody (2009), so a name-similarity matcher would misprice a cheap current
  // revival as the valuable retired original.
  assert(
    /THE 2009 DATE BELONGS TO THE ORIGINAL, NOT TO THIS PATTERN/i.test(sql),
    "the revival/recolour trap must be recorded on the pattern it affects",
  );
});
