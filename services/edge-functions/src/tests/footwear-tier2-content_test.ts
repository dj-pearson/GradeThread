// US-1990: verify the footwear tier-2 content (migration 00470) is correct +
// consumable by the engine.
//
// ALL TEN brands (Clarks, Merrell, KEEN, Sorel, Brooks, Saucony, Steve Madden,
// Sam Edelman, Allen Edmonds, Crocs) were passthrough-only. This is the tier-2
// footwear pack; 00459 (New Balance, Dr. Martens, UGG, Birkenstock, Converse,
// Vans, Cole Haan) is not re-touched.
//
// What binds the group: THE SIZE IS STAMPED, NOT MEASURED, and the STYLE IS A
// NAME, NOT A CODE. The assertions below protect the four things that follow:
//
//   1. The size charts are US/UK/EU TRANSLATORS (the story's stated key signal),
//      reachable for every brand across its categories.
//   2. ZERO DECODERS — none of the ten prints a code that clears the bar; the
//      candidates (Brooks 6-digit, Saucony S-number, Merrell J-number) are refused
//      and fixtured as negatives in brand-knowledge-golden_test.ts.
//   3. BROOKS (running) is NOT Brooks Brothers — a bare "brooks" is never minted
//      from prose and its running size chart never shadows the BB dress charts.
//   4. KEEN is an ordinary adjective — reachable BY TAG, never GUESSED from prose.
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

// Every brand EXCEPT Brooks (whose bare token is deliberately not aliased).
const GROUP = [
  "Clarks",
  "Merrell",
  "KEEN",
  "Sorel",
  "Saucony",
  "Steve Madden",
  "Sam Edelman",
  "Allen Edmonds",
  "Crocs",
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
    department: "Unisex",
    category: "shoe",
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
    categoryFocus: ["footwear"],
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
      "../../../../supabase/migrations/00470_footwear_tier2_brand_knowledge.sql",
      import.meta.url,
    ),
  );
}

Deno.test("US-1990: the footwear-tier2 aliases canonicalize", () => {
  for (const brand of GROUP) {
    assertEquals(
      canonicalizeBrand(brand.toLowerCase()),
      brand,
      `${brand} canonicalizes from a lowercase tag`,
    );
    assert(isKnownBrand(brand), `${brand} is a curated entry, not a passthrough`);
  }

  // The sub-lines / spellings a seller is likely to type.
  assertEquals(canonicalizeBrand("Clarks Originals"), "Clarks");
  assertEquals(canonicalizeBrand("C&J Clark"), "Clarks");
  assertEquals(canonicalizeBrand("Merrells"), "Merrell");
  assertEquals(canonicalizeBrand("KEEN Footwear"), "KEEN");
  assertEquals(canonicalizeBrand("Sorels"), "Sorel");
  assertEquals(canonicalizeBrand("Saucony Originals"), "Saucony");
  assertEquals(canonicalizeBrand("Crocs Inc"), "Crocs");
});

Deno.test("US-1990: BROOKS (running) is NOT Brooks Brothers", () => {
  // A bare "brooks" is DELIBERATELY not aliased — the two companies litigated the
  // name (00467), so a bare "Brooks" brand field is genuinely ambiguous. It passes
  // through unchanged (which equals the running brand's eBay canonical, so the
  // pack keyed 'brooks' stays reachable via brandKey()), but is never a curated
  // alias and never minted from prose.
  assertEquals(
    canonicalizeBrand("Brooks"),
    "Brooks",
    "a bare 'Brooks' passes through unchanged",
  );
  assert(
    !isKnownBrand("Brooks"),
    "a bare 'Brooks' must NOT resolve to a curated alias (it is ambiguous)",
  );
  // But the unambiguous compound forms DO resolve to the running brand.
  assertEquals(canonicalizeBrand("Brooks Running"), "Brooks");
  assertEquals(canonicalizeBrand("brooksrunning"), "Brooks");
  // And Brooks Brothers (00467) is untouched.
  assertEquals(canonicalizeBrand("Brooks Brothers"), "Brooks Brothers");

  // Prose: "Brooks" is an ordinary word and is never minted; Brooks Brothers is.
  assertEquals(
    detectBrandInText("cotton tee with a babbling brooks meadow print, size M"),
    null,
    "an ordinary 'brooks' in prose must not mint the running brand",
  );
  assertEquals(
    detectBrandInText("Nike running shorts, brooks-style mesh"),
    "Nike",
    "the real brand still wins; 'brooks' in prose is never guessed",
  );
  assertEquals(
    detectBrandInText("Brooks Brothers non-iron dress shirt 16-34"),
    "Brooks Brothers",
    "'Brooks Brothers' still resolves from prose (longest-first)",
  );
});

Deno.test("US-1990: the Brooks running chart never shadows the Brooks Brothers dress charts", () => {
  // findSizingCharts matches brandMatch as a LEADING word, so the two Brooks
  // brands share the "brooks" prefix — but category narrowing separates them.
  const brooksRun = findSizingCharts("Brooks", "running");
  assert(brooksRun.length > 0, "Brooks running must reach a footwear chart");
  assertEquals(brooksRun[0].brand, "Brooks");
  assert(
    /running/i.test(brooksRun[0].garment),
    "the Brooks chart names running in `garment`",
  );

  // A Brooks Brothers DRESS SHIRT must still get the BB dress-shirt chart, not the
  // running footwear chart (category narrowing does the work).
  const bb = findSizingCharts("Brooks Brothers", "dress shirt");
  assert(bb.length > 0, "Brooks Brothers must still reach its dress-shirt chart");
  assertEquals(
    bb[0].brand,
    "Brooks Brothers",
    "a BB dress shirt must not be handed the Brooks running chart",
  );
});

