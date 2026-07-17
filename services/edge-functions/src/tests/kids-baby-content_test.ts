// US-1993: verify the kids & baby content (migration 00473) is correct +
// consumable by the engine.
//
// Carter's, Hanna Andersson, Mini Boden, Janie and Jack, The Children's Place,
// Gymboree. All six were passthrough-only.
//
// What binds the group: THE SIZE SYSTEM IS AN AGE/MONTHS SYSTEM — and it is NOT
// one system. Baby = MONTHS ↔ weight ↔ height; toddler = T-sizes; kids = numeric
// / alpha; and Hanna Andersson = HEIGHT IN CM (a different axis). The assertions
// below protect the things that follow:
//
//   1. All six aliases canonicalize + are known (reachable by tag), and the short
//      forms a seller types resolve (tcp, gymbo, janie & jack, baby boden).
//   2. The bare surname/first-name/word tokens (carter, hanna, place, boden) are
//      NEVER minted from prose, while the full forms resolve — verified by mutation.
//   3. The size charts are reachable for every brand across its categories, with
//      the SYSTEM (months/weight/height vs T-size vs cm-height) the signal.
//   4. The Hanna Andersson chart carries CM/height labels and its note explains
//      the cm↔US mapping (the standout call).
//   5. A style fingerprint renders verbatim into the extract prompt.
//   6. ZERO DECODERS, "A KIDS SIZE IS NOT A STYLE CODE", NO RN, tag_eras
//      documented-vs-empty (Gymboree vs modern), colorways zero — all recorded in
//      the migration.
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
  "Carter's",
  "Hanna Andersson",
  "Mini Boden",
  "Janie and Jack",
  "The Children's Place",
  "Gymboree",
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
    department: "Kids",
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
): BrandKnowledgePack {
  return {
    brand,
    key,
    known: true,
    aliases: [],
    categoryFocus: ["kids"],
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
      "../../../../supabase/migrations/00473_kids_baby_brand_knowledge.sql",
      import.meta.url,
    ),
  );
}

Deno.test("US-1993: the kids & baby group aliases canonicalize + are known", () => {
  for (const brand of GROUP) {
    assertEquals(
      canonicalizeBrand(brand.toLowerCase()),
      brand,
      `${brand} canonicalizes from a lowercase tag`,
    );
    assert(isKnownBrand(brand), `${brand} is a curated entry, not a passthrough`);
  }

  // The short forms and spellings a seller is likely to type.
  assertEquals(canonicalizeBrand("tcp"), "The Children's Place"); // exact whole-field key
  assertEquals(canonicalizeBrand("childrens place"), "The Children's Place");
  assertEquals(canonicalizeBrand("janie & jack"), "Janie and Jack"); // the "&" spelling
  assertEquals(canonicalizeBrand("gymbo"), "Gymboree"); // nickname
  assertEquals(canonicalizeBrand("baby boden"), "Mini Boden"); // the youngest line
  assertEquals(canonicalizeBrand("just one you"), "Carter's"); // Target sub-label
});

Deno.test("US-1993: a bare 'boden' is NOT aliased to Mini Boden (adult parent)", () => {
  // "boden" alone is the ADULT parent brand; only the "Mini Boden" kids forms
  // resolve (a shared name is not a fold).
  assert(
    canonicalizeBrand("boden") !== "Mini Boden",
    "a bare 'boden' must not resolve to Mini Boden",
  );
  assert(!isKnownBrand("boden"), "'boden' is not a curated brand key");
  // The kids forms still resolve.
  assertEquals(canonicalizeBrand("mini boden"), "Mini Boden");
});

