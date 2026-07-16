// US-1716: brand-knowledge GOLDEN harness.
//
// A fixture-driven regression gate for the deterministic identification path
// (US-1712 decoders + US-1713 enrichment). Each case is a realistic garment —
// including the CUT-TAG cases the whole epic exists for — asserting that the
// resolver recovers brand/style/size better than the pre-KB baseline. Mirrors
// the grading golden set: adding a decoder/fingerprint must not regress any case
// here, and new brands (US-1718+) append fixtures. A per-brand recovery summary
// is printed so the KB's effect is measurable (AC3).
//
//   deno test --allow-env --allow-net --allow-read \
//     src/tests/brand-knowledge-golden_test.ts
//
// ai-extract.ts imports the supabase-backed resolver at load → dummy env first.
import { assert, assertEquals } from "@std/assert";

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { enrichExtractionWithBrandKnowledge } = await import(
  "../lib/ai-extract.ts"
);
import type {
  AttributeSuggestion,
  DecodedExtraction,
  FieldSuggestion,
} from "../lib/ai-extract.ts";
import type {
  BrandDecoder,
  BrandKnowledgePack,
  BrandStyleKnowledge,
} from "../lib/brand-knowledge.ts";

// ── fixture builders ────────────────────────────────────────────────────────
function pack(
  brand: string,
  key: string,
  styles: BrandStyleKnowledge[] = [],
  decoders: BrandDecoder[] = [], // empty → decodeTagCode uses the in-code DEFAULT specs
): BrandKnowledgePack {
  return {
    brand,
    key,
    known: true,
    aliases: [],
    categoryFocus: [],
    authenticationTells: [],
    tagEras: [],
    styles,
    decoders,
    colorways: [],
    sizingCharts: [],
    source: "fallback",
  };
}

// US-1733: the Under Armour style_number decoder EXACTLY as migration 00452
// seeds it into brand_style_codes. Fixturing the real seeded row (rather than a
// hand-simplified one) is the point: this asserts the shipped DB spec actually
// decodes, so a bad pattern/fieldMap in the migration fails here instead of in
// production. UA is the only brand in the athleisure group with a tag-printed,
// regular code — the others are deliberately decoder-less.
const UA_STYLE_NUMBER_DECODER: BrandDecoder = {
  decoderKind: "style_number",
  description:
    "Tag-printed 7-digit style number beneath the wash/care label, optionally prefixed STYLE and/or a season code (FW24 / SS25).",
  pattern:
    "^(?:STYLE\\s*)?(?:(?<season>FW|SS)(?<year>\\d{2})\\s*)?(?<style>\\d{7})$",
  extractionRules: {
    fieldMap: { season: "season", year: "year", style: "styleCode" },
    transforms: { season: "upper", year: "year2to4" },
    confidence: 0.75,
  },
  examples: [],
};

function style(styleName: string): BrandStyleKnowledge {
  return {
    styleName,
    aliases: [],
    productLine: null,
    department: null,
    category: null,
    visualFingerprint: null,
    fabricTech: [],
    era: null,
    msrpBand: null,
    keywords: [],
  };
}

function decodedFrom(
  opts: {
    brand?: string;
    styleName?: string;
    styleCode?: string;
  },
): DecodedExtraction {
  const suggestions: Record<string, FieldSuggestion> = {};
  if (opts.brand) {
    suggestions.brand = {
      value: opts.brand,
      confidence: 0.6,
      source: "photo:front",
    };
  }
  if (opts.styleName) {
    suggestions.style = {
      value: opts.styleName,
      confidence: 0.7,
      source: "photo:tag",
    };
  }
  const attributes: Record<string, AttributeSuggestion> = opts.styleCode
    ? {
      style_code: {
        values: [opts.styleCode],
        confidence: 0.3,
        source: "photo:tag",
      },
    }
    : {};
  return {
    suggestions,
    attributes,
    research: null,
    conditionSummary: null,
    conflicts: [],
    measurements: null,
    ebayCategoryQuery: null,
  };
}

// ── golden cases ────────────────────────────────────────────────────────────
interface GoldenCase {
  name: string;
  brand: string; // for the per-brand recovery summary
  pack: BrandKnowledgePack;
  input: DecodedExtraction;
  expect: {
    brand?: string;
    noBrand?: boolean;
    style?: string;
    noStyle?: boolean;
    conflictOn?: string;
    recovery?: boolean; // counts toward the per-brand recovery rate
  };
}