Deno.test("US-1990: KEEN is reachable by TAG but never minted from prose", () => {
  // "keen" is an ordinary English adjective; the match is case-insensitive so the
  // all-caps canonical is no defence.
  assertEquals(
    detectBrandInText("a keen eye for detail — Nike windbreaker, large"),
    "Nike",
    "'keen' in prose must not mint KEEN; the real brand wins",
  );
  assertEquals(
    detectBrandInText("keen interest in vintage denim"),
    null,
    "a bare adjective 'keen' must not mint the footwear brand",
  );
  // But reachable BY TAG.
  assertEquals(canonicalizeBrand("KEEN"), "KEEN");
  assert(isKnownBrand("KEEN"), "KEEN stays a curated entry, reachable by tag");
});

Deno.test("US-1990: every brand's size charts are reachable across its categories", () => {
  const cases: Array<[string, string]> = [
    ["Clarks", "shoe"],
    ["Merrell", "hiking"],
    ["KEEN", "sandal"],
    ["Sorel", "boot"],
    ["Brooks", "running"],
    ["Saucony", "running"],
    ["Steve Madden", "heel"],
    ["Sam Edelman", "loafer"],
    ["Allen Edmonds", "oxford"],
    ["Crocs", "clog"],
  ];
  for (const [brand, category] of cases) {
    const charts = findSizingCharts(brand, category);
    assert(charts.length > 0, `${brand} must reach a chart for "${category}"`);
  }

  // ⚠ THE CHARTS ARE US/UK/EU TRANSLATORS (the story's key signal) — the cross-map
  // lives in the size LABEL, and the "stamped, not measured" rule is in the note.
  const clarks = findSizingCharts("Clarks", "desert boot")[0];
  assert(
    /UK \d/.test(clarks.rows[0].size) && /US M/.test(clarks.rows[0].size),
    "the Clarks label carries the US/UK cross-map",
  );
  assert(
    /LETTER FITTING/i.test(clarks.note ?? ""),
    "the Clarks note explains the letter width fittings (G/H)",
  );

  // Allen Edmonds — Goodyear welt / Recrafting is the value read (Cole Haan shape).
  const ae = findSizingCharts("Allen Edmonds", "oxford")[0];
  assert(
    /GOODYEAR-WELTED/i.test(ae.note ?? "") && /RECRAFTING/i.test(ae.note ?? ""),
    "the Allen Edmonds note carries the welt + Recrafting value rule",
  );

  // Crocs — dual M/W, runs large, whole sizes.
  const crocs = findSizingCharts("Crocs", "clog")[0];
  assert(
    /DUAL-TAGS/i.test(crocs.note ?? "") && /RUN LARGE/i.test(crocs.note ?? ""),
    "the Crocs note states dual M/W tagging + runs-large",
  );
  assert(
    /M8 \/ W10/.test(crocs.rows.map((r) => r.size).join(" ")),
    "the Crocs label carries the dual M/W numbering",
  );
});

Deno.test("US-1990: the style fingerprint reaches the extract prompt", () => {
  // brandPackPromptBlock renders visual_fingerprint VERBATIM (US-1740). For
  // footwear the highest-value fingerprint is the silhouette/sole cue.
  const clarks = brandPackPromptBlock(
    pack("Clarks", "clarks", [
      style(
        "Desert Boot",
        "Clarks Originals",
        "⚠ Separable from the Wallabee by the CLEAN CHUKKA toe; the crepe sole yellows with age — patina, not damage, unless cracked.",
      ),
    ]),
  );
  assert(
    /CLEAN CHUKKA toe/i.test(clarks),
    "Clarks' Desert-Boot fingerprint must render verbatim into the prompt",
  );

  const ae = brandPackPromptBlock(
    pack("Allen Edmonds", "allenedmonds", [
      style(
        "Park Avenue",
        "Dress oxfords",
        "a CAP-TOE OXFORD on a Goodyear welt — the value is in the welt (resoleable); require a SOLE-EDGE photo.",
      ),
    ]),
  );
  assert(
    /require a SOLE-EDGE photo/i.test(ae),
    "Allen Edmonds' welt-photo instruction must reach the prompt",
  );
});

Deno.test("US-1990: ZERO decoders, and every refusal is recorded", () => {
  const sql = migrationSql();
  assert(
    /ZERO DECODERS/i.test(sql),
    "the migration must record that no decoder clears the bar",
  );
  // The three coded candidates are refused, each with its reason.
  assert(
    /BROOKS `110411`/i.test(sql) || /Brooks .*6-digit/i.test(sql),
    "the Brooks 6-digit refusal must be recorded",
  );
  assert(
    /adidas.{0,40}style-code shape|S \+ 5 digits is/i.test(sql),
    "the Saucony/adidas format-collision refusal must be recorded",
  );
  assert(
    /MERRELL `J036755`/i.test(sql) || /J.-prefixed article number/i.test(sql),
    "the Merrell J-number refusal must be recorded",
  );
});

Deno.test("US-1990: NO RN is seeded, and tag_eras are documented vs empty by design", () => {
  const sql = migrationSql();
  assert(
    /NONE ARE SEEDED/i.test(sql),
    "the migration must record that RN is refused, not merely absent",
  );
  // Heritage makers carry a real (coarse) tag chronology; the modern brands do not.
  assert(
    /Made in England.*Originals|Made-in-USA \(Port Washington\)/i.test(sql),
    "the heritage tag-era priors (Clarks Originals / Allen Edmonds) must be seeded",
  );
  assert(
    /EMPTY for the eight modern|TAG ERAS EMPTY ON PURPOSE/i.test(sql),
    "the modern brands' empty tag_eras must be recorded as a deliberate call",
  );
});