Deno.test("US-1993: bare surname / first-name / word tokens are never minted from prose", () => {
  // "carter" is a common surname — never guessed from prose, and its canonical is
  // the possessive "Carter's" which a bare "carter" can never match.
  assertEquals(
    detectBrandInText("soft cotton onesie, handed down from carter, size 6M"),
    null,
    "'carter' in free text must not mint Carter's",
  );
  // "hanna" is a first name.
  assertEquals(
    detectBrandInText("striped pajamas, a gift from hanna, 90cm"),
    null,
    "'hanna' in free text must not mint Hanna Andersson",
  );
  // "place" is an ordinary word.
  assertEquals(
    detectBrandInText("a great place to find a kids polo, size 5"),
    null,
    "'place' in free text must not mint The Children's Place",
  );
  // "boden" is the adult parent brand — never guessed onto the kids line from prose.
  assertEquals(
    detectBrandInText("sturdy cotton dress, similar to boden, age 4"),
    null,
    "'boden' in free text must not mint Mini Boden",
  );

  // A real brand in the same prose still wins.
  assertEquals(
    detectBrandInText("Nike kids tee, from carter, medium"),
    "Nike",
    "the real brand wins; 'carter' in prose is never guessed",
  );
});

Deno.test("US-1993: the FULL brand forms resolve from prose (reachable by text)", () => {
  assertEquals(
    detectBrandInText("Carter's footed sleeper, 6M, snap closure"),
    "Carter's",
    "the full 'Carter's' resolves from prose",
  );
  assertEquals(
    detectBrandInText("Hanna Andersson striped organic pajamas, 90cm"),
    "Hanna Andersson",
    "the full 'Hanna Andersson' resolves from prose",
  );
  assertEquals(
    detectBrandInText("The Children's Place uniform polo, size 5"),
    "The Children's Place",
    "the full 'The Children's Place' resolves from prose",
  );
});

Deno.test("US-1993: every brand's size charts are reachable across its categories", () => {
  const cases: Array<[string, string]> = [
    ["Carter's", "sleeper"],
    ["Carter's", "tee"],
    ["Hanna Andersson", "pajama"],
    ["Mini Boden", "dress"],
    ["Janie and Jack", "romper"],
    ["Janie and Jack", "sweater"],
    ["The Children's Place", "polo"],
    ["The Children's Place", "bodysuit"],
    ["Gymboree", "legging"],
    ["Gymboree", "sleeper"],
  ];
  for (const [brand, category] of cases) {
    const charts = findSizingCharts(brand, category);
    assert(charts.length > 0, `${brand} must reach a chart for "${category}"`);
  }
});

Deno.test("US-1993: THE SYSTEM is the size signal (months ↔ weight ↔ height, T-sizes, cm-height)", () => {
  // A baby chart is a MONTHS ↔ weight ↔ height translator.
  const carterBaby = findSizingCharts("Carter's", "sleeper")[0];
  assert(
    /SIZED IN MONTHS/i.test(carterBaby.note ?? "") &&
      /months ↔ weight ↔ height/i.test(carterBaby.note ?? ""),
    "the Carter's baby chart note names the months↔weight↔height system",
  );

  // ⚠ THE STANDOUT: Hanna Andersson sizes by HEIGHT IN CM — a different axis.
  const hanna = findSizingCharts("Hanna Andersson", "pajama")[0];
  assert(
    /HEIGHT IN CM/i.test(hanna.note ?? ""),
    "the Hanna Andersson note states it sizes by HEIGHT IN CM",
  );
  const hannaLabels = hanna.rows.map((r) => r.size).join(" ");
  assert(
    /\b90 cm\b/.test(hannaLabels) && /\b110 cm\b/.test(hannaLabels),
    "the Hanna Andersson chart labels carry the cm height (90 cm, 110 cm)",
  );
  assert(
    /90 cm ≈ US 2T|translate to US age/i.test(hanna.note ?? ""),
    "the Hanna Andersson note explains the cm↔US age mapping",
  );

  // Mini Boden is the British AGE-YEARS system.
  const boden = findSizingCharts("Mini Boden", "dress")[0];
  assert(
    /AGE-YEARS/i.test(boden.note ?? "") && /BRITISH/i.test(boden.note ?? ""),
    "the Mini Boden note names the British age-years system",
  );
});

