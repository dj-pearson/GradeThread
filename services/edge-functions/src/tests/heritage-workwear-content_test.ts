// US-1989: verify the heritage & workwear content (migration 00469) is correct +
// consumable by the engine.
//
// Six of the eight brands were passthrough-only; DICKIES and PENDLETON carried
// only the shallow alias-only rows from 00389 and are promoted to full packs.
//
// What binds this group is that THE TAG IS THE ASSET: for a heritage/workwear
// piece the interior LABEL ERA is the single largest price driver (a 1950s-60s
// Pendleton board shirt or a Made-in-USA vintage Filson Cruiser is worth a
// multiple of its modern twin), so this pack's centre of gravity is `tag_eras`.
// The assertions below protect the four things that follow:
//
//   1. A DOCUMENTED tag chronology EXISTS for Pendleton/Barbour/Filson/Red Wing/
//      Timberland/Dickies and DOES NOT for Duluth Trading (1989, modern) or Orvis
//      — empty tag_eras on those two is CORRECT, not a gap.
//   2. ONE DECODER — BARBOUR — whose interior-label MWX/LWX code clears the bar;
//      the boot brands' household-name style numbers (874/875/10061) are refused
//      as bare digit runs (fixtured in brand-knowledge-golden_test.ts).
//   3. THE HEADLINE REFUSAL: a bare "duluth" is NOT Duluth Trading (Duluth Pack,
//      est. 1882, is a different company).
//   4. "Red Wing" is reachable BY TAG but never GUESSED from prose (Detroit Red
//      Wings / the red-wing blackbird would otherwise mint the boot house).
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
  "Dickies",
  "Filson",
  "Red Wing",
  "Timberland",
  "Duluth Trading Co.",
  "Pendleton",
  "Barbour",
  "Orvis",
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
    department: "Men",
    category: "jacket",
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
    categoryFocus: ["workwear"],
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
      "../../../../supabase/migrations/00469_heritage_workwear_brand_knowledge.sql",
      import.meta.url,
    ),
  );
}

Deno.test("US-1989: the heritage/workwear aliases canonicalize", () => {
  for (const brand of GROUP) {
    assertEquals(
      canonicalizeBrand(brand.toLowerCase()),
      brand,
      `${brand} canonicalizes from a lowercase tag`,
    );
    assert(isKnownBrand(brand), `${brand} is a curated entry, not a passthrough`);
  }

  // The sub-lines / model names a seller is likely to type.
  assertEquals(canonicalizeBrand("Irish Setter"), "Red Wing"); // Red Wing's hunting line
  assertEquals(canonicalizeBrand("Red Wing Heritage"), "Red Wing");
  assertEquals(canonicalizeBrand("Barbour International"), "Barbour");
  assertEquals(canonicalizeBrand("Timberland PRO"), "Timberland");
  assertEquals(canonicalizeBrand("Pendleton Woolen Mills"), "Pendleton");
  assertEquals(canonicalizeBrand("Williamson-Dickie"), "Dickies");
  assertEquals(canonicalizeBrand("C.C. Filson"), "Filson");

  // The misspellings these brands attract.
  assertEquals(canonicalizeBrand("Timberlands"), "Timberland");
  assertEquals(canonicalizeBrand("Timbs"), "Timberland");
});

Deno.test("US-1989: the HEADLINE REFUSAL — a bare 'duluth' is NOT Duluth Trading", () => {
  // The group's Longchamp-Fabrics trap (00468): a string that matches, a real
  // entity, and the WRONG company. "Duluth" is a Minnesota city AND DULUTH PACK
  // (est. 1882), an unrelated waxed-canvas pack maker; DULUTH TRADING CO. is a
  // 1989 workwear brand. Folding a bare "duluth" would retitle a Duluth Pack
  // canoe pack as a Fire Hose work-pant company.
  assertEquals(
    canonicalizeBrand("Duluth"),
    "Duluth",
    "a bare 'Duluth' passes through — it may be Duluth Pack",
  );
  assert(
    !isKnownBrand("Duluth"),
    "a bare 'Duluth' must NOT resolve to Duluth Trading Co.",
  );
  assert(
    !isKnownBrand("Duluth Pack"),
    "Duluth Pack must not resolve to Duluth Trading Co.",
  );
  // But the two-word brand DOES resolve.
  assertEquals(canonicalizeBrand("Duluth Trading"), "Duluth Trading Co.");
  assertEquals(canonicalizeBrand("Duluth Trading Co."), "Duluth Trading Co.");

  // And the migration records WHY, so a future "improvement" can't re-add it.
  const sql = migrationSql();
  assert(
    /A BARE "duluth" IS NOT DULUTH TRADING/i.test(sql),
    "the migration must record the Duluth Pack refusal",
  );
  assert(
    /DULUTH PACK \(est\. 1882\)/i.test(sql),
    "the colliding company must be named so nobody re-derives it",
  );
});

Deno.test("US-1989: 'Red Wing' is reachable by TAG but never minted from prose", () => {
  // "Red Wing" is the boot house's canonical, but the two-word phrase is a live
  // free-text collision: "Detroit Red Wings" and the red-wing blackbird both
  // contain it at a word boundary, and longest-first ordering would let it beat a
  // real shorter brand in the same title.
  assertEquals(
    detectBrandInText("Detroit Red Wings NHL hockey jersey size L"),
    null,
    "'Detroit Red Wings' must not mint the boot house",
  );
  assertEquals(
    detectBrandInText("Nike tee with a red wing graphic, medium"),
    "Nike",
    "the real brand still wins; 'red wing' in prose is never guessed",
  );

  // But the brand stays fully reachable BY TAG, which is what the eBay Brand
  // aspect and the comp filter read.
  assertEquals(canonicalizeBrand("Red Wing"), "Red Wing");
  assert(isKnownBrand("Red Wing"), "Red Wing stays a curated entry, reachable by tag");
});

