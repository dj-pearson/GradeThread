// US-1992: verify the outdoor & technical (tier 2) content (migration 00472)
// is correct + consumable by the engine.
//
// Fjällräven, Salomon, Cotopaxi, Kühl, Helly Hansen, Mammut, Rab, Outdoor
// Research. All eight were passthrough-only.
//
// What binds the group: THE VALUE IS THE MODEL NAME + THE FABRIC TECHNOLOGY —
// never a tag-printed brand-unique code. The assertions below protect the
// things that follow:
//
//   1. All eight aliases canonicalize + are known (reachable by tag), including
//      the diacritic keys (Fjällräven → fjllrven, Kühl → khl) and the unaccented
//      spellings, and the DELIBERATELY-ABSENT bare "or".
//   2. Rab (a given name) and Kühl (German for "cool") are reachable by TAG but
//      NEVER minted from prose — verified by mutation.
//   3. The size charts are reachable for every brand across its categories, with
//      the SYSTEM (EU numeric vs US alpha vs a stamped footwear number) the signal.
//   4. A model + fabric-tech fingerprint renders verbatim into the extract prompt.
//   5. ZERO DECODERS, NO RN, tag_eras documented-vs-empty, Fjällräven-only
//      colorways (Cotopaxi none) — all recorded in the migration.
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
  "Fjällräven",
  "Salomon",
  "Cotopaxi",
  "Kühl",
  "Helly Hansen",
  "Mammut",
  "Rab",
  "Outdoor Research",
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
    department: "Unisex",
    category: "jacket",
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
    categoryFocus: ["outdoor"],
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
      "../../../../supabase/migrations/00472_outdoor_technical_tier2_brand_knowledge.sql",
      import.meta.url,
    ),
  );
}

Deno.test("US-1992: the outdoor group aliases canonicalize + are known", () => {
  for (const brand of GROUP) {
    assertEquals(
      canonicalizeBrand(brand.toLowerCase()),
      brand,
      `${brand} canonicalizes from a lowercase tag`,
    );
    assert(isKnownBrand(brand), `${brand} is a curated entry, not a passthrough`);
  }

  // The diacritic + unaccented spellings and short forms a seller is likely to type.
  assertEquals(canonicalizeBrand("fjallraven"), "Fjällräven"); // unaccented
  assertEquals(canonicalizeBrand("Kanken"), "Fjällräven"); // the flagship pack
  assertEquals(canonicalizeBrand("kuhl"), "Kühl"); // unaccented
  assertEquals(canonicalizeBrand("HH"), "Helly Hansen"); // short form
  assertEquals(canonicalizeBrand("Salomon"), "Salomon");
  assertEquals(canonicalizeBrand("Outdoor Research"), "Outdoor Research");
});

Deno.test("US-1992: a bare 'OR' is NOT aliased to Outdoor Research", () => {
  // "OR" is the English word / the state Oregon — catastrophic even as an exact
  // whole-field key; only the full form resolves.
  assert(
    canonicalizeBrand("OR") !== "Outdoor Research",
    "a bare 'OR' must not resolve to Outdoor Research",
  );
  assert(!isKnownBrand("OR"), "'OR' is not a curated brand key");
  // The full form still resolves.
  assertEquals(canonicalizeBrand("outdoorresearch"), "Outdoor Research");
});

Deno.test("US-1992: Rab is reachable by tag but never minted from prose", () => {
  // Reachable by TAG.
  assertEquals(canonicalizeBrand("rab"), "Rab");
  assert(isKnownBrand("Rab"), "Rab is a curated entry, reachable by tag");

  // "rab" is a given name / ordinary short token — never guessed from prose.
  assertEquals(
    detectBrandInText("cozy wool sweater, a gift from rab, size L"),
    null,
    "'rab' in free text must not mint the brand",
  );
  assertEquals(
    detectBrandInText("Nike fleece jacket, handed down from rab, large"),
    "Nike",
    "the real brand wins; 'rab' in prose is never guessed",
  );
});

Deno.test("US-1992: Kühl is reachable by tag but never minted from prose", () => {
  // Reachable by TAG (both the accented and unaccented spellings).
  assertEquals(canonicalizeBrand("kühl"), "Kühl");
  assertEquals(canonicalizeBrand("kuhl"), "Kühl");
  assert(isKnownBrand("Kühl"), "Kühl is a curated entry, reachable by tag");

  // "kühl" is the German word for "cool" — never guessed from prose.
  assertEquals(
    detectBrandInText("light kühl cotton shirt, breathable, size M"),
    null,
    "the German adjective 'kühl' in prose must not mint the brand",
  );
  assertEquals(
    detectBrandInText("Patagonia fleece for a kühl morning, size L"),
    "Patagonia",
    "the real brand wins; 'kühl' in prose is never guessed",
  );
});

Deno.test("US-1992: every brand's size charts are reachable across its categories", () => {
  const cases: Array<[string, string]> = [
    ["Fjällräven", "jacket"],
    ["Salomon", "shoe"],
    ["Cotopaxi", "jacket"],
    ["Kühl", "pant"],
    ["Helly Hansen", "jacket"],
    ["Mammut", "jacket"],
    ["Rab", "jacket"],
    ["Outdoor Research", "jacket"],
  ];
  for (const [brand, category] of cases) {
    const charts = findSizingCharts(brand, category);
    assert(charts.length > 0, `${brand} must reach a chart for "${category}"`);
  }
});