const CASES: GoldenCase[] = [
  {
    name: "Lululemon cut brand tag — style number recovers the brand",
    brand: "Lululemon",
    pack: pack("Lululemon", "lululemon"),
    input: decodedFrom({ styleCode: "WU1ABC.0119" }), // no AI brand
    expect: { brand: "Lululemon", recovery: true },
  },
  {
    name: "Lululemon style number overrides a wrong AI brand + surfaces conflict",
    brand: "Lululemon",
    pack: pack("Lululemon", "lululemon"),
    input: decodedFrom({ brand: "Nike", styleCode: "WU1ABC.0119" }),
    expect: { brand: "Lululemon", conflictOn: "brand", recovery: true },
  },
  {
    name: "Lululemon AI+decoder agree — no conflict",
    brand: "Lululemon",
    pack: pack("Lululemon", "lululemon"),
    input: decodedFrom({ brand: "Lululemon", styleCode: "MABCR.0322" }),
    expect: { brand: "Lululemon", recovery: true },
  },
  {
    name: "Single known style fills when the AI produced none",
    brand: "Lululemon",
    pack: pack("Lululemon", "lululemon", [style("ABC Pant")]),
    input: decodedFrom({ styleCode: "WU1ABC.0119" }),
    expect: { brand: "Lululemon", style: "ABC Pant", recovery: true },
  },
  {
    name: "Ambiguous styles — never guess a style",
    brand: "Lululemon",
    pack: pack("Lululemon", "lululemon", [
      style("ABC Pant"),
      style("Commission Pant"),
    ]),
    input: decodedFrom({ styleCode: "WU1ABC.0119" }),
    expect: { brand: "Lululemon", noStyle: true, recovery: true },
  },
  {
    name: "Malformed code — no false-positive recovery",
    brand: "Lululemon",
    pack: pack("Lululemon", "lululemon"),
    input: decodedFrom({ styleCode: "NOT-A-CODE" }),
    expect: { noBrand: true },
  },
  {
    name: "Brand with no decoder + no code — clean no-op",
    brand: "Gap",
    pack: pack("Gap", "gap"),
    input: decodedFrom({ brand: "Gap" }),
    expect: { brand: "Gap" },
  },
  // US-1731: Alo Yoga has NO tag-code decoder (identity = fabric line + care tag),
  // so its golden cases prove the enrichment stays correct without one — a single
  // known style fills the style the AI missed, ambiguous styles are never guessed
  // (Airlift vs Airbrush), and a non-code never false-recovers a brand.
  {
    name: "Alo single known style fills the style the AI missed",
    brand: "Alo Yoga",
    pack: pack("Alo Yoga", "aloyoga", [style("Airlift Legging")]),
    input: decodedFrom({ brand: "Alo Yoga" }),
    expect: { brand: "Alo Yoga", style: "Airlift Legging" },
  },
  {
    name: "Alo ambiguous styles (Airlift vs Airbrush) — never guess a style",
    brand: "Alo Yoga",
    pack: pack("Alo Yoga", "aloyoga", [style("Airlift Legging"), style("Airbrush Legging")]),
    input: decodedFrom({ brand: "Alo Yoga" }),
    expect: { brand: "Alo Yoga", noStyle: true },
  },
  {
    name: "Alo non-code tag — no false-positive brand recovery (no decoder)",
    brand: "Alo Yoga",
    pack: pack("Alo Yoga", "aloyoga", [style("Airlift Legging"), style("Airbrush Legging")]),
    input: decodedFrom({ styleCode: "NOT-A-CODE" }),
    expect: { noBrand: true },
  },
  // US-1732: Athleta — also decoder-less (fabric line + care-tag size). Same
  // guarantees: single known style fills, its confusable Powervita pair is never
  // guessed, and a non-code never false-recovers a brand.
  {
    name: "Athleta single known style fills the style the AI missed",
    brand: "Athleta",
    pack: pack("Athleta", "athleta", [style("Salutation Tight")]),
    input: decodedFrom({ brand: "Athleta" }),
    expect: { brand: "Athleta", style: "Salutation Tight" },
  },
  {
    name: "Athleta ambiguous Powervita styles (Salutation vs Elation) — never guess",
    brand: "Athleta",
    pack: pack("Athleta", "athleta", [style("Salutation Tight"), style("Elation Tight")]),
    input: decodedFrom({ brand: "Athleta" }),
    expect: { brand: "Athleta", noStyle: true },
  },
  {
    name: "Athleta non-code tag — no false-positive brand recovery (no decoder)",
    brand: "Athleta",
    pack: pack("Athleta", "athleta", [style("Salutation Tight"), style("Elation Tight")]),
    input: decodedFrom({ styleCode: "NOT-A-CODE" }),
    expect: { noBrand: true },
  },
  // US-1729: Free People — decoder-less (sub-line + care-tag). Same guarantees:
  // a single known sub-line fills, ambiguous sub-lines are never guessed, and a
  // non-code never false-recovers a brand.
  {
    name: "Free People single known sub-line fills the style the AI missed",
    brand: "Free People",
    pack: pack("Free People", "freepeople", [style("We The Free")]),
    input: decodedFrom({ brand: "Free People" }),
    expect: { brand: "Free People", style: "We The Free" },
  },
  {
    name: "Free People ambiguous sub-lines (We The Free vs Intimately) — never guess",
    brand: "Free People",
    pack: pack("Free People", "freepeople", [style("We The Free"), style("Intimately")]),
    input: decodedFrom({ brand: "Free People" }),
    expect: { brand: "Free People", noStyle: true },
  },
  {
    name: "Free People non-code tag — no false-positive brand recovery (no decoder)",
    brand: "Free People",
    pack: pack("Free People", "freepeople", [style("We The Free"), style("Intimately")]),
    input: decodedFrom({ styleCode: "NOT-A-CODE" }),
    expect: { noBrand: true },
  },
  // US-1730: Madewell & J.Crew (sister banners, decoder-less — the item code is
  // not brand-unique so it must NEVER recover a brand). Same guarantees.
  {
    name: "Madewell single known fit fills the style the AI missed",
    brand: "Madewell",
    pack: pack("Madewell", "madewell", [style("The Perfect Vintage Jean")]),
    input: decodedFrom({ brand: "Madewell" }),
    expect: { brand: "Madewell", style: "The Perfect Vintage Jean" },
  },
  {
    name: "J.Crew ambiguous fits (484 vs 770) — never guess a fit",
    brand: "J.Crew",
    pack: pack("J.Crew", "jcrew", [style("484 Slim"), style("770 Straight")]),
    input: decodedFrom({ brand: "J.Crew" }),
    expect: { brand: "J.Crew", noStyle: true },
  },
  {
    name: "Madewell generic item code — no false-positive brand recovery",
    brand: "Madewell",
    pack: pack("Madewell", "madewell", [style("The Perfect Vintage Jean"), style("Roadtripper Jean")]),
    input: decodedFrom({ styleCode: "NW282" }),
    expect: { noBrand: true },
  },
  // US-1733 athleisure group. Under Armour is the ONLY brand here with a
  // tag-printed decodable code, so it carries the group's CUT-TAG cases: the
  // 00452 style_number spec must recover the brand from a bare style number with
  // no AI brand at all.
  {
    name: "Under Armour cut brand tag — tag-printed style number recovers the brand",
    brand: "Under Armour",
    pack: pack("Under Armour", "underarmour", [], [UA_STYLE_NUMBER_DECODER]),
    input: decodedFrom({ styleCode: "1361518" }), // no AI brand
    expect: { brand: "Under Armour", recovery: true },
  },
  {
    name: "Under Armour season-prefixed style number (FW24) still recovers the brand",
    brand: "Under Armour",
    pack: pack("Under Armour", "underarmour", [], [UA_STYLE_NUMBER_DECODER]),
    input: decodedFrom({ styleCode: "FW24 1361518" }),
    expect: { brand: "Under Armour", recovery: true },
  },
  {
    name: "Under Armour style number overrides a wrong AI brand + surfaces conflict",
    brand: "Under Armour",
    pack: pack("Under Armour", "underarmour", [], [UA_STYLE_NUMBER_DECODER]),
    input: decodedFrom({ brand: "Nike", styleCode: "STYLE 1361518" }),
    expect: { brand: "Under Armour", conflictOn: "brand", recovery: true },
  },
  {
    name: "Under Armour retailer color suffix (-001) is NOT decoded — no false recovery",
    brand: "Under Armour",
    // The 3-digit color suffix is retailer/catalog metadata, NOT verified as
    // tag-printed, so 00452's anchored pattern deliberately refuses it rather
    // than inventing a colorway decode.
    pack: pack("Under Armour", "underarmour", [], [UA_STYLE_NUMBER_DECODER]),
    input: decodedFrom({ styleCode: "1361518-001" }),
    expect: { noBrand: true },
  },
  {
    name: "Under Armour malformed code — no false-positive recovery",
    brand: "Under Armour",
    pack: pack("Under Armour", "underarmour", [], [UA_STYLE_NUMBER_DECODER]),
    input: decodedFrom({ styleCode: "NOT-A-CODE" }),
    expect: { noBrand: true },
  },
  {
    name: "Under Armour single known gear platform fills the line the AI missed",
    brand: "Under Armour",
    pack: pack("Under Armour", "underarmour", [style("HeatGear")], [UA_STYLE_NUMBER_DECODER]),
    input: decodedFrom({ brand: "Under Armour" }),
    expect: { brand: "Under Armour", style: "HeatGear" },
  },
  {
    name: "Under Armour ambiguous gear platforms (HeatGear vs ColdGear) — never guess",
    brand: "Under Armour",
    pack: pack("Under Armour", "underarmour", [style("HeatGear"), style("ColdGear")], [
      UA_STYLE_NUMBER_DECODER,
    ]),
    input: decodedFrom({ brand: "Under Armour" }),
    expect: { brand: "Under Armour", noStyle: true },
  },
  // The other five are decoder-less by design (identity = fabric platform read
  // off the garment). Their guarantee is that enrichment stays correct WITHOUT a
  // decoder: a lone known platform fills, the confusable pair is never guessed,
  // and a non-code never false-recovers a brand.
  {
    name: "Vuori single known style fills the style the AI missed",
    brand: "Vuori",
    pack: pack("Vuori", "vuori", [style("Kore Short")]),
    input: decodedFrom({ brand: "Vuori" }),
    expect: { brand: "Vuori", style: "Kore Short" },
  },
  {
    name: "Vuori ambiguous shorts (Kore vs Banks Session) — never guess a style",
    brand: "Vuori",
    pack: pack("Vuori", "vuori", [style("Kore Short"), style("Banks Session Short")]),
    input: decodedFrom({ brand: "Vuori" }),
    expect: { brand: "Vuori", noStyle: true },
  },
  {
    name: "Vuori non-code tag — no false-positive brand recovery (no decoder)",
    brand: "Vuori",
    pack: pack("Vuori", "vuori", [style("Kore Short"), style("Ponto Performance Jogger")]),
    input: decodedFrom({ styleCode: "V438HBK" }),
    expect: { noBrand: true },
  },
  {
    name: "Gymshark single known seamless family fills the style the AI missed",
    brand: "Gymshark",
    pack: pack("Gymshark", "gymshark", [style("Vital Seamless")]),
    input: decodedFrom({ brand: "Gymshark" }),
    expect: { brand: "Gymshark", style: "Vital Seamless" },
  },
  {
    name: "Gymshark ambiguous seamless families (Vital marl vs Adapt print) — never guess",
    brand: "Gymshark",
    pack: pack("Gymshark", "gymshark", [style("Vital Seamless"), style("Adapt Seamless")]),
    input: decodedFrom({ brand: "Gymshark" }),
    expect: { brand: "Gymshark", noStyle: true },
  },
  {
    name: "Gymshark web SKU slug — no false-positive brand recovery (not a tag code)",
    brand: "Gymshark",
    pack: pack("Gymshark", "gymshark", [style("Vital Seamless"), style("Adapt Seamless")]),
    input: decodedFrom({ styleCode: "SS25" }),
    expect: { noBrand: true },
  },
  {
    name: "Fabletics single known fabric platform fills the style the AI missed",
    brand: "Fabletics",
    pack: pack("Fabletics", "fabletics", [style("PowerHold")]),
    input: decodedFrom({ brand: "Fabletics" }),
    expect: { brand: "Fabletics", style: "PowerHold" },
  },
  {
    name: "Fabletics ambiguous compression ladder (PowerHold vs PureLuxe) — never guess",
    brand: "Fabletics",
    pack: pack("Fabletics", "fabletics", [style("PowerHold"), style("PureLuxe")]),
    input: decodedFrom({ brand: "Fabletics" }),
    expect: { brand: "Fabletics", noStyle: true },
  },
  {
    name: "Fabletics web SKU — no false-positive brand recovery (not tag-printed)",
    brand: "Fabletics",
    pack: pack("Fabletics", "fabletics", [style("PowerHold"), style("PureLuxe")]),
    input: decodedFrom({ styleCode: "PT1617843-0001" }),
    expect: { noBrand: true },
  },
  {
    name: "Beyond Yoga single known fabric platform fills the style the AI missed",
    brand: "Beyond Yoga",
    pack: pack("Beyond Yoga", "beyondyoga", [style("Spacedye")]),
    input: decodedFrom({ brand: "Beyond Yoga" }),
    expect: { brand: "Beyond Yoga", style: "Spacedye" },
  },
  {
    name: "Beyond Yoga ambiguous heathered platforms (Spacedye vs Heather Rib) — never guess",
    brand: "Beyond Yoga",
    pack: pack("Beyond Yoga", "beyondyoga", [style("Spacedye"), style("Heather Rib")]),
    input: decodedFrom({ brand: "Beyond Yoga" }),
    expect: { brand: "Beyond Yoga", noStyle: true },
  },
  {
    name: "Beyond Yoga SD web code — no false-positive brand recovery (web-side only)",
    brand: "Beyond Yoga",
    // SD/HR/IT genuinely encode the fabric, but ONLY in product URLs — there's
    // no evidence they're tag-printed, so 00452 records the prefix map as an
    // informational tell and seeds NO decoder. This case locks that in.
    pack: pack("Beyond Yoga", "beyondyoga", [style("Spacedye"), style("Heather Rib")]),
    input: decodedFrom({ styleCode: "SD3243" }),
    expect: { noBrand: true },
  },
  {
    name: "Sweaty Betty single known legging family fills the style the AI missed",
    brand: "Sweaty Betty",
    pack: pack("Sweaty Betty", "sweatybetty", [style("Power")]),
    input: decodedFrom({ brand: "Sweaty Betty" }),
    expect: { brand: "Sweaty Betty", style: "Power" },
  },
  {
    name: "Sweaty Betty ambiguous legging families (Power vs Zero Gravity) — never guess",
    brand: "Sweaty Betty",
    pack: pack("Sweaty Betty", "sweatybetty", [style("Power"), style("Zero Gravity")]),
    input: decodedFrom({ brand: "Sweaty Betty" }),
    expect: { brand: "Sweaty Betty", noStyle: true },
  },
  {
    name: "Sweaty Betty SB web code — no false-positive brand recovery (lookup only)",
    brand: "Sweaty Betty",
    pack: pack("Sweaty Betty", "sweatybetty", [style("Power"), style("Zero Gravity")]),
    input: decodedFrom({ styleCode: "SB6438Z" }),
    expect: { noBrand: true },
  },
];