Deno.test("US-1993: a garment-silhouette fingerprint reaches the extract prompt", () => {
  // brandPackPromptBlock renders visual_fingerprint VERBATIM (US-1740). For this
  // group the highest-value fingerprint is the SILHOUETTE / PRINT / CONSTRUCTION.
  const hanna = brandPackPromptBlock(
    pack("Hanna Andersson", "hannaandersson", [
      style(
        "Organic Cotton Zip Pajamas",
        "Sleep",
        "THE ICON: the striped 'long johns' — a heavyweight organic-cotton knit, SIZED BY HEIGHT IN CM.",
        ["organic cotton"],
      ),
    ]),
  );
  assert(
    /long johns/i.test(hanna),
    "Hanna's pajama fingerprint must render verbatim into the prompt",
  );
  assert(
    /HEIGHT IN CM/i.test(hanna),
    "the cm/height system must reach the prompt",
  );

  const gymbo = brandPackPromptBlock(
    pack("Gymboree", "gymboree", [
      style(
        "Vintage Collection (Matching Set)",
        "Vintage collections",
        "⚠ THE COLLECTOR DRIVER: a discontinued 1990s-2000s matching SET — comps on the COLLECTION/LINE NAME.",
      ),
    ]),
  );
  assert(
    /COLLECTION\/LINE NAME/i.test(gymbo),
    "the vintage-Gymboree collection fingerprint must reach the prompt",
  );
});

Deno.test("US-1993: ZERO decoders, and a KIDS SIZE IS NOT A STYLE CODE — recorded", () => {
  const sql = migrationSql();
  assert(
    /ZERO DECODERS/i.test(sql),
    "the migration must record that no decoder clears the bar",
  );
  assert(
    /NO decoder clears the bar/i.test(sql),
    "the migration must state NO decoder clears the bar",
  );
  assert(
    /A KIDS SIZE IS NOT A STYLE CODE/i.test(sql),
    "the migration must record that a kids size is not a style code",
  );
  // The coded candidates (Gymboree / Children's Place style numbers) are refused
  // as web SKUs.
  assert(
    /web\/catalogue SKU|web\/catalogue "style numbers"|catalogue SKUs|Chanel rule/i.test(sql),
    "the Gymboree / Children's Place style-number refusal (a web SKU) must be recorded",
  );
});

Deno.test("US-1993: NO RN is seeded, and childrenswear-is-textile is stated", () => {
  const sql = migrationSql();
  assert(
    /NONE ARE SEEDED/i.test(sql),
    "the migration must record that RN is refused, not merely absent",
  );
  // Childrenswear IS textile, so an RN would be in scope — the migration says so.
  assert(
    /childrenswear is textile|childrenswear IS textile/i.test(sql),
    "the migration must state childrenswear is textile (RN in scope, none sourced)",
  );
});

Deno.test("US-1993: tag_eras documented for Gymboree/Carter's, empty for the modern brands", () => {
  const sql = migrationSql();
  // Gymboree carries a genuine vintage-collector chronology.
  assert(
    /Vintage Gymboree collections|1990s-2000s/i.test(sql),
    "the Gymboree vintage-collection tag-era must be seeded",
  );
  // Carter's heritage prior (1865).
  assert(/1865/.test(sql), "the Carter's 1865 heritage tag-era prior must be seeded");
  // The four modern brands' empty tag_eras are a deliberate call.
  assert(
    /TAG ERAS EMPTY ON PURPOSE/i.test(sql),
    "the modern brands' empty tag_eras must be recorded as a deliberate call",
  );
});

Deno.test("US-1993: colorways are ZERO for the whole group, by design", () => {
  const sql = migrationSql();
  assert(
    /ZERO COLORWAYS ARE SEEDED/i.test(sql),
    "the migration must record that the group seeds zero colorways by design",
  );
  // And there is genuinely no brand_colorways insert.
  assert(
    !/insert into public\.brand_colorways/i.test(sql),
    "there must be no brand_colorways insert for this group",
  );
});
