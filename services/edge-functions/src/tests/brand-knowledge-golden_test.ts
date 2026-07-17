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

// US-1981: the Canada Goose style_number decoder EXACTLY as migration 00460 seeds
// it into brand_style_codes. It is the ONLY decoder in the luxury outerwear group
// — the only code there that is tag-printed AND regular AND brand-unique in
// FORMAT. It also carries the group's CUT-TAG case: the style number lives on the
// CARE label, which survives the brand tag being cut out of the collar.
//
// THE DEPARTMENT LETTER IS THE WHOLE ARGUMENT. A bare "4660" is four digits and is
// nothing (the Chanel rule, US-1736 — a pattern over a bare digit run mints the
// KB's costliest false positive); "4660MA" can only be a Canada Goose style number.
//
// And that letter is deliberately NON-CAPTURING even though it genuinely encodes
// the department: the genderCode transform maps only M/W, so a captured "L" for
// LADIES' would pass through RAW as "L" and write garbage into a field the listing
// surfaces. Same call as US-1740's New Balance "U" — match on it, don't capture it.
const CANADA_GOOSE_STYLE_NUMBER_DECODER: BrandDecoder = {
  decoderKind: "style_number",
  description:
    "Canada Goose style number printed on the interior care label: 4 digits + a department letter (M = men's, L = ladies') + an optional 1-2 letter model suffix. 4660MA = Expedition Parka, 7950M = Chilliwack Bomber, 2506L = Kensington Parka.",
  pattern: "^(?<style>\\d{4}[ML][A-Z]{0,2})$",
  extractionRules: {
    fieldMap: { style: "styleCode" },
    confidence: 0.75,
  },
  examples: [],
};

// US-1739: the Uniqlo style_name decoder EXACTLY as migration 00458 seeds it into
// brand_style_codes. Uniqlo is the ONLY brand in the basics/mall group with a
// decoder, and it is the first in three groups — 00456 refused (the identifier is
// a GRAPHIC: not on the tag, not parseable) and 00457 refused (the identifier is
// an ordinary GIVEN NAME: not brand-unique). Uniqlo's fabric trademarks pass all
// three tests, on a kind of token no prior group had: HEATTECH and its siblings
// are COINED words that mean nothing in English, so — unlike "Juliette" or "TNA"
// — the token alone can identify the brand.
//
// That is what gives this group the CUT-TAG recovery case the last two could not
// have, and it is the exact scenario the whole epic exists for: brand tag gone,
// care label reads HEATTECH, brand recovers to Uniqlo. Fixturing the SHIPPED spec
// (rather than a hand-simplified one) is the point — a bad pattern or fieldMap in
// the migration fails here instead of in production.
const UNIQLO_FABRIC_TECH_DECODER: BrandDecoder = {
  decoderKind: "style_name",
  description:
    "Care/neck-label fabric-technology trademark. Uniqlo prints its coined fabric platform name on the label as the selling point; the token is brand-unique (it means nothing in English), so it identifies the brand even when the brand tag itself is cut. An optional trailing HEATTECH warmth level (Extra Warm / Ultra Warm) is tolerated but not captured.",
  pattern:
    "^(?<style>HEATTECH|AIRISM|BLOCKTECH|DRY-?EX)(?:\\s+(?:EXTRA\\s+WARM|ULTRA\\s+WARM))?$",
  extractionRules: {
    fieldMap: { style: "styleCode" },
    transforms: { style: "upper" },
    confidence: 0.72,
  },
  examples: [],
};