Deno.test("US-1992: the SYSTEM is the size signal (EU numeric vs US alpha vs stamped)", () => {
  // The four European apparel brands carry the EU-numeric cross-map in the note.
  const fjall = findSizingCharts("Fjällräven", "jacket")[0];
  assert(
    /EUROPEAN BRAND/i.test(fjall.note ?? "") &&
      /EU 50/.test(fjall.rows.map((r) => r.size).join(" ")),
    "the Fjällräven chart labels carry the EU number + the EU-vs-US note",
  );
  const hh = findSizingCharts("Helly Hansen", "jacket")[0];
  assert(/EUROPEAN \(Norwegian\)/i.test(hh.note ?? ""), "HH note names the EU system");
  const mammut = findSizingCharts("Mammut", "jacket")[0];
  assert(/EUROPEAN \(Swiss\)/i.test(mammut.note ?? ""), "Mammut note names the EU system");
  const rab = findSizingCharts("Rab", "jacket")[0];
  assert(/BRITISH BRAND/i.test(rab.note ?? ""), "Rab note names the UK/EU system");

  // Salomon is FOOTWEAR — the size is STAMPED, not measured.
  const salomon = findSizingCharts("Salomon", "shoe")[0];
  assert(
    /STAMPED, NOT MEASURED/i.test(salomon.note ?? "") &&
      /EU 41.5/.test(salomon.rows.map((r) => r.size).join(" ")),
    "the Salomon footwear chart is a stamped US/UK/EU translator",
  );

  // The US-alpha brands say so.
  const or = findSizingCharts("Outdoor Research", "jacket")[0];
  assert(/US alpha/i.test(or.note ?? ""), "the OR note names the US-alpha system");
});

Deno.test("US-1992: a model + fabric-tech fingerprint reaches the extract prompt", () => {
  // brandPackPromptBlock renders visual_fingerprint VERBATIM + the fabric tech
  // (US-1740). For this group the highest-value fingerprint is the MODEL + the
  // FABRIC TECHNOLOGY.
  const rab = brandPackPromptBlock(
    pack("Rab", "rab", [
      style(
        "Microlight",
        "Down insulation",
        "⚠ Separable from the Neutrino by the STITCH-THROUGH baffles (not box-wall).",
        ["Pertex shell", "hydrophobic down"],
      ),
    ]),
  );
  assert(
    /STITCH-THROUGH baffles/i.test(rab),
    "Rab's Microlight fingerprint must render verbatim into the prompt",
  );
  assert(
    /Pertex shell/i.test(rab),
    "the Microlight's fabric technology must reach the prompt",
  );

  const or = brandPackPromptBlock(
    pack("Outdoor Research", "outdoorresearch", [
      style(
        "Foray",
        "GORE-TEX shell",
        "The signature full-length side TorsoFlo zips run hem-to-bicep.",
        ["GORE-TEX", "TorsoFlo side zips"],
      ),
    ]),
  );
  assert(
    /TorsoFlo/i.test(or),
    "the OR Foray TorsoFlo fingerprint must reach the prompt",
  );
});

Deno.test("US-1992: ZERO decoders, and every refusal is recorded", () => {
  const sql = migrationSql();
  assert(
    /ZERO DECODERS/i.test(sql),
    "the migration must record that no decoder clears the bar",
  );
  assert(
    /NO decoder clears the bar/i.test(sql),
    "the migration must state NO decoder clears the bar",
  );
  // The coded candidates are refused, each with its reason.
  assert(
    /L41252600/.test(sql),
    "the Salomon article-number refusal must be recorded",
  );
  assert(
    /web\/catalogue SKU|web SKU/i.test(sql),
    "the Fjällräven / Helly Hansen product-number refusal (a web SKU) must be recorded",
  );
});

Deno.test("US-1992: NO RN is seeded, and tag_eras are documented vs empty by design", () => {
  const sql = migrationSql();
  assert(
    /NONE ARE SEEDED/i.test(sql),
    "the migration must record that RN is refused, not merely absent",
  );
  // The two brands with a genuine vintage chronology carry tag_eras; the six
  // modern brands do not.
  assert(
    /1877/.test(sql) && /1960/.test(sql),
    "the Helly Hansen (1877) + Fjällräven (1960) heritage tag-era priors must be seeded",
  );
  assert(
    /TAG ERAS EMPTY ON PURPOSE/i.test(sql),
    "the modern brands' empty tag_eras must be recorded as a deliberate call",
  );
});

Deno.test("US-1992: the name/word collisions Rab + Kühl are recorded", () => {
  const sql = migrationSql();
  assert(/given name/i.test(sql), "the Rab given-name collision must be recorded");
  assert(
    /German word for "cool"|German word for cool/i.test(sql),
    "the Kühl German-word collision must be recorded",
  );
});

Deno.test("US-1992: colorways are Fjällräven-only, and Cotopaxi is the inversion", () => {
  const sql = migrationSql();
  // Fjällräven's Kånken named palette is seeded.
  assert(
    /'fjallraven', 'UN Blue'/.test(sql),
    "the Fjällräven Kånken named colourways must be seeded",
  );
  // Cotopaxi Del Día is intentionally one-of-a-kind → ZERO colorways, by design.
  assert(
    /ZERO Cotopaxi colorways/i.test(sql),
    "the migration must record that Cotopaxi seeds zero colorways (Del Día inversion)",
  );
});