// ── the gate ────────────────────────────────────────────────────────────────
Deno.test("brand-knowledge golden set — all cases recover as expected", () => {
  // per-brand tally: recovered / expected
  const tally = new Map<string, { recovered: number; expected: number }>();
  let confDeltaSum = 0;
  let confDeltaN = 0;

  for (const c of CASES) {
    const before = c.input.suggestions.brand?.confidence ?? 0;
    const { decoded: out } = enrichExtractionWithBrandKnowledge(c.input, c.pack);

    if (c.expect.brand !== undefined) {
      assertEquals(
        out.suggestions.brand?.value,
        c.expect.brand,
        `${c.name}: brand`,
      );
    }
    if (c.expect.noBrand) {
      assertEquals(out.suggestions.brand, undefined, `${c.name}: no brand`);
    }
    if (c.expect.style !== undefined) {
      assertEquals(
        out.suggestions.style?.value,
        c.expect.style,
        `${c.name}: style`,
      );
    }
    if (c.expect.noStyle) {
      assertEquals(out.suggestions.style, undefined, `${c.name}: no style`);
    }
    if (c.expect.conflictOn) {
      assert(
        out.conflicts.some((cf) => cf.field === c.expect.conflictOn),
        `${c.name}: expected a ${c.expect.conflictOn} conflict`,
      );
    }

    if (c.expect.recovery) {
      const t = tally.get(c.brand) ?? { recovered: 0, expected: 0 };
      t.expected += 1;
      if (out.suggestions.brand?.value === c.expect.brand) t.recovered += 1;
      tally.set(c.brand, t);
      const after = out.suggestions.brand?.confidence ?? 0;
      confDeltaSum += after - before;
      confDeltaN += 1;
    }
  }

  // AC3 — measurable per-brand recovery + mean confidence delta.
  const summary = [...tally.entries()]
    .map(([b, t]) =>
      `${b}: ${t.recovered}/${t.expected} (${
        Math.round((t.recovered / t.expected) * 100)
      }%)`
    )
    .join("  ");
  const meanDelta = confDeltaN > 0 ? (confDeltaSum / confDeltaN).toFixed(2) : "0";
  console.log(
    `[brand-golden] recovery — ${summary}  | mean brand-confidence Δ vs pre-KB: +${meanDelta}`,
  );

  // Gate: every recovery-expected case must recover.
  for (const [b, t] of tally) {
    assertEquals(t.recovered, t.expected, `${b} had unrecovered golden cases`);
  }
});