// US-1740: the New Balance style_number decoder EXACTLY as migration 00459 seeds
// it into brand_style_codes. New Balance is the ONLY brand in the footwear group
// with a decoder, and it is the first in this epic to capture a SECOND field
// beyond the brand — the prefix letter encodes the DEPARTMENT as well as
// identifying the brand, so one match yields gender AND styleCode.
//
// THE PREFIX IS THE WHOLE ARGUMENT. A bare "990" is three digits and is nothing;
// "M990" can only be a New Balance model number. That is also exactly why Dr.
// Martens gets no decoder in this same pack despite owning the most famous numbers
// in footwear: 1460/1461/2976 are printed and regular and have NO PREFIX, and four
// digits is not a brand. The "990 is not a code" case below pins that line.
//
// Fixturing the SHIPPED spec (rather than a hand-simplified one) is the point — a
// bad pattern or fieldMap in the migration fails here instead of in production.
const NEW_BALANCE_STYLE_NUMBER_DECODER: BrandDecoder = {
  decoderKind: "style_number",
  description:
    'Tongue-label / box model number. New Balance model numbers are [M|W|U] + 3-4 digits + an optional colour/version suffix. The PREFIX LETTER is what makes the token brand-unique (a bare "990" is nothing; "M990" can only be New Balance) and it also encodes the department, so one match recovers both the brand and the gender. The unisex "U" prefix matches but deliberately does NOT capture a gender — unisex is not a gender.',
  pattern: "^(?<style>(?:(?<gender>[MW])|U)\\d{3,4}[A-Z]{0,3}\\d?)$",
  extractionRules: {
    fieldMap: { style: "styleCode", gender: "gender" },
    transforms: { style: "upper", gender: "genderCode" },
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

  // ── US-1737: streetwear & hype group ──────────────────────────────────────
  // This is the FIRST group in the epic that seeds NO decoder, so it has no
  // cut-tag recovery case — and that absence is the thing under test. Streetwear
  // identity is a GRAPHIC, which is not on the tag and is not parseable, and the
  // season notation that actually drives the price is not tag-printed either. So
  // the whole group is no-false-recovery + never-guess, and the cases below are
  // what stop a future decoder from being added over an ordinary token.
  {
    name: "Supreme single known style fills the style the AI missed",
    brand: "Supreme",
    pack: pack("Supreme", "supreme", [style("Box Logo Tee")]),
    input: decodedFrom({ brand: "Supreme" }),
    expect: { brand: "Supreme", style: "Box Logo Tee" },
  },
  {
    name: "Supreme ambiguous box logo family (Tee vs Hoodie vs Small Box) — never guess",
    // All three carry the SAME graphic and differ only by garment and by the
    // logo's size/placement. With only the brand there is nothing to pick between
    // them, and they are different bands.
    brand: "Supreme",
    pack: pack("Supreme", "supreme", [
      style("Box Logo Tee"),
      style("Box Logo Hoodie"),
      style("Small Box Logo Tee"),
    ]),
    input: decodedFrom({ brand: "Supreme" }),
    expect: { brand: "Supreme", noStyle: true },
  },
  {
    name: "Supreme season code 'FW17' — no false-positive brand recovery (no decoder)",
    // THE case for this group. The season notation is genuinely regular and IS
    // the price, which is exactly what makes it tempting — but it is NOT
    // tag-printed (it is resolved against a release archive), so it is an
    // informational tell like the 00452 web codes, never a decoder. A pattern
    // over it would mint a Supreme, the most-counterfeited brand in the KB, from
    // any tag reading "FW17". This is the Lee "101" rule (00454) at its widest
    // blast radius, and this case is what locks the decision in.
    brand: "Supreme",
    pack: pack("Supreme", "supreme", [style("Box Logo Tee"), style("Box Logo Hoodie")]),
    input: decodedFrom({ styleCode: "FW17" }),
    expect: { noBrand: true },
  },
  {
    name: "Supreme 'Box Logo' — no false-positive brand recovery (a graphic is not a code)",
    brand: "Supreme",
    pack: pack("Supreme", "supreme", [style("Box Logo Tee")]),
    input: decodedFrom({ styleCode: "Box Logo" }),
    expect: { noBrand: true },
  },
  {
    name: "Supreme 'GG Supreme' — no false-positive recovery (it is GUCCI's canvas)",
    // The group's cross-brand trap, and the only one in the epic that collides
    // with a row ALREADY in the KB: GG Supreme is Gucci's coated monogram canvas
    // (00400). "Supreme" is an ordinary English adjective and Gucci uses it as
    // one, so a Supreme token must never mint this brand off a Gucci bag.
    brand: "Supreme",
    pack: pack("Supreme", "supreme", [style("Box Logo Tee")]),
    input: decodedFrom({ styleCode: "GG Supreme" }),
    expect: { noBrand: true },
  },
  {
    name: "Stüssy single known style fills the style the AI missed",
    brand: "Stüssy",
    pack: pack("Stüssy", "stssy", [style("Stock Logo Tee")]),
    input: decodedFrom({ brand: "Stüssy" }),
    expect: { brand: "Stüssy", style: "Stock Logo Tee" },
  },
  {
    name: "Stüssy ambiguous graphics (Stock vs World Tour) — never guess",
    // The World Tour's separator is a BACK print, so a front-only photo cannot
    // tell these apart at all.
    brand: "Stüssy",
    pack: pack("Stüssy", "stssy", [style("Stock Logo Tee"), style("World Tour Tee")]),
    input: decodedFrom({ brand: "Stüssy" }),
    expect: { brand: "Stüssy", noStyle: true },
  },
  {
    name: "BAPE single known style fills the style the AI missed",
    brand: "BAPE",
    pack: pack("BAPE", "bape", [style("Shark Full Zip Hoodie")]),
    input: decodedFrom({ brand: "BAPE" }),
    expect: { brand: "BAPE", style: "Shark Full Zip Hoodie" },
  },
  {
    name: "BAPE ambiguous graphics (Shark vs Ape Head) — never guess",
    brand: "BAPE",
    pack: pack("BAPE", "bape", [
      style("Shark Full Zip Hoodie"),
      style("Ape Head Logo Tee"),
    ]),
    input: decodedFrom({ brand: "BAPE" }),
    expect: { brand: "BAPE", noStyle: true },
  },
  {
    name: "BAPE 'Shark' — no false-positive brand recovery (no decoder)",
    brand: "BAPE",
    pack: pack("BAPE", "bape", [style("Shark Full Zip Hoodie")]),
    input: decodedFrom({ styleCode: "Shark" }),
    expect: { noBrand: true },
  },
  {
    name: "Kith single known style fills the style the AI missed",
    brand: "Kith",
    pack: pack("Kith", "kith", [style("Williams Hoodie")]),
    input: decodedFrom({ brand: "Kith" }),
    expect: { brand: "Kith", style: "Williams Hoodie" },
  },
  {
    name: "Palace ambiguous Tri-Ferg garments (Tee vs Hoodie) — never guess",
    brand: "Palace",
    pack: pack("Palace", "palace", [style("Tri-Ferg Tee"), style("Tri-Ferg Hoodie")]),
    input: decodedFrom({ brand: "Palace" }),
    expect: { brand: "Palace", noStyle: true },
  },
  {
    name: "Palace 'Tri-Ferg' — no false-positive brand recovery (no decoder)",
    brand: "Palace",
    pack: pack("Palace", "palace", [style("Tri-Ferg Tee")]),
    input: decodedFrom({ styleCode: "Tri-Ferg" }),
    expect: { noBrand: true },
  },
  {
    name: "Fear of God mainline resolves as its own brand, never as Essentials",
    // The pair is seeded as TWO brands because they are an order of magnitude
    // apart in price — comping one against the other is the group's most
    // expensive error, so each must stay put.
    brand: "Fear of God",
    pack: pack("Fear of God", "fearofgod", [style("Fear of God Mainline")]),
    input: decodedFrom({ brand: "Fear of God" }),
    expect: { brand: "Fear of God", style: "Fear of God Mainline" },
  },
  {
    name: "Fear of God Essentials resolves as its own brand, never as mainline",
    brand: "Fear of God Essentials",
    pack: pack("Fear of God Essentials", "fearofgodessentials", [
      style("Essentials Pullover Hoodie"),
    ]),
    input: decodedFrom({ brand: "Fear of God Essentials" }),
    expect: {
      brand: "Fear of God Essentials",
      style: "Essentials Pullover Hoodie",
    },
  },
  {
    name: "Fear of God ambiguous collection labels — never guess",
    brand: "Fear of God",
    pack: pack("Fear of God", "fearofgod", [
      style("Fear of God Mainline"),
      style("Numbered Collection"),
    ]),
    input: decodedFrom({ brand: "Fear of God" }),
    expect: { brand: "Fear of God", noStyle: true },
  },
  {
    name: "Essentials '1977' — no false-positive brand recovery (no decoder)",
    // "1977" is a bare year. It is a real Essentials print and a real dating hint,
    // and it is still just a number — decoding it would mint the brand from any
    // tag carrying a year.
    brand: "Fear of God Essentials",
    pack: pack("Fear of God Essentials", "fearofgodessentials", [
      style("Essentials Pullover Hoodie"),
    ]),
    input: decodedFrom({ styleCode: "1977" }),
    expect: { noBrand: true },
  },

  // ── US-1738: contemporary women's group ───────────────────────────────────
  // The second group in the epic with NO decoder, so — like the streetwear pack
  // — it has no cut-tag recovery case, and the absence is again the thing under
  // test. But the REASON is different and that is what these cases pin. 00456
  // refused because a GRAPHIC is not on the tag and is not parseable. This group
  // DOES print its identifier and the identifier IS regular: these brands name
  // their pieces, and the name is what the market searches. It fails the third
  // test — brand-unique — because every one of those names is an ordinary GIVEN
  // NAME. 00454 seeded True Religion only because "Ricky Super T" is a COMPOUND;
  // "Juliette" has no second part. The cases below are what stop a future
  // decoder from being written over a first name.
  {
    name: "Anthropologie house label (Maeve) fills the style the AI missed",
    // The group's defining shape: the TAG says MAEVE and the brand is
    // Anthropologie. The house label is the STYLE, so this is a style fill.
    brand: "Anthropologie",
    pack: pack("Anthropologie", "anthropologie", [style("Maeve")]),
    input: decodedFrom({ brand: "Anthropologie" }),
    expect: { brand: "Anthropologie", style: "Maeve" },
  },
  {
    name: "Anthropologie ambiguous house labels (Maeve vs Pilcro vs Moth) — never guess",
    // Each label is a different DEPARTMENT (dresses / denim / knits) and only the
    // neck tag separates them. With the brand alone there is nothing to pick.
    brand: "Anthropologie",
    pack: pack("Anthropologie", "anthropologie", [
      style("Maeve"),
      style("Pilcro"),
      style("Moth"),
    ]),
    input: decodedFrom({ brand: "Anthropologie" }),
    expect: { brand: "Anthropologie", noStyle: true },
  },
  {
    name: "Anthropologie 'Maeve' — no false-positive brand recovery (a given name is not a code)",
    // THE case for this group, and the exact mirror of the Lee "101" mistake.
    // "Maeve" is a real house label AND an ordinary given name. A decoder over it
    // would mint Anthropologie from any tag or title carrying a first name.
    brand: "Anthropologie",
    pack: pack("Anthropologie", "anthropologie", [style("Maeve")]),
    input: decodedFrom({ styleCode: "Maeve" }),
    expect: { noBrand: true },
  },
  {
    name: "Anthropologie 'Moth' — no false-positive recovery (it is a DAMAGE word first)",
    // The nastiest token in the pack: Moth is a real Anthropologie knit label, and
    // "moth holes" / "moth damage" appear constantly in the condition text this
    // very product generates. Recovering the brand from it would brand a garment
    // off a description of its own damage.
    brand: "Anthropologie",
    pack: pack("Anthropologie", "anthropologie", [style("Moth")]),
    input: decodedFrom({ styleCode: "Moth" }),
    expect: { noBrand: true },
  },
  {
    name: "Aritzia sub-label (Wilfred) fills the style the AI missed",
    // A Wilfred coat IS an Aritzia coat. The sub-labels share a price band, so
    // they fold onto one brand (the Michael Kors play) with the line in `style`.
    brand: "Aritzia",
    pack: pack("Aritzia", "aritzia", [style("Wilfred")]),
    input: decodedFrom({ brand: "Aritzia" }),
    expect: { brand: "Aritzia", style: "Wilfred" },
  },
  {
    name: "Aritzia ambiguous sub-labels (Wilfred vs Babaton vs TNA) — never guess",
    brand: "Aritzia",
    pack: pack("Aritzia", "aritzia", [
      style("Wilfred"),
      style("Babaton"),
      style("TNA"),
    ]),
    input: decodedFrom({ brand: "Aritzia" }),
    expect: { brand: "Aritzia", noStyle: true },
  },
  {
    name: "Aritzia 'TNA' — no false-positive brand recovery (three letters are not a code)",
    // TNA is a real Aritzia line and also a three-letter string that means other
    // things. This is the AG hazard (00454) in decoder form.
    brand: "Aritzia",
    pack: pack("Aritzia", "aritzia", [style("TNA")]),
    input: decodedFrom({ styleCode: "TNA" }),
    expect: { noBrand: true },
  },
  {
    name: "Reformation 'Juliette' — no false-positive brand recovery (no decoder)",
    // The purest statement of the group's rule. The style name IS the identity and
    // IS printed and IS regular — and it is still an ordinary woman's first name,
    // so it can never recover the brand.
    brand: "Reformation",
    pack: pack("Reformation", "reformation", [style("Juliette Dress")]),
    input: decodedFrom({ styleCode: "Juliette" }),
    expect: { noBrand: true },
  },
  {
    name: "Reformation ambiguous named dresses — never guess",
    // Many Reformation dresses share the bias-slip silhouette, so the photos
    // cannot separate the names. Only the seller or the tag can.
    brand: "Reformation",
    pack: pack("Reformation", "reformation", [
      style("Juliette Dress"),
      style("Named Dress"),
    ]),
    input: decodedFrom({ brand: "Reformation" }),
    expect: { brand: "Reformation", noStyle: true },
  },
  {
    name: "Sézane resolves under its accent-stripped key, never as a passthrough",
    // brandKey() strips the "é" with every other non-[a-z0-9] char, so the KB key
    // is 'szane' (the Stüssy 'stssy' lesson, 00456). The pack must still resolve.
    brand: "Sézane",
    pack: pack("Sézane", "szane", [style("Gaspard Jumper")]),
    input: decodedFrom({ brand: "Sézane" }),
    expect: { brand: "Sézane", style: "Gaspard Jumper" },
  },
  {
    name: "Sézane 'Gaspard' — no false-positive brand recovery (a given name is not a code)",
    brand: "Sézane",
    pack: pack("Sézane", "szane", [style("Gaspard Jumper")]),
    input: decodedFrom({ styleCode: "Gaspard" }),
    expect: { noBrand: true },
  },
  {
    name: "Sézane 'FR 38' — no false-positive brand recovery (a size is not a code)",
    // French sizing is this brand's biggest fact and is genuinely regular, which
    // is exactly what makes it tempting. It is a SIZE SYSTEM shared by every
    // French brand — decoding it would mint Sézane from any FR tag.
    brand: "Sézane",
    pack: pack("Sézane", "szane", [style("Gaspard Jumper")]),
    input: decodedFrom({ styleCode: "FR 38" }),
    expect: { noBrand: true },
  },
  {
    name: "Vince resolves as its own brand, never as Vince Camuto",
    // THE pair for this group. Two DIFFERENT COMPANIES sharing a first name — not
    // a mainline and a diffusion line. Each must stay put.
    brand: "Vince",
    pack: pack("Vince", "vince", [style("Vince Cashmere Knit")]),
    input: decodedFrom({ brand: "Vince" }),
    expect: { brand: "Vince", style: "Vince Cashmere Knit" },
  },
  {
    name: "Vince Camuto stays its own brand, never folded into Vince",
    // The other half. Folding these would comp an unrelated company's garment
    // against Vince's catalogue — structurally the Fear of God trap (00456), but
    // across two businesses rather than one designer's two lines.
    brand: "Vince Camuto",
    pack: pack("Vince Camuto", "vincecamuto"),
    input: decodedFrom({ brand: "Vince Camuto" }),
    expect: { brand: "Vince Camuto" },
  },
  {
    name: "Vince 'Vince Camuto' — no false-positive recovery of Vince",
    brand: "Vince",
    pack: pack("Vince", "vince", [style("Vince Cashmere Knit")]),
    input: decodedFrom({ styleCode: "Vince Camuto" }),
    expect: { noBrand: true },
  },
  {
    name: "Theory ambiguous fabric platforms (Good Wool vs Good Linen) — never guess",
    // The fabric platform is Theory's identity and a photo cannot show fibre, so
    // with the brand alone there is nothing to choose between them.
    brand: "Theory",
    pack: pack("Theory", "theory", [style("Good Wool"), style("Good Linen")]),
    input: decodedFrom({ brand: "Theory" }),
    expect: { brand: "Theory", noStyle: true },
  },
  {
    name: "Theory 'Good Wool' — no false-positive brand recovery (a fabric is not a code)",
    brand: "Theory",
    pack: pack("Theory", "theory", [style("Good Wool")]),
    input: decodedFrom({ styleCode: "Good Wool" }),
    expect: { noBrand: true },
  },
  {
    name: "Eileen Fisher single known style fills the style the AI missed",
    brand: "Eileen Fisher",
    pack: pack("Eileen Fisher", "eileenfisher", [style("Eileen Fisher Renew")]),
    input: decodedFrom({ brand: "Eileen Fisher" }),
    expect: { brand: "Eileen Fisher", style: "Eileen Fisher Renew" },
  },
  {
    name: "Eileen Fisher 'Renew' — no false-positive brand recovery (no decoder)",
    // "Renew" is a real Eileen Fisher program and an ordinary English verb.
    brand: "Eileen Fisher",
    pack: pack("Eileen Fisher", "eileenfisher", [style("Eileen Fisher Renew")]),
    input: decodedFrom({ styleCode: "Renew" }),
    expect: { noBrand: true },
  },

  // ── US-1739: basics, mall & fast-fashion group ────────────────────────────
  // The INVERSE of the group above, and the pair is worth reading together. There
  // the piece was easy and the BRAND was the puzzle (a WILFRED tag is an Aritzia
  // coat). Here the tag says GAP in a blue box on a crewneck tee — both facts are
  // free, and neither is worth money. What these cases pin is what actually
  // decides the price of a staple: the LINE (mainline vs made-for-outlet), the
  // ERA (a 90s flag Tommy is not a 2024 Tommy), and — for the one brand that
  // earns it — a real cut-tag recovery.
  {
    name: "Uniqlo cut brand tag — HEATTECH on the care label recovers the brand",
    // THE case for this group, and the one the last two groups could not have.
    // The brand tag is gone; the care label survives; HEATTECH is a coined word
    // that means nothing in English, so it can only be Uniqlo.
    brand: "Uniqlo",
    pack: pack("Uniqlo", "uniqlo", [], [UNIQLO_FABRIC_TECH_DECODER]),
    input: decodedFrom({ styleCode: "HEATTECH" }), // no AI brand
    expect: { brand: "Uniqlo", recovery: true },
  },
  {
    name: "Uniqlo AIRism recovers the brand case-insensitively (the tag prints mixed case)",
    // The tag prints "AIRism", not "AIRISM". runDecoderSpec compiles with the "i"
    // flag, and this asserts the shipped pattern actually relies on that.
    brand: "Uniqlo",
    pack: pack("Uniqlo", "uniqlo", [], [UNIQLO_FABRIC_TECH_DECODER]),
    input: decodedFrom({ styleCode: "AIRism" }),
    expect: { brand: "Uniqlo", recovery: true },
  },
  {
    name: "Uniqlo HEATTECH with a warmth level still recovers the brand",
    // The level is matched but deliberately NOT captured — DecodeResult has no
    // field for it, and a fieldMap pointing at a non-existent field would write a
    // phantom property nothing reads. Recovery must still work with it present.
    brand: "Uniqlo",
    pack: pack("Uniqlo", "uniqlo", [], [UNIQLO_FABRIC_TECH_DECODER]),
    input: decodedFrom({ styleCode: "HEATTECH EXTRA WARM" }),
    expect: { brand: "Uniqlo", recovery: true },
  },
  {
    name: "Uniqlo fabric tech overrides a wrong AI brand + surfaces conflict",
    brand: "Uniqlo",
    pack: pack("Uniqlo", "uniqlo", [], [UNIQLO_FABRIC_TECH_DECODER]),
    input: decodedFrom({ brand: "Gap", styleCode: "HEATTECH" }),
    expect: { brand: "Uniqlo", conflictOn: "brand", recovery: true },
  },
  {
    name: "Uniqlo 'Ultra Light Down' does NOT recover the brand (a descriptive phrase is not a code)",
    // THE line that makes the decoder above defensible, and the reason the token
    // is excluded from its pattern. Ultra Light Down is a real, signature Uniqlo
    // style — and "ultra light down" is a DESCRIPTIVE ENGLISH PHRASE any brand may
    // truthfully use for an ultra light down jacket. It names the PIECE, never the
    // brand. It fails brand-unique for exactly the reason HEATTECH passes it.
    brand: "Uniqlo",
    pack: pack("Uniqlo", "uniqlo", [style("Ultra Light Down")], [
      UNIQLO_FABRIC_TECH_DECODER,
    ]),
    input: decodedFrom({ styleCode: "Ultra Light Down" }),
    expect: { noBrand: true },
  },
  {
    name: "Uniqlo ambiguous fabric platforms (HEATTECH vs AIRism vs BLOCKTECH) — never guess the style",
    // The decoder recovers the BRAND from the tech token, but with several styles
    // in the pack and nothing to separate them there is no style to fill.
    brand: "Uniqlo",
    pack: pack("Uniqlo", "uniqlo", [
      style("HEATTECH"),
      style("AIRism"),
      style("BLOCKTECH"),
    ], [UNIQLO_FABRIC_TECH_DECODER]),
    input: decodedFrom({ styleCode: "HEATTECH" }),
    expect: { brand: "Uniqlo", noStyle: true, recovery: true },
  },
  {
    name: "Gap 'gap' — no false-positive brand recovery (it is a CONDITION word)",
    // THE case for this group and the nastiest token in the whole epic — worse
    // than 00457's "moth", because "moth" is only a house label that could be
    // refused outright while "Gap" is a REAL canonical brand that MUST resolve.
    // "a gap in the waistband" is text this very product generates constantly.
    // No decoder may ever mint the brand from the bare word.
    brand: "Gap",
    pack: pack("Gap", "gap", [style("Gap Arch Logo Sweatshirt")]),
    input: decodedFrom({ styleCode: "gap" }),
    expect: { noBrand: true },
  },
  {
    name: "Gap Factory line fills the style the AI missed (the fold must stay disclosed)",
    // The outlet line FOLDS onto the brand (eBay has no separate catalogue brand
    // for it), so the only place the distinction can survive into the listing is
    // the style. This asserts it actually gets there.
    brand: "Gap",
    pack: pack("Gap", "gap", [style("Gap Factory (outlet line)")]),
    input: decodedFrom({ brand: "Gap" }),
    expect: { brand: "Gap", style: "Gap Factory (outlet line)" },
  },
  {
    name: "Gap ambiguous lines (mainline vs Factory vs GapKids) — never guess",
    // Only the tag separates a mainline piece from a made-for-outlet one, and the
    // difference is a real price band. Guessing here invents provenance.
    brand: "Gap",
    pack: pack("Gap", "gap", [
      style("Gap Arch Logo Sweatshirt"),
      style("Gap Factory (outlet line)"),
      style("babyGap / GapKids"),
    ]),
    input: decodedFrom({ brand: "Gap" }),
    expect: { brand: "Gap", noStyle: true },
  },
  {
    name: "Aerie sub-label fills the style the AI missed (Aerie IS American Eagle)",
    // This pack's one instance of 00457's defining shape: an Aerie tag frequently
    // carries no "American Eagle" anywhere. Same price band -> folds, with the
    // line kept in `style` because buyers search "Aerie".
    brand: "American Eagle",
    pack: pack("American Eagle", "americaneagle", [style("Aerie")]),
    input: decodedFrom({ brand: "American Eagle" }),
    expect: { brand: "American Eagle", style: "Aerie" },
  },
  {
    name: "American Eagle 'aerie' — no false-positive brand recovery (an aerie is an eagle's nest)",
    // "Aerie" is a real sub-brand AND an ordinary English noun. It resolves only
    // as a whole-brand field on an actual garment, never from a stray token.
    brand: "American Eagle",
    pack: pack("American Eagle", "americaneagle", [style("Aerie")]),
    input: decodedFrom({ styleCode: "aerie" }),
    expect: { noBrand: true },
  },
  {
    name: "Old Navy 'Rockstar' — no false-positive brand recovery (an ordinary word is not a code)",
    // Rockstar is Old Navy's real denim fit and an ordinary English word. The
    // named FIT is this group's most valuable listing token (the story's own
    // priority) — and it still can never recover the brand. Same rule as
    // 00457's "Juliette" and 00454's Lee "101".
    brand: "Old Navy",
    pack: pack("Old Navy", "oldnavy", [style("Rockstar Jeans")]),
    input: decodedFrom({ styleCode: "Rockstar" }),
    expect: { noBrand: true },
  },
  {
    name: "Old Navy named fit fills the style the AI missed",
    brand: "Old Navy",
    pack: pack("Old Navy", "oldnavy", [style("Rockstar Jeans")]),
    input: decodedFrom({ brand: "Old Navy" }),
    expect: { brand: "Old Navy", style: "Rockstar Jeans" },
  },
  {
    name: "Banana Republic ambiguous eras (safari-era vs modern Sloan) — never guess",
    // The safari era (1978-~1988) is effectively a different product wearing the
    // same name, at a completely different price. Only the LABEL separates them,
    // so with the brand alone there is nothing to pick — and guessing invents a
    // vintage attribution worth real money.
    brand: "Banana Republic",
    pack: pack("Banana Republic", "bananarepublic", [
      style("Safari-era Banana Republic"),
      style("Sloan Fit Pant"),
    ]),
    input: decodedFrom({ brand: "Banana Republic" }),
    expect: { brand: "Banana Republic", noStyle: true },
  },
  {
    name: "Banana Republic 'Sloan' — no false-positive brand recovery (a given name is not a code)",
    brand: "Banana Republic",
    pack: pack("Banana Republic", "bananarepublic", [style("Sloan Fit Pant")]),
    input: decodedFrom({ styleCode: "Sloan" }),
    expect: { noBrand: true },
  },
  {
    name: "Abercrombie 'Curve Love' — no false-positive brand recovery",
    // A&F's strongest modern resale token, printed on the tag, and still two
    // ordinary English words. Printed + regular is not enough — brand-unique is
    // the test it fails, and the test HEATTECH passes.
    brand: "Abercrombie & Fitch",
    pack: pack("Abercrombie & Fitch", "abercrombiefitch", [
      style("Curve Love Denim"),
    ]),
    input: decodedFrom({ styleCode: "Curve Love" }),
    expect: { noBrand: true },
  },
  {
    name: "Abercrombie ambiguous eras (pre-1977 sporting goods vs logo era) — never guess",
    // The sharpest era break in the epic: pre-1977 A&F was a DIFFERENT COMPANY
    // (an elite expedition outfitter that went bankrupt) sharing only the name.
    // Guessing between them is guessing between two unrelated markets.
    brand: "Abercrombie & Fitch",
    pack: pack("Abercrombie & Fitch", "abercrombiefitch", [
      style("Vintage sporting-goods A&F (pre-1977)"),
      style("Logo / Moose-era A&F"),
    ]),
    input: decodedFrom({ brand: "Abercrombie & Fitch" }),
    expect: { brand: "Abercrombie & Fitch", noStyle: true },
  },
  {
    name: "Tommy Hilfiger 'Tommy' — no false-positive brand recovery (Tommy Bahama is a different company)",
    // The group's cross-brand trap, and 00457's Vince / Vince Camuto shape. A bare
    // first name is shared by an unrelated business (Oxford Industries), so it can
    // never be decisive on its own.
    brand: "Tommy Hilfiger",
    pack: pack("Tommy Hilfiger", "tommyhilfiger", [style("Tommy Jeans")]),
    input: decodedFrom({ styleCode: "Tommy" }),
    expect: { noBrand: true },
  },
  {
    name: "Tommy Hilfiger ambiguous eras (vintage flag vs modern revival) — never guess",
    // The trap that makes this brand's era unguessable: the modern Tommy Jeans
    // revival DELIBERATELY reissues the 1990s flag look, so the graphic cannot
    // date the garment — a modern piece is SUPPOSED to look old. Only the label
    // separates them, and the price difference is multiples.
    brand: "Tommy Hilfiger",
    pack: pack("Tommy Hilfiger", "tommyhilfiger", [
      style("Vintage flag-logo Tommy"),
      style("Tommy Jeans"),
    ]),
    input: decodedFrom({ brand: "Tommy Hilfiger" }),
    expect: { brand: "Tommy Hilfiger", noStyle: true },
  },
  {
    name: "Tommy Jeans line fills the style the AI missed (a LINE of this brand, so it folds)",
    brand: "Tommy Hilfiger",
    pack: pack("Tommy Hilfiger", "tommyhilfiger", [style("Tommy Jeans")]),
    input: decodedFrom({ brand: "Tommy Hilfiger" }),
    expect: { brand: "Tommy Hilfiger", style: "Tommy Jeans" },
  },

  // ── US-1740: footwear group ───────────────────────────────────────────────
  // The first non-garment pack in the epic, and the identification problem is a
  // different shape. The last three groups fought over what a garment IS (a
  // WILFRED tag is an Aritzia coat) or what ERA it is from. Here the brand is
  // usually obvious and the MODEL is genuinely legible from a photo — what is not
  // legible is the SIZE SYSTEM the stamped number belongs to, and the LINE (Chuck
  // 70 vs Chuck, Made in USA vs imported) which is near-identical BY DESIGN and in
  // production alongside the mainline shoe.
  //
  // The decoder cases pin the prefix argument from both ends: "M990" recovers the
  // brand AND the gender, while "990" and "1460" recover nothing at all.
  {
    name: "New Balance cut tag — the model number's PREFIX recovers the brand",
    // THE case for this group. The box is gone and the tongue label survives.
    // "M990GL6" can only be a New Balance model number — because of the M.
    brand: "New Balance",
    pack: pack("New Balance", "newbalance", [], [
      NEW_BALANCE_STYLE_NUMBER_DECODER,
    ]),
    input: decodedFrom({ styleCode: "M990GL6" }), // no AI brand
    expect: { brand: "New Balance", recovery: true },
  },
  {
    name: "New Balance 'W574' recovers the brand from a women's prefix",
    brand: "New Balance",
    pack: pack("New Balance", "newbalance", [], [
      NEW_BALANCE_STYLE_NUMBER_DECODER,
    ]),
    input: decodedFrom({ styleCode: "W574" }),
    expect: { brand: "New Balance", recovery: true },
  },
  {
    name: "New Balance 'U327' (unisex prefix) still recovers the brand",
    // U matches via a NON-CAPTURING alternative — unisex is not a gender, so the
    // gender field stays unset — but the brand must still recover. That the
    // alternation is safe at all rests on runDecoderSpec skipping undefined
    // groups (`value == null`), which this case exercises.
    brand: "New Balance",
    pack: pack("New Balance", "newbalance", [], [
      NEW_BALANCE_STYLE_NUMBER_DECODER,
    ]),
    input: decodedFrom({ styleCode: "U327" }),
    expect: { brand: "New Balance", recovery: true },
  },
  {
    name: "New Balance lowercase 'm990gl6' recovers the brand (OCR does not preserve case)",
    // The tongue label prints uppercase; an OCR read may not. runDecoderSpec
    // compiles with the "i" flag and this asserts the shipped pattern relies on it.
    brand: "New Balance",
    pack: pack("New Balance", "newbalance", [], [
      NEW_BALANCE_STYLE_NUMBER_DECODER,
    ]),
    input: decodedFrom({ styleCode: "m990gl6" }),
    expect: { brand: "New Balance", recovery: true },
  },
  {
    name: "New Balance '990' — no false-positive brand recovery (three digits is not a brand)",
    // THE line that makes the decoder defensible, and the exact reason the prefix
    // is in the pattern. "990" is the model number every buyer says out loud, and
    // it is still just three digits — it could be a price, a year, a lot number.
    // Only "M990" is a New Balance token.
    brand: "New Balance",
    pack: pack("New Balance", "newbalance", [style("990 series")], [
      NEW_BALANCE_STYLE_NUMBER_DECODER,
    ]),
    input: decodedFrom({ styleCode: "990" }),
    expect: { noBrand: true },
  },
  {
    name: "New Balance decoder overrides a wrong AI brand + surfaces conflict",
    brand: "New Balance",
    pack: pack("New Balance", "newbalance", [], [
      NEW_BALANCE_STYLE_NUMBER_DECODER,
    ]),
    input: decodedFrom({ brand: "Converse", styleCode: "M990GL6" }),
    expect: { brand: "New Balance", conflictOn: "brand", recovery: true },
  },
  {
    name: "New Balance ambiguous models (990 vs 574 vs 550) — never guess the style",
    brand: "New Balance",
    pack: pack("New Balance", "newbalance", [
      style("990 series"),
      style("574"),
      style("550"),
    ], [NEW_BALANCE_STYLE_NUMBER_DECODER]),
    input: decodedFrom({ styleCode: "M990GL6" }),
    expect: { brand: "New Balance", noStyle: true, recovery: true },
  },
  {
    name: "New Balance 'Made in USA' line fills the style the AI missed (the fold must stay disclosed)",
    // The origin is on the tongue label and INVISIBLE in the silhouette, and the
    // band difference is real. The line folds onto the brand (eBay has no separate
    // catalogue brand), so `style` is the only place it survives into a listing.
    brand: "New Balance",
    pack: pack("New Balance", "newbalance", [
      style("Made in USA / Made in England"),
    ]),
    input: decodedFrom({ brand: "New Balance" }),
    expect: { brand: "New Balance", style: "Made in USA / Made in England" },
  },
  {
    name: "Dr. Martens '1460' — no false-positive brand recovery (four digits is not a brand)",
    // THE refusal of this group, and the hardest one in the epic: 1460 is the most
    // famous number in footwear, it IS printed on the tag, and it IS a regular
    // closed set. It fails brand-unique anyway, and for the mirror image of the
    // reason New Balance passes — it has NO PREFIX. Four digits is a year, a lot
    // number, a price, another brand's cut code. Deliberately no decoder in the
    // pack: the seeded article numbers name the PIECE, never the brand.
    brand: "Dr. Martens",
    pack: pack("Dr. Martens", "drmartens", [style("1460 (8-eye boot)")]),
    input: decodedFrom({ styleCode: "1460" }),
    expect: { noBrand: true },
  },
  {
    name: "Dr. Martens single known style fills the style the AI missed",
    brand: "Dr. Martens",
    pack: pack("Dr. Martens", "drmartens", [style("1460 (8-eye boot)")]),
    input: decodedFrom({ brand: "Dr. Martens" }),
    expect: { brand: "Dr. Martens", style: "1460 (8-eye boot)" },
  },
  {
    name: "Dr. Martens ambiguous articles (1460 vs 1461 vs 2976) — never guess",
    // Three different boots at three different prices. The article number is on
    // the tag; with only the brand there is nothing to pick from.
    brand: "Dr. Martens",
    pack: pack("Dr. Martens", "drmartens", [
      style("1460 (8-eye boot)"),
      style("1461 (3-eye shoe)"),
      style("2976 (Chelsea boot)"),
    ]),
    input: decodedFrom({ brand: "Dr. Martens" }),
    expect: { brand: "Dr. Martens", noStyle: true },
  },
  {
    name: "Dr. Martens 'Made in England' line fills the style the AI missed",
    // The origin is on the HEEL LOOP and invisible in the silhouette — an MIE 1460
    // and an imported 1460 look identical — and the band difference is real.
    brand: "Dr. Martens",
    pack: pack("Dr. Martens", "drmartens", [
      style("Made in England (Vintage line)"),
    ]),
    input: decodedFrom({ brand: "Dr. Martens" }),
    expect: { brand: "Dr. Martens", style: "Made in England (Vintage line)" },
  },
  {
    name: "Converse ambiguous lines (Chuck 70 vs standard Chuck) — never guess",
    // THE Converse trap: both are in production RIGHT NOW, side by side, at
    // materially different bands, and they are near-identical. This is NOT an era
    // (nothing to date) and NOT a fold (they are one brand) — it is two products
    // separated only by the midsole and the heel patch. Guessing picks a price.
    brand: "Converse",
    pack: pack("Converse", "converse", [
      style("Chuck Taylor All Star"),
      style("Chuck 70"),
    ]),
    input: decodedFrom({ brand: "Converse" }),
    expect: { brand: "Converse", noStyle: true },
  },
  {
    name: "Converse 'All Star' — no false-positive brand recovery (an ordinary phrase is not a code)",
    brand: "Converse",
    pack: pack("Converse", "converse", [style("Chuck Taylor All Star")]),
    input: decodedFrom({ styleCode: "All Star" }),
    expect: { noBrand: true },
  },
  {
    name: "Vans 'Vans' — no false-positive brand recovery (it is an English plural)",
    // The group's ordinary-word token and 00458's "Gap" shape: a real canonical
    // brand that MUST resolve, spelled identically to the plural of "van". It can
    // be contained but never refused — and no decoder may mint it from a token.
    brand: "Vans",
    pack: pack("Vans", "vans", [style("Old Skool")]),
    input: decodedFrom({ styleCode: "vans" }),
    expect: { noBrand: true },
  },
  {
    name: "Vans 'Vault by Vans' line fills the style the AI missed (the fold must stay disclosed)",
    brand: "Vans",
    pack: pack("Vans", "vans", [style("Vault by Vans (OG / LX line)")]),
    input: decodedFrom({ brand: "Vans" }),
    expect: { brand: "Vans", style: "Vault by Vans (OG / LX line)" },
  },
  {
    name: "Vans ambiguous models (Authentic vs Era) — never guess",
    // These two differ ONLY by the Era's padded collar, which needs a side-on
    // photo. With just the brand there is nothing to separate them.
    brand: "Vans",
    pack: pack("Vans", "vans", [style("Authentic"), style("Era")]),
    input: decodedFrom({ brand: "Vans" }),
    expect: { brand: "Vans", noStyle: true },
  },
  {
    name: "UGG 'Chestnut' — no false-positive brand recovery (a colourway is not a code)",
    // Chestnut is THE UGG colour and the first proprietary colourway seeded in four
    // groups — and it is still an ordinary English noun. A colourway names the
    // COLOUR; it can never mint the brand.
    brand: "UGG",
    pack: pack("UGG", "ugg", [style("Classic Tall")]),
    input: decodedFrom({ styleCode: "Chestnut" }),
    expect: { noBrand: true },
  },
  {
    name: "UGG single known style fills the style the AI missed",
    brand: "UGG",
    pack: pack("UGG", "ugg", [style("Tasman")]),
    input: decodedFrom({ brand: "UGG" }),
    expect: { brand: "UGG", style: "Tasman" },
  },
  {
    name: "UGG ambiguous silhouettes (Classic Tall vs Mini vs Tasman) — never guess",
    // These ARE legible from a photo and are real price differences — which is
    // exactly why the resolver must not pick one from the brand alone. Let the
    // vision pass see the shaft height.
    brand: "UGG",
    pack: pack("UGG", "ugg", [
      style("Classic Tall"),
      style("Classic Mini / Ultra Mini"),
      style("Tasman"),
    ]),
    input: decodedFrom({ brand: "UGG" }),
    expect: { brand: "UGG", noStyle: true },
  },
  {
    name: "Birkenstock 'Arizona' — no false-positive brand recovery (a place name is not a code)",
    // Birkenstock's models are PLACE NAMES on a GERMAN shoe. "Arizona" names the
    // piece on an actual Birkenstock and is otherwise a US state.
    brand: "Birkenstock",
    pack: pack("Birkenstock", "birkenstock", [style("Arizona")]),
    input: decodedFrom({ styleCode: "Arizona" }),
    expect: { noBrand: true },
  },
  {
    name: "Birkenstock ambiguous silhouettes (Arizona vs Boston vs Gizeh) — never guess",
    brand: "Birkenstock",
    pack: pack("Birkenstock", "birkenstock", [
      style("Arizona"),
      style("Boston"),
      style("Gizeh"),
    ]),
    input: decodedFrom({ brand: "Birkenstock" }),
    expect: { brand: "Birkenstock", noStyle: true },
  },
  {
    name: "Cole Haan single known style fills the style the AI missed",
    brand: "Cole Haan",
    pack: pack("Cole Haan", "colehaan", [style("ZeroGrand")]),
    input: decodedFrom({ brand: "Cole Haan" }),
    expect: { brand: "Cole Haan", style: "ZeroGrand" },
  },
  {
    name: "Cole Haan 'ZeroGrand' — no false-positive brand recovery (a coined style name is still not a code)",
    // Tempting: ZeroGrand IS coined, which is the test HEATTECH passed in 00458.
    // It stays refused because it is a STYLE NAME the pack reaches by fingerprint,
    // not a tag CODE — and no Cole Haan decoder is seeded, so there is nothing to
    // recover from. Coined is necessary for a decoder, not sufficient to invent one.
    brand: "Cole Haan",
    pack: pack("Cole Haan", "colehaan", [style("ZeroGrand")]),
    input: decodedFrom({ styleCode: "ZeroGrand" }),
    expect: { noBrand: true },
  },
  // US-1981 luxury outerwear & down group. Canada Goose carries the group's
  // CUT-TAG cases: the style number lives on the CARE label, which survives when
  // the brand tag is cut out of the collar — so a parka with no brand left on it
  // is still recoverable. The other five are decoder-less by design.
  {
    name: "Canada Goose cut brand tag — the care-label style number recovers the brand",
    brand: "Canada Goose",
    pack: pack("Canada Goose", "canadagoose", [], [CANADA_GOOSE_STYLE_NUMBER_DECODER]),
    input: decodedFrom({ styleCode: "4660MA" }), // no AI brand
    expect: { brand: "Canada Goose", recovery: true },
  },
  {
    name: "Canada Goose ladies' style number also recovers the brand off a cut tag",
    brand: "Canada Goose",
    pack: pack("Canada Goose", "canadagoose", [], [CANADA_GOOSE_STYLE_NUMBER_DECODER]),
    input: decodedFrom({ styleCode: "2506L" }),
    expect: { brand: "Canada Goose", recovery: true },
  },
  {
    name: "Canada Goose style number overrides a wrong AI brand + surfaces conflict",
    // The realistic confusion in this group: another dark fur-hooded parka brand.
    brand: "Canada Goose",
    pack: pack("Canada Goose", "canadagoose", [], [CANADA_GOOSE_STYLE_NUMBER_DECODER]),
    input: decodedFrom({ brand: "Moncler", styleCode: "7950M" }),
    expect: { brand: "Canada Goose", conflictOn: "brand", recovery: true },
  },
  {
    name: "Canada Goose bare 4-digit run — no false-positive recovery",
    // THE WHOLE ARGUMENT FOR THIS DECODER'S SHAPE. A bare digit run is an
    // ordinary number (the Chanel rule, US-1736) — the DEPARTMENT LETTER is what
    // makes "4660MA" brand-unique rather than "any tag with four digits".
    brand: "Canada Goose",
    pack: pack("Canada Goose", "canadagoose", [], [CANADA_GOOSE_STYLE_NUMBER_DECODER]),
    input: decodedFrom({ styleCode: "4660" }),
    expect: { noBrand: true },
  },
  {
    name: "Canada Goose wrong-length digit run — no false-positive recovery",
    brand: "Canada Goose",
    pack: pack("Canada Goose", "canadagoose", [], [CANADA_GOOSE_STYLE_NUMBER_DECODER]),
    input: decodedFrom({ styleCode: "46601M" }),
    expect: { noBrand: true },
  },
  {
    name: "Canada Goose hologram-style long serial — no false-positive recovery",
    // Why the hologram number is deliberately NOT decoded: it is a bare digit run
    // and a pattern over it would mint a brand from any tag with a long number.
    brand: "Canada Goose",
    pack: pack("Canada Goose", "canadagoose", [], [CANADA_GOOSE_STYLE_NUMBER_DECODER]),
    input: decodedFrom({ styleCode: "84726193" }),
    expect: { noBrand: true },
  },
  {
    name: "Canada Goose ambiguous fur-hooded parkas (Expedition vs Chilliwack) — never guess",
    brand: "Canada Goose",
    pack: pack("Canada Goose", "canadagoose", [
      style("Expedition Parka"),
      style("Chilliwack Bomber"),
    ], [CANADA_GOOSE_STYLE_NUMBER_DECODER]),
    input: decodedFrom({ brand: "Canada Goose" }),
    expect: { brand: "Canada Goose", noStyle: true },
  },
  {
    name: "Canada Goose single known style fills the style the AI missed",
    brand: "Canada Goose",
    pack: pack("Canada Goose", "canadagoose", [style("Expedition Parka")], [
      CANADA_GOOSE_STYLE_NUMBER_DECODER,
    ]),
    input: decodedFrom({ brand: "Canada Goose" }),
    expect: { brand: "Canada Goose", style: "Expedition Parka" },
  },
  // The other five are decoder-less by design — every code they print is either a
  // bare digit run (Moncler's serial) or a catalog SKU. Their guarantee is that
  // enrichment stays correct WITHOUT a decoder.
  {
    name: "Moncler single known style fills the style the AI missed",
    brand: "Moncler",
    pack: pack("Moncler", "moncler", [style("Maya")]),
    input: decodedFrom({ brand: "Moncler" }),
    expect: { brand: "Moncler", style: "Maya" },
  },
  {
    name: "Moncler ambiguous lacquered down jackets (Maya vs Bady) — never guess",
    // Same nylon laqué shell, same baffles — only the department/cut separates
    // them, and the pack must not pick one from the fabric alone.
    brand: "Moncler",
    pack: pack("Moncler", "moncler", [style("Maya"), style("Bady")]),
    input: decodedFrom({ brand: "Moncler" }),
    expect: { brand: "Moncler", noStyle: true },
  },
  {
    name: "Moncler serial — no false-positive brand recovery (a bare digit run is not a code)",
    // THE COSTLIEST FALSE POSITIVE THE KB COULD MINT. Moncler's serial is a bare
    // digit run; a pattern over it would brand any tag carrying a long number as
    // the most counterfeited outerwear label on earth. Deliberately decoder-less.
    brand: "Moncler",
    pack: pack("Moncler", "moncler", [style("Maya"), style("Bady")]),
    input: decodedFrom({ styleCode: "1A00107" }),
    expect: { noBrand: true },
  },
  {
    name: "Mackage single known style fills the style the AI missed",
    brand: "Mackage",
    pack: pack("Mackage", "mackage", [style("Adali")]),
    input: decodedFrom({ brand: "Mackage" }),
    expect: { brand: "Mackage", style: "Adali" },
  },
  {
    name: "Mackage ambiguous belted down coats (Adali vs Kay) — never guess",
    brand: "Mackage",
    pack: pack("Mackage", "mackage", [style("Adali"), style("Kay")]),
    input: decodedFrom({ brand: "Mackage" }),
    expect: { brand: "Mackage", noStyle: true },
  },
  {
    name: "Mackage catalog SKU — no false-positive brand recovery (no decoder)",
    brand: "Mackage",
    pack: pack("Mackage", "mackage", [style("Adali"), style("Kay")]),
    input: decodedFrom({ styleCode: "ADALI-F4-BLACK" }),
    expect: { noBrand: true },
  },
  {
    name: "Herno single known line fills the style the AI missed",
    brand: "Herno",
    pack: pack("Herno", "herno", [style("Laminar")]),
    input: decodedFrom({ brand: "Herno" }),
    expect: { brand: "Herno", style: "Laminar" },
  },
  {
    name: "Herno ambiguous slim dark nylon jackets (Laminar vs Ultralight) — never guess",
    brand: "Herno",
    pack: pack("Herno", "herno", [style("Laminar"), style("Ultralight Down Jacket")]),
    input: decodedFrom({ brand: "Herno" }),
    expect: { brand: "Herno", noStyle: true },
  },
  {
    name: "Herno article number — no false-positive brand recovery (catalog SKU)",
    brand: "Herno",
    pack: pack("Herno", "herno", [style("Laminar"), style("Ultralight Down Jacket")]),
    input: decodedFrom({ styleCode: "PI0001DIC-12017" }),
    expect: { noBrand: true },
  },
  {
    name: "Woolrich single known style fills the style the AI missed",
    brand: "Woolrich",
    pack: pack("Woolrich", "woolrich", [style("Arctic Parka")]),
    input: decodedFrom({ brand: "Woolrich" }),
    expect: { brand: "Woolrich", style: "Arctic Parka" },
  },
  {
    name: "Woolrich ambiguous eras (Italian Arctic Parka vs US heritage wool) — never guess",
    // The group's era trap in resolver form: one label, two brands, two ladders.
    // The pack must not pick a ladder without the origin tag saying which.
    brand: "Woolrich",
    pack: pack("Woolrich", "woolrich", [
      style("Arctic Parka"),
      style("Buffalo Check Wool Shirt"),
    ]),
    input: decodedFrom({ brand: "Woolrich" }),
    expect: { brand: "Woolrich", noStyle: true },
  },
  {
    name: "Woolrich catalog SKU — no false-positive brand recovery (no decoder)",
    brand: "Woolrich",
    pack: pack("Woolrich", "woolrich", [style("Arctic Parka")]),
    input: decodedFrom({ styleCode: "WOCPS2880-UT0001" }),
    expect: { noBrand: true },
  },
  {
    name: "Bogner single known style fills the style the AI missed",
    brand: "Bogner",
    pack: pack("Bogner", "bogner", [style("Ski Pant")]),
    input: decodedFrom({ brand: "Bogner" }),
    expect: { brand: "Bogner", style: "Ski Pant" },
  },
  {
    name: "Bogner ambiguous ladders (mainline Ski Jacket vs Fire + Ice) — never guess",
    brand: "Bogner",
    pack: pack("Bogner", "bogner", [style("Ski Jacket"), style("Fire + Ice")]),
    input: decodedFrom({ brand: "Bogner" }),
    expect: { brand: "Bogner", noStyle: true },
  },
  {
    name: "Bogner article number — no false-positive brand recovery (catalog SKU)",
    brand: "Bogner",
    pack: pack("Bogner", "bogner", [style("Ski Jacket"), style("Fire + Ice")]),
    input: decodedFrom({ styleCode: "3841-4247-042" }),
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