Deno.test("US-1989: the tag-era corrections reach the extract prompt (the price driver)", () => {
  // brandPackPromptBlock renders visual_fingerprint VERBATIM (US-1740). For this
  // group the highest-value fingerprint is the ERA cue on the tag, so the style
  // rows carry "the LABEL dates the piece" instructions that must render.
  const pendleton = brandPackPromptBlock(
    pack("Pendleton", "pendleton", [
      style(
        "Wool Board Shirt",
        "Wool shirts",
        "⚠ **THE TAG DATES IT** — an early Pendleton script + 100% Virgin Wool + Made in U.S.A. label on a board shirt is the collectible find; a modern label is genuine but far cheaper.",
      ),
    ]),
  );
  assert(
    /THE TAG DATES IT/i.test(pendleton),
    "Pendleton's label-dates-the-piece rule must render verbatim into the prompt",
  );

  const barbour = brandPackPromptBlock(
    pack("Barbour", "barbour", [
      style(
        "Bedale",
        "Waxed jackets",
        "⚠ Separable from the BEAUFORT by LENGTH (Bedale is shorter). Grade the wax patina in the heritage frame — heavy wax wear is normal.",
      ),
    ]),
  );
  assert(
    /heavy wax wear is normal/i.test(barbour),
    "Barbour's re-wax-is-normal grading note must reach the prompt",
  );
});

Deno.test("US-1989: tag_eras are DOCUMENTED for heritage brands, EMPTY for the modern ones", () => {
  const sql = migrationSql();

  // The heritage brands carry real, sourced tag chronology (the price driver).
  assert(
    /Royal Warrant count on the label/i.test(sql),
    "Barbour's dated warrant-crest tell must be seeded",
  );
  assert(
    /board shirt/i.test(sql) && /Sir Pendleton/i.test(sql),
    "Pendleton's vintage board-shirt + Sir Pendleton era tells must be seeded",
  );

  // ⚠ AND THE MODERN BRANDS' EMPTY tag_eras IS RECORDED AS A DELIBERATE CALL, not
  // an oversight — the athleisure precedent (00452). Seeding a fake chronology on
  // a brand with no vintage corpus is invention.
  assert(
    /TAG ERAS ARE EMPTY ON PURPOSE/i.test(sql),
    "the migration must record WHY Duluth/Orvis have no tag chronology",
  );
});

Deno.test("US-1989: NO RN is seeded, and the refusal is recorded (never fabricate a federal record)", () => {
  // Unlike the handbag pack (00468), these ARE textiles, so RNs genuinely exist —
  // but none could be sourced to a primary FTC record, and fabricating one is the
  // KB's costliest error (the RN 17257 lesson). The reason is recorded, not faked.
  const sql = migrationSql();
  assert(
    /NO RN IS SEEDED/i.test(sql),
    "the migration must record that RN is refused, not merely absent",
  );
  assert(
    /RN 17257 lesson|costliest error/i.test(sql),
    "the refusal must cite why fabricating an RN is dangerous",
  );
});

Deno.test("US-1989: every brand's charts are reachable, incl. the boot vs apparel split", () => {
  // A mix of APPAREL (waist x inseam / chest) and FOOTWEAR (US shoe). findSizing
  // Charts must reach all eight.
  const cases: Array<[string, string]> = [
    ["Dickies", "pant"],
    ["Filson", "jacket"],
    ["Red Wing", "boot"],
    ["Timberland", "boot"],
    ["Duluth Trading Co.", "pant"],
    ["Pendleton", "shirt"],
    ["Barbour", "jacket"],
    ["Orvis", "jacket"],
  ];
  for (const [brand, category] of cases) {
    const charts = findSizingCharts(brand, category);
    assert(charts.length > 0, `${brand} must reach a chart for "${category}"`);
  }

  // ⚠ THE BOOT BRANDS ARE FOOTWEAR CHARTS (US shoe sizing), and the fit caveat
  // (Red Wing / the Yellow Boot both run large) must be stated where the sizing
  // decision is made.
  const redwing = findSizingCharts("Red Wing", "boot")[0];
  assert(
    /RUN LARGE/i.test(redwing.note ?? ""),
    "Red Wing's run-large fit caveat must be on the boot chart",
  );
  assert(
    /US men's shoe size/i.test(redwing.garment),
    "the Red Wing chart names its unit (US shoe) in `garment`",
  );

  // ⚠ THE DULUTH CHART MUST NOT BE REACHABLE FROM A BARE "duluth" — the brandMatch
  // is the two-word form (Duluth Pack collision).
  const duluth = findSizingCharts("Duluth Trading Co.", "pant")[0];
  assert(
    /NEVER A BARE 'duluth'/i.test(duluth.note ?? ""),
    "the Duluth chart's note must state the bare-token refusal",
  );
  assertEquals(
    findSizingCharts("Duluth", "pant").filter((c) =>
      c.brandMatch.includes("duluth trading")
    ).length,
    0,
    "a bare 'Duluth' brand string must not reach the Duluth Trading chart",
  );

  // ⚠ DICKIES: the 874 fit family shares the size grid — the note must say the
  // STYLE NUMBER, not the size, separates the fits.
  const dickies = findSizingCharts("Dickies", "pant")[0];
  assert(
    /874 FIT FAMILY IS THE TRAP/i.test(dickies.note ?? ""),
    "the Dickies chart must warn that fit ≠ size",
  );
});
