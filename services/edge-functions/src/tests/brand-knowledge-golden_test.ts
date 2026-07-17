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

// US-1734: the Arc'teryx style_name decoder EXACTLY as migration 00453 seeds it
// into brand_style_codes. Arc'teryx is the only brand in the outdoor group whose
// garment-printed identifier is REGULAR — and it is a NAME system, not a number:
// [MODEL] + [weight-class SUFFIX]. Fixturing the shipped spec is the point: a bad
// pattern in the migration fails here rather than in production.
const ARCTERYX_STYLE_NAME_DECODER: BrandDecoder = {
  decoderKind: "style_name",
  description:
    'Arc\'teryx MODEL + weight-class SUFFIX printed on the garment/tag (SL/LT/AR/SV/MX/FL) — e.g. "Atom LT", "Beta AR".',
  pattern:
    "^(?<style>(?:Alpha|Beta|Gamma|Zeta|Atom|Cerium|Proton|Delta|Nuclei|Sabre|Sentinel|Rush|Kyanite|Incendo|Squamish)\\s+(?:SL|LT|AR|SV|MX|FL))$",
  extractionRules: {
    fieldMap: { style: "styleCode" },
    transforms: { style: "upper" },
    confidence: 0.7,
  },
  examples: [],
};

// US-1735: the Wrangler style_number decoder EXACTLY as migration 00454 seeds it.
// "13MWZ" = 13-ounce Men's With Zipper — the MW/MJ/DEN suffix family is a
// Wrangler-only convention, which is what makes an anchored digits+suffix pattern
// a safe cut-tag recovery. Fixturing the shipped spec means a bad pattern in the
// migration fails here rather than in production.
const WRANGLER_STYLE_NUMBER_DECODER: BrandDecoder = {
  decoderKind: "style_number",
  description:
    "Wrangler tag-printed model number: the MW family (digits = denim weight, MW = Men's Western, Z = zip fly, J = jacket) — e.g. \"13MWZ\", \"47MWZ\", \"11MJ\" — or the DEN slim-fit form, e.g. \"936DEN\".",
  pattern: "^(?:(?<style>\\d{2,3}(?:MWZPW|MWZ|MWJ|MJZ|MJ|MW))|(?<slim>\\d{3}DEN))$",
  extractionRules: {
    fieldMap: { style: "styleCode", slim: "styleCode" },
    transforms: { style: "upper", slim: "upper" },
    confidence: 0.7,
  },
  examples: [],
};

// US-1735: the True Religion style_name decoder EXACTLY as migration 00454 seeds
// it. This is the denim group's CUT-TAG case and it mirrors the Arc'teryx
// model+suffix precedent above: "Ricky" is an ordinary first name and "Super T"
// could be a size, but the COMPOUND is True-Religion-unique — so requiring both
// parts is what makes the recovery safe.
const TRUE_RELIGION_STYLE_NAME_DECODER: BrandDecoder = {
  decoderKind: "style_name",
  description:
    'True Religion MODEL + stitch-weight SUFFIX printed on the tag (Super T = the thickest contrast topstitch, Big T = the thick grade) — e.g. "Ricky Super T", "Joey Big T".',
  pattern:
    "^(?<style>(?:Ricky|Billy|Joey|Bobby|Becky|Geno|Johnny|Casey|Carrie|Disco|Jack|Cameron)\\s+(?:Super\\s*T|Big\\s*T))$",
  extractionRules: {
    fieldMap: { style: "styleCode" },
    transforms: { style: "upper" },
    confidence: 0.7,
  },
  examples: [],
};

// US-1736: the Kate Spade style_number decoder EXACTLY as migration 00455 seeds
// it. It is the LUXURY group's ONLY decoder, and the 4-letter family prefix is
// precisely what makes it safe: the digits alone would be an ordinary number.
// Fixturing the shipped spec means a bad pattern in the migration fails here
// rather than in production.
const KATE_SPADE_STYLE_NUMBER_DECODER: BrandDecoder = {
  decoderKind: "style_number",
  description:
    "Kate Spade tag-printed style number: a 4-letter family prefix + 4 digits (e.g. PXRU5228, WKRU2673). Identifies the STYLE FAMILY only — it does not encode size, colorway or tier, and it does not authenticate.",
  pattern: "^(?<style>(?:PXRU|WKRU|PXRC|WKRC)[0-9]{4})$",
  extractionRules: {
    fieldMap: { style: "styleCode" },
    transforms: { style: "upper" },
    confidence: 0.55,
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
  // US-1734 outdoor & technical group. Arc'teryx carries the group's CUT-TAG
  // cases: with the brand tag gone, the model+suffix left on the garment is
  // enough for 00453's spec to recover the brand on its own.
  {
    name: "Arc'teryx cut brand tag — the model+suffix recovers the brand",
    brand: "Arc'teryx",
    pack: pack("Arc'teryx", "arcteryx", [], [ARCTERYX_STYLE_NAME_DECODER]),
    input: decodedFrom({ styleCode: "Atom LT" }), // no AI brand
    expect: { brand: "Arc'teryx", recovery: true },
  },
  {
    name: "Arc'teryx Beta AR also recovers the brand off a cut tag",
    brand: "Arc'teryx",
    pack: pack("Arc'teryx", "arcteryx", [], [ARCTERYX_STYLE_NAME_DECODER]),
    input: decodedFrom({ styleCode: "Beta AR" }),
    expect: { brand: "Arc'teryx", recovery: true },
  },
  {
    name: "Arc'teryx model+suffix overrides a wrong AI brand + surfaces conflict",
    brand: "Arc'teryx",
    pack: pack("Arc'teryx", "arcteryx", [], [ARCTERYX_STYLE_NAME_DECODER]),
    input: decodedFrom({ brand: "The North Face", styleCode: "Alpha SV" }),
    expect: { brand: "Arc'teryx", conflictOn: "brand", recovery: true },
  },
  {
    name: "Arc'teryx bare model word — no false-positive recovery",
    // "Alpha" on its own is ordinary English; 00453's pattern requires the
    // SUFFIX too, precisely so a tag that merely says "Alpha" can't mint a brand.
    brand: "Arc'teryx",
    pack: pack("Arc'teryx", "arcteryx", [], [ARCTERYX_STYLE_NAME_DECODER]),
    input: decodedFrom({ styleCode: "Alpha" }),
    expect: { noBrand: true },
  },
  {
    name: "Arc'teryx bare suffix — no false-positive recovery",
    brand: "Arc'teryx",
    pack: pack("Arc'teryx", "arcteryx", [], [ARCTERYX_STYLE_NAME_DECODER]),
    input: decodedFrom({ styleCode: "AR" }),
    expect: { noBrand: true },
  },
  {
    name: "Arc'teryx ambiguous insulation lines (Atom synthetic vs Cerium down) — never guess",
    brand: "Arc'teryx",
    pack: pack("Arc'teryx", "arcteryx", [style("Atom"), style("Cerium")], [
      ARCTERYX_STYLE_NAME_DECODER,
    ]),
    input: decodedFrom({ brand: "Arc'teryx" }),
    expect: { brand: "Arc'teryx", noStyle: true },
  },
  // The other five are decoder-less by design: their item numbers are retailer
  // SKUs, not brand-unique formats. Their guarantee is that enrichment stays
  // correct WITHOUT a decoder.
  {
    name: "Columbia single known style fills the style the AI missed",
    brand: "Columbia",
    pack: pack("Columbia", "columbia", [style("Steens Mountain")]),
    input: decodedFrom({ brand: "Columbia" }),
    expect: { brand: "Columbia", style: "Steens Mountain" },
  },
  {
    name: "Columbia ambiguous Interchange parkas (Bugaboo vs Whirlibird) — never guess",
    brand: "Columbia",
    pack: pack("Columbia", "columbia", [style("Bugaboo"), style("Whirlibird")]),
    input: decodedFrom({ brand: "Columbia" }),
    expect: { brand: "Columbia", noStyle: true },
  },
  {
    name: "Columbia retailer item number — no false-positive brand recovery (no decoder)",
    brand: "Columbia",
    pack: pack("Columbia", "columbia", [style("Bugaboo"), style("Whirlibird")]),
    input: decodedFrom({ styleCode: "WM1234-010" }),
    expect: { noBrand: true },
  },
  {
    name: "Marmot single known style fills the style the AI missed",
    brand: "Marmot",
    pack: pack("Marmot", "marmot", [style("PreCip")]),
    input: decodedFrom({ brand: "Marmot" }),
    expect: { brand: "Marmot", style: "PreCip" },
  },
  {
    name: "Marmot ambiguous rain shells (MemBrain PreCip vs Gore-Tex Minimalist) — never guess",
    brand: "Marmot",
    pack: pack("Marmot", "marmot", [style("PreCip"), style("Minimalist")]),
    input: decodedFrom({ brand: "Marmot" }),
    expect: { brand: "Marmot", noStyle: true },
  },
  {
    name: "Marmot retailer item number — no false-positive brand recovery (no decoder)",
    brand: "Marmot",
    pack: pack("Marmot", "marmot", [style("PreCip"), style("Minimalist")]),
    input: decodedFrom({ styleCode: "41200-001" }),
    expect: { noBrand: true },
  },
  {
    name: "REI Co-op single known style fills the style the AI missed",
    brand: "REI Co-op",
    pack: pack("REI Co-op", "reicoop", [style("Rainier Rain Jacket")]),
    input: decodedFrom({ brand: "REI Co-op" }),
    expect: { brand: "REI Co-op", style: "Rainier Rain Jacket" },
  },
  {
    name: "REI Co-op ambiguous shells (coated Rainier vs Gore-Tex XeroDry) — never guess",
    brand: "REI Co-op",
    pack: pack("REI Co-op", "reicoop", [style("Rainier Rain Jacket"), style("XeroDry GTX")]),
    input: decodedFrom({ brand: "REI Co-op" }),
    expect: { brand: "REI Co-op", noStyle: true },
  },
  {
    name: "REI Co-op item number — no false-positive brand recovery (no decoder)",
    brand: "REI Co-op",
    pack: pack("REI Co-op", "reicoop", [style("Rainier Rain Jacket"), style("XeroDry GTX")]),
    input: decodedFrom({ styleCode: "1234567" }),
    expect: { noBrand: true },
  },
  {
    name: "L.L.Bean single known style fills the style the AI missed",
    brand: "L.L.Bean",
    pack: pack("L.L.Bean", "llbean", [style("Bean Boot")]),
    input: decodedFrom({ brand: "L.L.Bean" }),
    expect: { brand: "L.L.Bean", style: "Bean Boot" },
  },
  {
    name: "L.L.Bean ambiguous heritage models (Bean Boot vs Boat and Tote) — never guess",
    brand: "L.L.Bean",
    pack: pack("L.L.Bean", "llbean", [style("Bean Boot"), style("Boat and Tote")]),
    input: decodedFrom({ brand: "L.L.Bean" }),
    expect: { brand: "L.L.Bean", noStyle: true },
  },
  {
    name: "L.L.Bean item number — no false-positive brand recovery (no decoder)",
    brand: "L.L.Bean",
    pack: pack("L.L.Bean", "llbean", [style("Bean Boot"), style("Boat and Tote")]),
    input: decodedFrom({ styleCode: "TA512345" }),
    expect: { noBrand: true },
  },
  {
    name: "Mountain Hardwear single known style fills the style the AI missed",
    brand: "Mountain Hardwear",
    pack: pack("Mountain Hardwear", "mountainhardwear", [style("Ghost Whisperer")]),
    input: decodedFrom({ brand: "Mountain Hardwear" }),
    expect: { brand: "Mountain Hardwear", style: "Ghost Whisperer" },
  },
  {
    name: "Mountain Hardwear ambiguous down jackets (Ghost Whisperer vs Stretchdown) — never guess",
    brand: "Mountain Hardwear",
    pack: pack("Mountain Hardwear", "mountainhardwear", [
      style("Ghost Whisperer"),
      style("Stretchdown"),
    ]),
    input: decodedFrom({ brand: "Mountain Hardwear" }),
    expect: { brand: "Mountain Hardwear", noStyle: true },
  },
  {
    name: "Mountain Hardwear item number — no false-positive brand recovery (no decoder)",
    brand: "Mountain Hardwear",
    pack: pack("Mountain Hardwear", "mountainhardwear", [
      style("Ghost Whisperer"),
      style("Stretchdown"),
    ]),
    input: decodedFrom({ styleCode: "OM1234" }),
    expect: { noBrand: true },
  },
  // US-1735 premium & vintage denim group. Two brands carry the CUT-TAG cases:
  // Wrangler (a tag-printed model number) and True Religion (a model + stitch-
  // weight compound). The other four print a fit NAME, not a code, so their
  // guarantee is that enrichment stays correct WITHOUT a decoder.
  {
    name: "Wrangler cut brand tag — the 13MWZ model number recovers the brand",
    brand: "Wrangler",
    pack: pack("Wrangler", "wrangler", [], [WRANGLER_STYLE_NUMBER_DECODER]),
    input: decodedFrom({ styleCode: "13MWZ" }), // no AI brand
    expect: { brand: "Wrangler", recovery: true },
  },
  {
    name: "Wrangler 936DEN (the DEN slim-fit branch) also recovers the brand",
    brand: "Wrangler",
    pack: pack("Wrangler", "wrangler", [], [WRANGLER_STYLE_NUMBER_DECODER]),
    input: decodedFrom({ styleCode: "936DEN" }),
    expect: { brand: "Wrangler", recovery: true },
  },
  {
    name: "Wrangler 11MJ (the jacket suffix) also recovers the brand",
    brand: "Wrangler",
    pack: pack("Wrangler", "wrangler", [], [WRANGLER_STYLE_NUMBER_DECODER]),
    input: decodedFrom({ styleCode: "11MJ" }),
    expect: { brand: "Wrangler", recovery: true },
  },
  {
    name: "Wrangler model number overrides a wrong AI brand + surfaces conflict",
    // Levi's is the plausible wrong answer on an unlabelled western jean, which
    // is exactly why the tag-printed number has to win.
    brand: "Wrangler",
    pack: pack("Wrangler", "wrangler", [], [WRANGLER_STYLE_NUMBER_DECODER]),
    input: decodedFrom({ brand: "Levi's", styleCode: "13MWZ" }),
    expect: { brand: "Wrangler", conflictOn: "brand", recovery: true },
  },
  {
    name: "Wrangler bare denim weight — no false-positive recovery",
    // "13" alone is an ordinary number; 00454's pattern requires the MW suffix
    // precisely so a tag that merely says 13 can't mint a brand.
    brand: "Wrangler",
    pack: pack("Wrangler", "wrangler", [], [WRANGLER_STYLE_NUMBER_DECODER]),
    input: decodedFrom({ styleCode: "13" }),
    expect: { noBrand: true },
  },
  {
    name: "Wrangler bare suffix — no false-positive recovery",
    brand: "Wrangler",
    pack: pack("Wrangler", "wrangler", [], [WRANGLER_STYLE_NUMBER_DECODER]),
    input: decodedFrom({ styleCode: "MWZ" }),
    expect: { noBrand: true },
  },
  {
    name: "Wrangler ambiguous Cowboy Cut fits (13MWZ vs 936DEN) — never guess",
    brand: "Wrangler",
    pack: pack("Wrangler", "wrangler", [
      style("13MWZ Cowboy Cut"),
      style("936DEN Slim Fit"),
    ], [WRANGLER_STYLE_NUMBER_DECODER]),
    input: decodedFrom({ brand: "Wrangler" }),
    expect: { brand: "Wrangler", noStyle: true },
  },
  {
    name: "True Religion cut brand tag — model+stitch-weight recovers the brand",
    brand: "True Religion",
    pack: pack("True Religion", "truereligion", [], [
      TRUE_RELIGION_STYLE_NAME_DECODER,
    ]),
    input: decodedFrom({ styleCode: "Ricky Super T" }), // no AI brand
    expect: { brand: "True Religion", recovery: true },
  },
  {
    name: "True Religion Joey Big T also recovers the brand off a cut tag",
    brand: "True Religion",
    pack: pack("True Religion", "truereligion", [], [
      TRUE_RELIGION_STYLE_NAME_DECODER,
    ]),
    input: decodedFrom({ styleCode: "Joey Big T" }),
    expect: { brand: "True Religion", recovery: true },
  },
  {
    name: "True Religion bare fit name — no false-positive recovery",
    // "Ricky" is an ordinary first name. This is the case the compound pattern
    // exists for: a bare fit name must never mint a brand.
    brand: "True Religion",
    pack: pack("True Religion", "truereligion", [], [
      TRUE_RELIGION_STYLE_NAME_DECODER,
    ]),
    input: decodedFrom({ styleCode: "Ricky" }),
    expect: { noBrand: true },
  },
  {
    name: "True Religion bare stitch grade — no false-positive recovery",
    brand: "True Religion",
    pack: pack("True Religion", "truereligion", [], [
      TRUE_RELIGION_STYLE_NAME_DECODER,
    ]),
    input: decodedFrom({ styleCode: "Super T" }),
    expect: { noBrand: true },
  },
  {
    name: "True Religion ambiguous fits (Ricky vs Billy) — never guess",
    brand: "True Religion",
    pack: pack("True Religion", "truereligion", [style("Ricky"), style("Billy")], [
      TRUE_RELIGION_STYLE_NAME_DECODER,
    ]),
    input: decodedFrom({ brand: "True Religion" }),
    expect: { brand: "True Religion", noStyle: true },
  },
  {
    name: "Lee single known style fills the style the AI missed",
    brand: "Lee",
    pack: pack("Lee", "lee", [style("101 Riders")]),
    input: decodedFrom({ brand: "Lee" }),
    expect: { brand: "Lee", style: "101 Riders" },
  },
  {
    name: "Lee ambiguous jackets (blanket-lined Storm Rider vs plain 101J) — never guess",
    brand: "Lee",
    pack: pack("Lee", "lee", [style("Storm Rider"), style("101J Denim Jacket")]),
    input: decodedFrom({ brand: "Lee" }),
    expect: { brand: "Lee", noStyle: true },
  },
  {
    name: "Lee 101 — no false-positive brand recovery (the 101 is a model, not a code)",
    // 00454 deliberately seeds NO Lee decoder: "101" is an ordinary number with
    // no brand-unique format, so a pattern over it would recover Lee from any tag
    // that happened to say 101. This case locks that decision in.
    brand: "Lee",
    pack: pack("Lee", "lee", [style("101 Riders"), style("Storm Rider")]),
    input: decodedFrom({ styleCode: "101" }),
    expect: { noBrand: true },
  },
  {
    name: "7 For All Mankind single known fit fills the style the AI missed",
    brand: "7 For All Mankind",
    pack: pack("7 For All Mankind", "7forallmankind", [style("Slimmy")]),
    input: decodedFrom({ brand: "7 For All Mankind" }),
    expect: { brand: "7 For All Mankind", style: "Slimmy" },
  },
  {
    name: "7 For All Mankind ambiguous men's fits (Slimmy vs Standard) — never guess",
    brand: "7 For All Mankind",
    pack: pack("7 For All Mankind", "7forallmankind", [
      style("Slimmy"),
      style("Standard"),
    ]),
    input: decodedFrom({ brand: "7 For All Mankind" }),
    expect: { brand: "7 For All Mankind", noStyle: true },
  },
  {
    name: "7 For All Mankind fit name — no false-positive brand recovery (no decoder)",
    brand: "7 For All Mankind",
    pack: pack("7 For All Mankind", "7forallmankind", [
      style("Slimmy"),
      style("Dojo"),
    ]),
    input: decodedFrom({ styleCode: "Slimmy" }),
    expect: { noBrand: true },
  },
  {
    name: "AG Jeans single known fit fills the style the AI missed",
    brand: "AG Jeans",
    pack: pack("AG Jeans", "agjeans", [style("Graduate")]),
    input: decodedFrom({ brand: "AG Jeans" }),
    expect: { brand: "AG Jeans", style: "Graduate" },
  },
  {
    name: "AG Jeans ambiguous men's fits (Graduate vs Tellis) — never guess",
    brand: "AG Jeans",
    pack: pack("AG Jeans", "agjeans", [style("Graduate"), style("Tellis")]),
    input: decodedFrom({ brand: "AG Jeans" }),
    expect: { brand: "AG Jeans", noStyle: true },
  },
  {
    name: "AG Jeans fit name — no false-positive brand recovery (no decoder)",
    brand: "AG Jeans",
    pack: pack("AG Jeans", "agjeans", [style("Graduate"), style("Farrah")]),
    input: decodedFrom({ styleCode: "Graduate" }),
    expect: { noBrand: true },
  },
  {
    name: "Citizens of Humanity single known fit fills the style the AI missed",
    brand: "Citizens of Humanity",
    pack: pack("Citizens of Humanity", "citizensofhumanity", [style("Rocket")]),
    input: decodedFrom({ brand: "Citizens of Humanity" }),
    expect: { brand: "Citizens of Humanity", style: "Rocket" },
  },
  {
    name: "Citizens of Humanity ambiguous fits (Rocket vs Emannuelle) — never guess",
    brand: "Citizens of Humanity",
    pack: pack("Citizens of Humanity", "citizensofhumanity", [
      style("Rocket"),
      style("Emannuelle"),
    ]),
    input: decodedFrom({ brand: "Citizens of Humanity" }),
    expect: { brand: "Citizens of Humanity", noStyle: true },
  },
  {
    name: "Citizens of Humanity fit name — no false-positive brand recovery (no decoder)",
    brand: "Citizens of Humanity",
    pack: pack("Citizens of Humanity", "citizensofhumanity", [
      style("Rocket"),
      style("Charlotte"),
    ]),
    input: decodedFrom({ styleCode: "Rocket" }),
    expect: { noBrand: true },
  },

  // ── US-1736: luxury & designer group ──────────────────────────────────────
  {
    name: "Kate Spade cut brand tag — the PXRU style number recovers the brand",
    // The luxury group's cut-tag case. The 4-letter family prefix is what makes
    // this safe to anchor on, and it is the group's only decoder.
    brand: "Kate Spade",
    pack: pack("Kate Spade", "katespade", [], [KATE_SPADE_STYLE_NUMBER_DECODER]),
    input: decodedFrom({ styleCode: "PXRU5228" }), // no AI brand
    expect: { brand: "Kate Spade", recovery: true },
  },
  {
    name: "Kate Spade WKRU family also recovers the brand off a cut tag",
    brand: "Kate Spade",
    pack: pack("Kate Spade", "katespade", [], [KATE_SPADE_STYLE_NUMBER_DECODER]),
    input: decodedFrom({ styleCode: "WKRU2673" }),
    expect: { brand: "Kate Spade", recovery: true },
  },
  {
    name: "Kate Spade bare digits — no false-positive recovery",
    // The prefix is the whole safety margin: "5228" is an ordinary number and
    // must never mint a brand.
    brand: "Kate Spade",
    pack: pack("Kate Spade", "katespade", [], [KATE_SPADE_STYLE_NUMBER_DECODER]),
    input: decodedFrom({ styleCode: "5228" }),
    expect: { noBrand: true },
  },
  {
    name: "Chanel 8-digit serial — no false-positive brand recovery (no decoder)",
    // 00455 deliberately seeds NO Chanel decoder even though the interior serial
    // sticker IS tag-printed and regular — a bare 7-8 digit run is an ordinary
    // number, so a pattern over it would recover CHANEL, the most expensive false
    // positive in the KB, from any tag that happened to carry 8 digits. This is
    // the Lee "101" rule (00454) applied to the group's closest call, and this
    // case is what locks the decision in.
    brand: "Chanel",
    pack: pack("Chanel", "chanel", [style("Classic Flap"), style("2.55 Reissue")]),
    input: decodedFrom({ styleCode: "12345678" }),
    expect: { noBrand: true },
  },
  {
    name: "Chanel ambiguous flaps (Classic Flap vs 2.55 Reissue) — never guess",
    // The two are constantly conflated and priced differently; with only the
    // brand and no chain/lock evidence the resolver must not pick one.
    brand: "Chanel",
    pack: pack("Chanel", "chanel", [style("Classic Flap"), style("2.55 Reissue")]),
    input: decodedFrom({ brand: "Chanel" }),
    expect: { brand: "Chanel", noStyle: true },
  },
  {
    name: "Burberry single known style fills the style the AI missed",
    brand: "Burberry",
    pack: pack("Burberry", "burberry", [style("Kensington Trench")]),
    input: decodedFrom({ brand: "Burberry" }),
    expect: { brand: "Burberry", style: "Kensington Trench" },
  },
  {
    name: "Burberry ambiguous trenches (Kensington vs Chelsea vs Westminster) — never guess",
    // All three are the same gabardine coat in three cuts. The fit name is on the
    // tag; with the tag gone there is nothing to pick between them.
    brand: "Burberry",
    pack: pack("Burberry", "burberry", [
      style("Kensington Trench"),
      style("Chelsea Trench"),
      style("Westminster Trench"),
    ]),
    input: decodedFrom({ brand: "Burberry" }),
    expect: { brand: "Burberry", noStyle: true },
  },
  {
    name: "Burberry trench fit name — no false-positive brand recovery (no decoder)",
    brand: "Burberry",
    pack: pack("Burberry", "burberry", [
      style("Kensington Trench"),
      style("Chelsea Trench"),
    ]),
    input: decodedFrom({ styleCode: "Kensington" }),
    expect: { noBrand: true },
  },
  {
    name: "Prada single known line fills the style the AI missed",
    brand: "Prada",
    pack: pack("Prada", "prada", [style("Re-Nylon")]),
    input: decodedFrom({ brand: "Prada" }),
    expect: { brand: "Prada", style: "Re-Nylon" },
  },
  {
    name: "Prada ambiguous lines (Saffiano vs Galleria) — never guess",
    brand: "Prada",
    pack: pack("Prada", "prada", [style("Saffiano"), style("Galleria")]),
    input: decodedFrom({ brand: "Prada" }),
    expect: { brand: "Prada", noStyle: true },
  },
  {
    name: "Prada 'Saffiano' — no false-positive brand recovery (it is a FINISH, not a brand)",
    // The group's cross-brand trap, locked in: Saffiano is an industry-wide
    // finish that Michael Kors also uses, so a Saffiano token must never mint
    // Prada. 00455 seeds no Prada decoder for exactly this reason.
    brand: "Prada",
    pack: pack("Prada", "prada", [style("Saffiano"), style("Re-Nylon")]),
    input: decodedFrom({ styleCode: "Saffiano" }),
    expect: { noBrand: true },
  },
  {
    name: "Michael Kors single known line fills the style the AI missed",
    brand: "Michael Kors",
    pack: pack("Michael Kors", "michaelkors", [style("Jet Set")]),
    input: decodedFrom({ brand: "Michael Kors" }),
    expect: { brand: "Michael Kors", style: "Jet Set" },
  },
  {
    name: "Michael Kors ambiguous tiers (Collection vs MICHAEL) — never guess",
    // The tier is the price on this brand, so guessing it is the expensive error.
    // Both labels print their own name; with no tag there is nothing to read.
    brand: "Michael Kors",
    pack: pack("Michael Kors", "michaelkors", [
      style("Michael Kors Collection"),
      style("MICHAEL Michael Kors"),
    ]),
    input: decodedFrom({ brand: "Michael Kors" }),
    expect: { brand: "Michael Kors", noStyle: true },
  },
  {
    name: "Michael Kors line name — no false-positive brand recovery (no decoder)",
    brand: "Michael Kors",
    pack: pack("Michael Kors", "michaelkors", [
      style("Jet Set"),
      style("MK Signature"),
    ]),
    input: decodedFrom({ styleCode: "Jet Set" }),
    expect: { noBrand: true },
  },
  {
    name: "Kate Spade ambiguous tiers (mainline vs outlet) — never guess",
    brand: "Kate Spade",
    pack: pack("Kate Spade", "katespade", [
      style("kate spade new york"),
      style("Kate Spade Outlet"),
    ], [KATE_SPADE_STYLE_NUMBER_DECODER]),
    input: decodedFrom({ brand: "Kate Spade" }),
    expect: { brand: "Kate Spade", noStyle: true },
  },
  {
    name: "Tory Burch single known style fills the style the AI missed",
    brand: "Tory Burch",
    pack: pack("Tory Burch", "toryburch", [style("Reva Ballet Flat")]),
    input: decodedFrom({ brand: "Tory Burch" }),
    expect: { brand: "Tory Burch", style: "Reva Ballet Flat" },
  },
  {
    name: "Tory Burch ambiguous medallion shoes (Reva vs Miller) — never guess",
    brand: "Tory Burch",
    pack: pack("Tory Burch", "toryburch", [
      style("Reva Ballet Flat"),
      style("Miller Sandal"),
    ]),
    input: decodedFrom({ brand: "Tory Burch" }),
    expect: { brand: "Tory Burch", noStyle: true },
  },
  {
    name: "Tory Burch style name — no false-positive brand recovery (no decoder)",
    brand: "Tory Burch",
    pack: pack("Tory Burch", "toryburch", [style("Reva Ballet Flat"), style("Robinson")]),
    input: decodedFrom({ styleCode: "Reva" }),
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
