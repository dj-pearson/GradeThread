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

// US-1982: the Dior date_code decoder EXACTLY as migration 00461 seeds it into
// brand_style_codes. It is the ONLY decoder in the luxury RTW & leather group —
// the only code there that is tag-printed AND regular AND brand-unique in FORMAT.
// It also carries the group's CUT-TAG case: the code is heat-stamped on an
// interior LEATHER TAB, which survives the brand tab being cut out.
//
// THE HYPHENATED TRIPLET IS THE WHOLE ARGUMENT. This is the LV SD1160 precedent
// (00399, `[A-Z]{2}\d{4}`) with separators on top, which makes it strictly MORE
// distinctive than the precedent that justifies it — a bare "050151" is nothing
// (the Chanel rule, US-1736), but "05-BO-0151" can only be a Dior date code.
//
// HERMÈS IS THE INSTRUCTIVE REFUSAL and the reason this group has exactly one
// decoder: its blind stamp is a BARE LETTER, and Hermès ships no serial number at
// all. A pattern over one letter would recover the most valuable label in the pack
// from essentially any tag — the Chanel rule at its limit.
//
// NOTE the code is a DATE code, not a style code: it identifies where/when a piece
// was made, not which model it is. That is fine for the job it does here (brand
// recovery off a cut tab, which is what enrichExtractionWithBrandKnowledge keys
// off styleCode for) and the seeded description says so plainly. It is emphatically
// NOT an authenticity check.
const DIOR_DATE_CODE_DECODER: BrandDecoder = {
  decoderKind: "date_code",
  description:
    "Dior date code heat-stamped on an interior leather tab: 2 digits + 2 letters + 4 digits, hyphenated (05-BO-0151, 17-BO-0129). Encodes the manufacturing origin/date, NOT the model and NOT authenticity.",
  pattern: "^(?<code>\\d{2}-[A-Z]{2}-\\d{4})$",
  extractionRules: {
    fieldMap: { code: "styleCode" },
    confidence: 0.6,
  },
  examples: [],
};

// US-1983: the Off-White style_number decoder EXACTLY as migration 00462 seeds it
// into brand_style_codes. It is the ONLY decoder in the new-generation streetwear
// & hype group — the only code there that is tag-printed AND regular AND
// brand-unique in FORMAT. It carries the group's CUT-TAG case: the code is on the
// interior CARE LABEL, which survives the brand tab being cut out.
//
// THE OM/OW PREFIX IS THE WHOLE ARGUMENT. It is a gendered BRAND marker, and the
// whole is a 16-character compound — the LV SD1160 precedent (00399) and the Dior
// hyphenated triplet (00461), not the bare digit run the Chanel rule (US-1736)
// refuses. Strip the prefix and the remainder is an ordinary number.
//
// THE GENDER GROUP IS THE SECOND CHARACTER, NOT THE FIRST TWO — deliberately.
// Capturing "M" out of "OM" lets the EXISTING genderCode transform map it to
// Men/Women with no code change; a two-letter "OM" would fall through that
// transform's W/M table and emit the raw "OM" as a gender.
//
// THE OTHER EIGHT BRANDS IN THE GROUP GET NO DECODER, and seven of them print no
// regular garment-side code AT ALL — there is nothing to decode, so a pattern
// would be invented rather than read. Aimé Leon Dore's internal SKU fails the
// regular-AND-brand-unique bar.
//
// NOT an authenticity check, and on this brand that matters more than most: a
// bootleg copies the care label along with everything else. It recovers the BRAND
// off a cut tab and the ERA via the season token — which is the point, because
// the Off-White LOGO DID NOT CHANGE when Abloh died in 2021, so the logo cannot
// date a piece and the code can.
const OFF_WHITE_STYLE_NUMBER_DECODER: BrandDecoder = {
  decoderKind: "style_number",
  description:
    "Off-White season/style code printed on the interior care label: OM (men) or OW (women) + a 2-letter category + 3 digits + a season token + 3 letters + 3-4 digits (OMAA038R21FAB001). Recovers the BRAND off a cut tab and the ERA via the season token. NOT an authenticity check.",
  pattern:
    "^(?<code>O(?<gender>[MW])[A-Z]{2}\\d{3}(?<season>[A-Z]\\d{2})[A-Z]{3}\\d{3,4})$",
  extractionRules: {
    fieldMap: { code: "styleCode", gender: "gender", season: "season" },
    transforms: { gender: "genderCode" },
    confidence: 0.5,
  },
  examples: [],
};

// US-1984: the Diesel style_name decoder EXACTLY as migration 00464 seeds it into
// brand_style_codes. It is the ONLY decoder in the premium-denim tier-2 group and
// it carries the group's CUT-TAG case.
//
// THE VOCABULARY IS COINED, AND THAT IS THE WHOLE ARGUMENT. "Thommer",
// "Sleenker", "Zatiny" and "Larkee" mean nothing in English or Italian, so — like
// Uniqlo's HEATTECH below, and UNLIKE True Religion's "Ricky" (00454), an
// ordinary first name that needed the "Super T" compound to be safe — the token
// identifies the brand STANDING ALONE. No suffix is required to make it safe,
// because no ordinary text produces the word.
//
// The optional "-X" suffix (Thommer-X = the stretch cut of the same block) is
// tolerated but NOT captured: it marks the fabric, not the style, and there is no
// DecodeResult field for it. A non-capturing group is the US-1739 rule — a bogus
// fieldMap target would silently write a phantom property nothing reads.
//
// THE OTHER SEVEN BRANDS GET NO DECODER, and the two pointed refusals are worth
// fixturing as negatives (below): G-Star's 3301 is a bare digit run (the Lee 101
// rule), and Rag & Bone's "Fit 2" is regular AND tag-printed but is an ordinary
// English phrase — it fails brand-uniqueness, the third test and the easiest to
// skip.
//
// NOT an authenticity check: Diesel is widely counterfeited and a fake prints the
// same model name. It recovers the BRAND off a cut tag and the ERA via the naming
// generation — the pre-2019 names vs the Glenn Martens D- family.
const DIESEL_STYLE_NAME_DECODER: BrandDecoder = {
  decoderKind: "style_name",
  description:
    "Diesel tag-printed model name. The vocabulary is COINED (Thommer, Sleenker, Larkee, Zatiny mean nothing in English or Italian), so a single token identifies the brand even when the brand tag itself is cut. The name also dates the jean: the pre-2019 names versus the Glenn Martens D- family (D-Strukt, D-Fining) are two distinct eras. An optional trailing \"-X\" stretch marker is tolerated but not captured.",
  pattern:
    "^(?<style>THOMMER|SLEENKER|LARKEE(?:-BEEX)?|ZATINY|ZATHAN|SAFADO|TEPPHAR|KROOLEY|BUSTER|WAYKEE|BELTHER|SLANDY|SKINZEE|D-STRUKT|D-FINING|D-AKEMI|D-VIKER)(?:-X)?$",
  extractionRules: {
    fieldMap: { style: "styleCode" },
    transforms: { style: "upper" },
    confidence: 0.6,
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

// US-1985: the ASICS style_number decoder EXACTLY as migration 00465 seeds it
// into brand_style_codes. It is the ONLY decoder in the activewear tier-2 group
// and it carries the group's CUT-TAG case.
//
// THE ARGUMENT IS THE FORMAT'S SHAPE, not its regularity. ASICS's article number
// is DIGITS-THEN-LETTER-THEN-DIGITS (1011B491) and no brand it would be confused
// with uses that shape: Nike leads with letters (CW2288-111), adidas and Reebok
// are two-letters-plus-four-digits (GY7434), New Balance leads with a department
// letter (M990GL5). It is printed on the tongue label beside the size, so it
// recovers the brand off a cut tag.
//
// AND THAT THIRD TEST — brand-uniqueness — IS WHY REEBOK GETS NOTHING, which is
// the most instructive refusal in this pack. Reebok's modern code is tag-printed
// AND regular and STILL fails, because the format is ADIDAS'S: the two ran a
// shared corporate coding system from 2006 to 2021. A pattern over it would let a
// format GUESS override the tag's own brand (the brandFromStyleFormat hazard).
// The GY7434 negative below is that refusal, fixtured.
//
// The optional trailing colour suffix (-001) is tolerated but NOT captured: it is
// a colour CODE, not a colour name, and `colorway` expects a name. A
// non-capturing group is the US-1739 rule — a bogus fieldMap target would
// silently write a phantom property nothing reads.
//
// NOT an authenticity check: the article number identifies the MODEL, not the
// individual shoe, and it is printed on every box. It recovers the BRAND.
const ASICS_ARTICLE_NUMBER_DECODER: BrandDecoder = {
  decoderKind: "style_number",
  description:
    "ASICS tag-printed article number, on the tongue label beside the size and on the box. Eight characters: four digits, one letter, three digits (1011B491, 1201A019, 1012B420). The DIGITS-THEN-LETTER shape is what makes it brand-unique — Nike leads with letters (CW2288-111), adidas and Reebok use two letters plus four digits (GY7434), New Balance leads with a department letter (M990GL5) — so it identifies ASICS even when the brand tag itself is cut. An optional trailing colour-code suffix (-001) is tolerated but not captured, because it is a code rather than a colour name.",
  pattern: "^(?<style>\\d{4}[A-Z]\\d{3})(?:-\\d{3})?$",
  extractionRules: {
    fieldMap: { style: "styleCode" },
    transforms: { style: "upper" },
    confidence: 0.6,
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
  // ── US-1982 luxury RTW & leather group (tier 2) ────────────────────────────
  // Dior carries the group's CUT-TAG cases: the date code is heat-stamped on an
  // interior LEATHER TAB, which survives the brand tab being cut out — so a bag
  // with no brand left on it is still recoverable. The other seven are
  // decoder-less by design, and their guarantee is that enrichment stays CORRECT
  // without one. That matters more in this tier than in any other: these are the
  // most valuable and most counterfeited labels in the KB, so a false-positive
  // brand recovery here is the costliest mistake the resolver could make.
  {
    name: "Dior cut brand tab — the leather-tab date code recovers the brand",
    brand: "Dior",
    pack: pack("Dior", "dior", [], [DIOR_DATE_CODE_DECODER]),
    input: decodedFrom({ styleCode: "05-BO-0151" }), // no AI brand
    expect: { brand: "Dior", recovery: true },
  },
  {
    name: "Dior later-era date code also recovers the brand off a cut tab",
    brand: "Dior",
    pack: pack("Dior", "dior", [], [DIOR_DATE_CODE_DECODER]),
    input: decodedFrom({ styleCode: "17-BO-0129" }),
    expect: { brand: "Dior", recovery: true },
  },
  {
    name: "Dior date code overrides a wrong AI brand + surfaces conflict",
    // The realistic confusion in this group: another French luxury house whose
    // quilted flap bags photograph similarly.
    brand: "Dior",
    pack: pack("Dior", "dior", [], [DIOR_DATE_CODE_DECODER]),
    input: decodedFrom({ brand: "Chanel", styleCode: "05-BO-0151" }),
    expect: { brand: "Dior", conflictOn: "brand", recovery: true },
  },
  {
    name: "Dior unhyphenated digit run — no false-positive recovery",
    // THE WHOLE ARGUMENT FOR THIS DECODER'S SHAPE. Strip the separators and the
    // code is an ordinary number (the Chanel rule, US-1736) — the HYPHENATED
    // TRIPLET is what makes it brand-unique rather than "any tag with 8 digits".
    brand: "Dior",
    pack: pack("Dior", "dior", [], [DIOR_DATE_CODE_DECODER]),
    input: decodedFrom({ styleCode: "050151" }),
    expect: { noBrand: true },
  },
  {
    name: "Dior wrong-shape code — no false-positive recovery",
    brand: "Dior",
    pack: pack("Dior", "dior", [], [DIOR_DATE_CODE_DECODER]),
    input: decodedFrom({ styleCode: "5-BO-151" }),
    expect: { noBrand: true },
  },
  {
    name: "Dior ambiguous Cannage-quilted bags (Lady Dior vs Saddle) — never guess",
    brand: "Dior",
    pack: pack("Dior", "dior", [
      style("Lady Dior"),
      style("Saddle Bag"),
    ], [DIOR_DATE_CODE_DECODER]),
    input: decodedFrom({ brand: "Dior" }),
    expect: { brand: "Dior", noStyle: true },
  },
  {
    name: "Dior single known style fills the style the AI missed",
    brand: "Dior",
    pack: pack("Dior", "dior", [style("Lady Dior")], [DIOR_DATE_CODE_DECODER]),
    input: decodedFrom({ brand: "Dior" }),
    expect: { brand: "Dior", style: "Lady Dior" },
  },
  // HERMÈS — the instructive refusal. The blind stamp is a bare LETTER and the
  // house ships NO serial number at all, so there is nothing to decode. These
  // cases pin that a stamp-like input recovers NOTHING.
  {
    name: "Hermès blind stamp letter — no false-positive brand recovery",
    // THE COSTLIEST FALSE POSITIVE THE KB COULD MINT. A pattern over a single
    // letter would brand any tag bearing one as the most valuable label in the
    // pack. Deliberately decoder-less — the Chanel rule at its limit.
    brand: "Hermès",
    pack: pack("Hermès", "herms", [style("Birkin"), style("Kelly")]),
    input: decodedFrom({ styleCode: "D" }),
    expect: { noBrand: true },
  },
  {
    name: "Hermès single known style fills the style the AI missed",
    brand: "Hermès",
    pack: pack("Hermès", "herms", [style("Birkin")]),
    input: decodedFrom({ brand: "Hermès" }),
    expect: { brand: "Hermès", style: "Birkin" },
  },
  {
    name: "Hermès ambiguous trapezoidal flap bags (Birkin vs Kelly) — never guess",
    // Same leathers, same touret, same clochette — only the HANDLE COUNT
    // separates them, and the pack must not pick one from the shared parts.
    brand: "Hermès",
    pack: pack("Hermès", "herms", [style("Birkin"), style("Kelly")]),
    input: decodedFrom({ brand: "Hermès" }),
    expect: { brand: "Hermès", noStyle: true },
  },
  {
    name: "Saint Laurent tab serial — no false-positive brand recovery (bare digit run)",
    brand: "Saint Laurent",
    pack: pack("Saint Laurent", "saintlaurent", [style("Sac de Jour"), style("LouLou")]),
    input: decodedFrom({ styleCode: "469390021" }),
    expect: { noBrand: true },
  },
  {
    name: "Saint Laurent ambiguous chain-strap flap bags (LouLou vs Kate) — never guess",
    brand: "Saint Laurent",
    pack: pack("Saint Laurent", "saintlaurent", [style("LouLou"), style("Kate")]),
    input: decodedFrom({ brand: "Saint Laurent" }),
    expect: { brand: "Saint Laurent", noStyle: true },
  },
  {
    name: "Saint Laurent single known style fills the style the AI missed",
    brand: "Saint Laurent",
    pack: pack("Saint Laurent", "saintlaurent", [style("Sac de Jour")]),
    input: decodedFrom({ brand: "Saint Laurent" }),
    expect: { brand: "Saint Laurent", style: "Sac de Jour" },
  },
  {
    name: "Balenciaga ambiguous eras (Ghesquière City vs Demna Hourglass) — never guess",
    // The group's era trap in resolver form: two markets under one label. The
    // pack must not pick a ladder the input never named.
    brand: "Balenciaga",
    pack: pack("Balenciaga", "balenciaga", [style("City Bag"), style("Hourglass")]),
    input: decodedFrom({ brand: "Balenciaga" }),
    expect: { brand: "Balenciaga", noStyle: true },
  },
  {
    name: "Balenciaga tab serial — no false-positive brand recovery (bare digit run)",
    brand: "Balenciaga",
    pack: pack("Balenciaga", "balenciaga", [style("City Bag"), style("Hourglass")]),
    input: decodedFrom({ styleCode: "115748213048" }),
    expect: { noBrand: true },
  },
  {
    name: "Balenciaga single known style fills the style the AI missed",
    brand: "Balenciaga",
    pack: pack("Balenciaga", "balenciaga", [style("Triple S")]),
    input: decodedFrom({ brand: "Balenciaga" }),
    expect: { brand: "Balenciaga", style: "Triple S" },
  },
  {
    name: "Bottega Veneta ambiguous Intrecciato bags (Cassette vs Jodie) — never guess",
    brand: "Bottega Veneta",
    pack: pack("Bottega Veneta", "bottegaveneta", [style("Cassette"), style("Jodie")]),
    input: decodedFrom({ brand: "Bottega Veneta" }),
    expect: { brand: "Bottega Veneta", noStyle: true },
  },
  {
    name: "Bottega Veneta catalog SKU — no false-positive brand recovery (no decoder)",
    brand: "Bottega Veneta",
    pack: pack("Bottega Veneta", "bottegaveneta", [style("Cassette"), style("Jodie")]),
    input: decodedFrom({ styleCode: "115653-VQ131" }),
    expect: { noBrand: true },
  },
  {
    name: "Bottega Veneta single known style fills the style the AI missed",
    brand: "Bottega Veneta",
    pack: pack("Bottega Veneta", "bottegaveneta", [style("Cassette")]),
    input: decodedFrom({ brand: "Bottega Veneta" }),
    expect: { brand: "Bottega Veneta", style: "Cassette" },
  },
  {
    name: "Fendi ambiguous FF-marked bags (Baguette vs Peekaboo) — never guess",
    brand: "Fendi",
    pack: pack("Fendi", "fendi", [style("Baguette"), style("Peekaboo")]),
    input: decodedFrom({ brand: "Fendi" }),
    expect: { brand: "Fendi", noStyle: true },
  },
  {
    name: "Fendi catalog SKU — no false-positive brand recovery (no decoder)",
    brand: "Fendi",
    pack: pack("Fendi", "fendi", [style("Baguette"), style("Peekaboo")]),
    input: decodedFrom({ styleCode: "8BR600-A5DY-F0KUR" }),
    expect: { noBrand: true },
  },
  {
    name: "Fendi single known style fills the style the AI missed",
    brand: "Fendi",
    pack: pack("Fendi", "fendi", [style("Baguette")]),
    input: decodedFrom({ brand: "Fendi" }),
    expect: { brand: "Fendi", style: "Baguette" },
  },
  {
    name: "Versace ambiguous house marks (Barocco vs Greca) — never guess",
    brand: "Versace",
    pack: pack("Versace", "versace", [style("Barocco Print"), style("Greca")]),
    input: decodedFrom({ brand: "Versace" }),
    expect: { brand: "Versace", noStyle: true },
  },
  {
    name: "Versace prints no regular code — no false-positive brand recovery",
    brand: "Versace",
    pack: pack("Versace", "versace", [style("Barocco Print"), style("Greca")]),
    input: decodedFrom({ styleCode: "A87404-A234593" }),
    expect: { noBrand: true },
  },
  {
    name: "Versace single known style fills the style the AI missed",
    brand: "Versace",
    pack: pack("Versace", "versace", [style("Medusa")]),
    input: decodedFrom({ brand: "Versace" }),
    expect: { brand: "Versace", style: "Medusa" },
  },
  {
    name: "Celine ambiguous winged Philo totes (Luggage vs Trapeze) — never guess",
    // Both are winged Philo-era totes and the photo does not reliably separate
    // them — exactly the case where a guess costs a wrong listing.
    brand: "Celine",
    pack: pack("Celine", "celine", [style("Luggage Tote"), style("Trapeze")]),
    input: decodedFrom({ brand: "Celine" }),
    expect: { brand: "Celine", noStyle: true },
  },
  {
    name: "Celine catalog SKU — no false-positive brand recovery (no decoder)",
    brand: "Celine",
    pack: pack("Celine", "celine", [style("Luggage Tote"), style("Box Bag")]),
    input: decodedFrom({ styleCode: "189173DRU-38NO" }),
    expect: { noBrand: true },
  },
  {
    name: "Celine single known style fills the style the AI missed",
    brand: "Celine",
    pack: pack("Celine", "celine", [style("Box Bag")]),
    input: decodedFrom({ brand: "Celine" }),
    expect: { brand: "Celine", style: "Box Bag" },
  },
  // ── US-1983 new-generation streetwear & hype group ─────────────────────────
  // Off-White carries the group's CUT-TAG cases: the season/style code is printed
  // on the interior CARE LABEL, which survives the brand tab being cut out. The
  // other eight are decoder-less by design — seven print no regular garment-side
  // code AT ALL — and their guarantee is that enrichment stays CORRECT without
  // one. That guarantee carries more weight in this tier than anywhere: these are
  // the most bootlegged garments in the KB, and most of them are a blank hoodie
  // with a print, so a false-positive brand recovery has nothing to contradict it.
  {
    name: "Off-White cut brand tab — the care-label season code recovers the brand",
    brand: "Off-White",
    pack: pack("Off-White", "offwhite", [], [OFF_WHITE_STYLE_NUMBER_DECODER]),
    input: decodedFrom({ styleCode: "OMAA038R21FAB001" }), // no AI brand
    expect: { brand: "Off-White", recovery: true },
  },
  {
    name: "Off-White women's code also recovers the brand off a cut tab",
    brand: "Off-White",
    pack: pack("Off-White", "offwhite", [], [OFF_WHITE_STYLE_NUMBER_DECODER]),
    input: decodedFrom({ styleCode: "OWAA049S23FAB002" }),
    expect: { brand: "Off-White", recovery: true },
  },
  {
    name: "Off-White code overrides a wrong AI brand + surfaces conflict",
    // The realistic confusion in this tier: another hype label whose printed
    // hoodies photograph identically. The code is the only thing that separates
    // them, which is exactly why this group has one decoder and not zero.
    brand: "Off-White",
    pack: pack("Off-White", "offwhite", [], [OFF_WHITE_STYLE_NUMBER_DECODER]),
    input: decodedFrom({ brand: "Hellstar", styleCode: "OMAA038R21FAB001" }),
    expect: { brand: "Off-White", conflictOn: "brand", recovery: true },
  },
  {
    name: "Off-White bare digit run — no false-positive recovery",
    // The Chanel rule (US-1736). Strip the OM/OW prefix and the season token and
    // what is left is an ordinary number, which must recover nothing.
    brand: "Off-White",
    pack: pack("Off-White", "offwhite", [], [OFF_WHITE_STYLE_NUMBER_DECODER]),
    input: decodedFrom({ styleCode: "038211" }),
    expect: { noBrand: true },
  },
  {
    name: "Off-White wrong-prefix code — no false-positive recovery",
    // OM/OW is the gendered brand marker and it is load-bearing: a code that does
    // not carry it is not an Off-White code, however similar its shape.
    brand: "Off-White",
    pack: pack("Off-White", "offwhite", [], [OFF_WHITE_STYLE_NUMBER_DECODER]),
    input: decodedFrom({ styleCode: "OXAA038R21FAB001" }),
    expect: { noBrand: true },
  },
  {
    name: "Off-White wrong-shape code — no false-positive recovery",
    brand: "Off-White",
    pack: pack("Off-White", "offwhite", [], [OFF_WHITE_STYLE_NUMBER_DECODER]),
    input: decodedFrom({ styleCode: "OMAA38R21FAB001" }),
    expect: { noBrand: true },
  },
  {
    name: "Off-White ambiguous graphic pieces (Diagonals vs Arrows) — never guess",
    brand: "Off-White",
    pack: pack("Off-White", "offwhite", [
      style("Diagonals"),
      style("Arrows Logo"),
    ], [OFF_WHITE_STYLE_NUMBER_DECODER]),
    input: decodedFrom({ brand: "Off-White" }),
    expect: { brand: "Off-White", noStyle: true },
  },
  {
    name: "Off-White single known style fills the style the AI missed",
    brand: "Off-White",
    pack: pack("Off-White", "offwhite", [style("Industrial Belt")], [
      OFF_WHITE_STYLE_NUMBER_DECODER,
    ]),
    input: decodedFrom({ brand: "Off-White" }),
    expect: { brand: "Off-White", style: "Industrial Belt" },
  },
  // The eight decoder-less brands. NOTHING they print may recover a brand — and
  // the codes below are the realistic near-misses: a Denim Tears piece's interior
  // Levi's tag, a Gallery Dept. donor tag, and the plain numbers that turn up on
  // any blank's care label.
  {
    name: "Chrome Hearts prints no code — a stray number recovers nothing",
    brand: "Chrome Hearts",
    pack: pack("Chrome Hearts", "chromehearts", [style("Cross Patch Hoodie")]),
    input: decodedFrom({ styleCode: "925" }),
    expect: { noBrand: true },
  },
  {
    name: "Sp5der prints no code — a stray number recovers nothing",
    brand: "Sp5der",
    pack: pack("Sp5der", "sp5der", [style("Web Hoodie")]),
    input: decodedFrom({ styleCode: "555555" }),
    expect: { noBrand: true },
  },
  {
    name: "Hellstar prints no code — a stray number recovers nothing",
    brand: "Hellstar",
    pack: pack("Hellstar", "hellstar", [style("Flame Hoodie")]),
    input: decodedFrom({ styleCode: "0001" }),
    expect: { noBrand: true },
  },
  {
    name: "Denim Tears — the donor Levi's tag code recovers nothing",
    // The group's dual-branding trap in decoder form. A Cotton Wreath 501 has a
    // real Levi's code inside it, and the KB must NOT let that mint a brand off
    // the Denim Tears pack — the tag is the base garment's, and the piece is
    // still a Denim Tears.
    brand: "Denim Tears",
    pack: pack("Denim Tears", "denimtears", [style("Cotton Wreath 501")]),
    input: decodedFrom({ styleCode: "00501-0000" }),
    expect: { noBrand: true },
  },
  {
    name: "Gallery Dept. — an upcycled donor tag's code recovers nothing",
    brand: "Gallery Dept.",
    pack: pack("Gallery Dept.", "gallerydept", [style("Painted Flare Jeans")]),
    input: decodedFrom({ styleCode: "00505-1234" }),
    expect: { noBrand: true },
  },
  {
    name: "Aimé Leon Dore internal SKU — no false-positive recovery (no decoder)",
    // Tag-printed but neither regular across categories nor brand-unique in
    // shape, so it fails the US-1740 bar and gets no decoder.
    brand: "Aimé Leon Dore",
    pack: pack("Aimé Leon Dore", "aimleondore", [style("Knit Polo")]),
    input: decodedFrom({ styleCode: "ALD-SS21-0042" }),
    expect: { noBrand: true },
  },
  {
    name: "Rhude prints no code — a stray number recovers nothing",
    brand: "Rhude",
    pack: pack("Rhude", "rhude", [style("Silk Shirt")]),
    input: decodedFrom({ styleCode: "1985" }),
    expect: { noBrand: true },
  },
  {
    name: "ASSC prints no code — a stray number recovers nothing",
    brand: "Anti Social Social Club",
    pack: pack("Anti Social Social Club", "antisocialsocialclub", [
      style("Logo Hoodie"),
    ]),
    input: decodedFrom({ styleCode: "2015" }),
    expect: { noBrand: true },
  },
  {
    name: "Sp5der ambiguous graphic pieces (Web Hoodie vs Web Sweatpant) — never guess",
    brand: "Sp5der",
    pack: pack("Sp5der", "sp5der", [
      style("Web Hoodie"),
      style("Web Sweatpant"),
    ]),
    input: decodedFrom({ brand: "Sp5der" }),
    expect: { brand: "Sp5der", noStyle: true },
  },
  {
    name: "Gallery Dept. single known style fills the style the AI missed",
    brand: "Gallery Dept.",
    pack: pack("Gallery Dept.", "gallerydept", [style("Logo Tee")]),
    input: decodedFrom({ brand: "Gallery Dept." }),
    expect: { brand: "Gallery Dept.", style: "Logo Tee" },
  },

  // ── US-1984 premium denim group (tier 2) ───────────────────────────────────
  // Diesel carries the group's CUT-TAG cases on a kind of token 00454's denim
  // pack could not use: a COINED model name, which needs no compound suffix to be
  // safe. The other seven are decoder-less by design and their guarantee is that
  // enrichment stays CORRECT without one — which matters here because six of the
  // eight print a fit name and NOTHING else.
  {
    name: "Diesel cut brand tag — the coined model name alone recovers the brand",
    brand: "Diesel",
    pack: pack("Diesel", "diesel", [], [DIESEL_STYLE_NAME_DECODER]),
    input: decodedFrom({ styleCode: "THOMMER" }), // no AI brand
    expect: { brand: "Diesel", recovery: true },
  },
  {
    name: "Diesel -X stretch marker is tolerated and still recovers the brand",
    // The suffix marks the FABRIC, not the style, so it is matched but not
    // captured — the styleCode must come back as the bare model.
    brand: "Diesel",
    pack: pack("Diesel", "diesel", [], [DIESEL_STYLE_NAME_DECODER]),
    input: decodedFrom({ styleCode: "Thommer-X" }),
    expect: { brand: "Diesel", recovery: true },
  },
  {
    name: "Diesel D- era name recovers the brand off a cut tag",
    // The current Glenn Martens generation, decoded by the same rule. Worth its
    // own case because the model name is this brand's ERA evidence: a D-Strukt
    // and a Thommer are the same slot in the line a decade apart.
    brand: "Diesel",
    pack: pack("Diesel", "diesel", [], [DIESEL_STYLE_NAME_DECODER]),
    input: decodedFrom({ styleCode: "D-STRUKT" }),
    expect: { brand: "Diesel", recovery: true },
  },
  {
    name: "Diesel model name overrides a wrong AI brand + surfaces conflict",
    brand: "Diesel",
    pack: pack("Diesel", "diesel", [], [DIESEL_STYLE_NAME_DECODER]),
    input: decodedFrom({ brand: "G-Star RAW", styleCode: "SLEENKER" }),
    expect: { brand: "Diesel", conflictOn: "brand", recovery: true },
  },
  {
    name: "Diesel wash code — no false-positive recovery",
    // Diesel prints a wash/lot code (0688H) beside the model. It identifies the
    // FINISH, is a bare alphanumeric with no brand-unique shape, and must not
    // mint a brand.
    brand: "Diesel",
    pack: pack("Diesel", "diesel", [], [DIESEL_STYLE_NAME_DECODER]),
    input: decodedFrom({ styleCode: "0688H" }),
    expect: { noBrand: true },
  },
  {
    name: "Diesel ordinary fit word — no false-positive recovery",
    // The coined-vocabulary argument in negative form: an English word is exactly
    // what the decoder must NOT accept, or the whole rationale collapses.
    brand: "Diesel",
    pack: pack("Diesel", "diesel", [], [DIESEL_STYLE_NAME_DECODER]),
    input: decodedFrom({ styleCode: "Slim" }),
    expect: { noBrand: true },
  },
  {
    name: "Diesel ambiguous adjacent fits (Larkee vs Thommer) — never guess",
    // The pack's core problem: no Diesel fit has a pocket tell, and the fits sit
    // on one narrowing scale. With no code, the style must stay unset.
    brand: "Diesel",
    pack: pack("Diesel", "diesel", [
      style("Larkee"),
      style("Thommer"),
    ], [DIESEL_STYLE_NAME_DECODER]),
    input: decodedFrom({ brand: "Diesel" }),
    expect: { brand: "Diesel", noStyle: true },
  },
  // The seven decoder-less brands. The two pointed refusals first — these are the
  // codes that LOOK decodable and deliberately are not.
  {
    name: "G-Star 3301 — a bare digit run recovers nothing (the Lee 101 rule)",
    // 3301 is G-Star's core denim family and is genuinely printed on the tag, but
    // it is an ordinary 4-digit number: a pattern over it would false-recover
    // G-Star from any tag carrying one.
    brand: "G-Star RAW",
    pack: pack("G-Star RAW", "gstarraw", [style("3301"), style("Elwood 5620 3D")]),
    input: decodedFrom({ styleCode: "3301" }),
    expect: { noBrand: true },
  },
  {
    name: "G-Star 5620 (the Elwood's number) recovers nothing either",
    brand: "G-Star RAW",
    pack: pack("G-Star RAW", "gstarraw", [style("Elwood 5620 3D")]),
    input: decodedFrom({ styleCode: "5620" }),
    expect: { noBrand: true },
  },
  {
    name: "Rag & Bone 'Fit 2' — regular and tag-printed, but an ordinary phrase",
    // The refusal worth fixturing: this one passes two of the three tests
    // (tag-printed, regular) and fails only brand-uniqueness, which is the test
    // that is easiest to skip.
    brand: "Rag & Bone",
    pack: pack("Rag & Bone", "ragbone", [style("Fit 2"), style("Fit 1")]),
    input: decodedFrom({ styleCode: "Fit 2" }),
    expect: { noBrand: true },
  },
  {
    name: "Hudson fit name is an ordinary given name — recovers nothing",
    // The True Religion "Ricky" hazard with no Super T available to compound
    // with, which is exactly why Hudson gets no decoder.
    brand: "Hudson Jeans",
    pack: pack("Hudson Jeans", "hudsonjeans", [style("Barbara"), style("Blake")]),
    input: decodedFrom({ styleCode: "Blake" }),
    expect: { noBrand: true },
  },
  {
    name: "MOTHER fit name is an ordinary English word — recovers nothing",
    brand: "MOTHER",
    pack: pack("MOTHER", "mother", [style("The Looker")]),
    input: decodedFrom({ styleCode: "The Looker" }),
    expect: { noBrand: true },
  },
  {
    name: "FRAME prints no code — a stray number recovers nothing",
    brand: "FRAME",
    pack: pack("FRAME", "frame", [style("Le Skinny de Jeanne")]),
    input: decodedFrom({ styleCode: "2012" }),
    expect: { noBrand: true },
  },
  {
    name: "PAIGE prints no code — a stray number recovers nothing",
    brand: "PAIGE",
    pack: pack("PAIGE", "paige", [style("Verdugo")]),
    input: decodedFrom({ styleCode: "0042" }),
    expect: { noBrand: true },
  },
  {
    name: "Joe's Jeans prints no code — a stray number recovers nothing",
    brand: "Joe's Jeans",
    pack: pack("Joe's Jeans", "joesjeans", [style("The Brixton")]),
    input: decodedFrom({ styleCode: "2001" }),
    expect: { noBrand: true },
  },
  {
    name: "MOTHER ambiguous adjacent fits (Looker vs Tomcat) — never guess",
    brand: "MOTHER",
    pack: pack("MOTHER", "mother", [
      style("The Looker"),
      style("The Tomcat"),
    ]),
    input: decodedFrom({ brand: "MOTHER" }),
    expect: { brand: "MOTHER", noStyle: true },
  },
  {
    name: "PAIGE single known style fills the style the AI missed",
    brand: "PAIGE",
    pack: pack("PAIGE", "paige", [style("Verdugo")]),
    input: decodedFrom({ brand: "PAIGE" }),
    expect: { brand: "PAIGE", style: "Verdugo" },
  },

  // ── US-1985 activewear group (tier 2) ──────────────────────────────────────
  // ASICS carries the group's CUT-TAG cases, and it earns the decoder on the
  // third test rather than the first two: its article number's DIGITS-THEN-LETTER
  // shape is brand-unique. The other eight are decoder-less by design, and their
  // guarantee is that enrichment stays CORRECT without one.
  //
  // The refusals matter more here than in any prior pack, because this group is
  // full of codes that LOOK decodable: PUMA's six-digit style number, Reebok's
  // adidas-shaped code, and ASICS's OWN bare model numbers. Each is fixtured as a
  // negative below.
  {
    name: "ASICS cut brand tag — the tongue article number alone recovers the brand",
    brand: "ASICS",
    pack: pack("ASICS", "asics", [], [ASICS_ARTICLE_NUMBER_DECODER]),
    input: decodedFrom({ styleCode: "1011B491" }), // no AI brand
    expect: { brand: "ASICS", recovery: true },
  },
  {
    name: "ASICS lowercase article number still recovers the brand",
    // A tongue label is read off a photo, so case is unreliable — the transform
    // normalizes it up.
    brand: "ASICS",
    pack: pack("ASICS", "asics", [], [ASICS_ARTICLE_NUMBER_DECODER]),
    input: decodedFrom({ styleCode: "1012b420" }),
    expect: { brand: "ASICS", recovery: true },
  },
  {
    name: "ASICS article number with a colour suffix is tolerated",
    // The -001 marks the COLOURWAY, not the style, so it is matched but not
    // captured — a colour CODE is not a colour name.
    brand: "ASICS",
    pack: pack("ASICS", "asics", [], [ASICS_ARTICLE_NUMBER_DECODER]),
    input: decodedFrom({ styleCode: "1011B491-001" }),
    expect: { brand: "ASICS", recovery: true },
  },
  {
    name: "ASICS article number overrides a wrong AI brand + surfaces conflict",
    brand: "ASICS",
    pack: pack("ASICS", "asics", [], [ASICS_ARTICLE_NUMBER_DECODER]),
    input: decodedFrom({ brand: "Reebok", styleCode: "1201A019" }),
    expect: { brand: "ASICS", conflictOn: "brand", recovery: true },
  },
  {
    name: "ASICS ambiguous adjacent trainers (Kayano vs Nimbus) — never guess",
    // The pack's core problem in footwear: the Kayano (stability) and the Nimbus
    // (neutral) differ by SUPPORT, not shape, which a photo cannot show. With no
    // code, the style must stay unset.
    brand: "ASICS",
    pack: pack("ASICS", "asics", [
      style("GEL-Kayano"),
      style("GEL-Nimbus"),
    ], [ASICS_ARTICLE_NUMBER_DECODER]),
    input: decodedFrom({ brand: "ASICS" }),
    expect: { brand: "ASICS", noStyle: true },
  },
  // THE REFUSALS. The adidas-shaped code is the one worth staring at: it is why
  // Reebok — a brand in this very pack, with a tag-printed, perfectly regular
  // code — deliberately gets no decoder at all.
  {
    name: "Reebok/adidas-shaped code must NOT recover ASICS (format is not brand-unique)",
    brand: "ASICS",
    pack: pack("ASICS", "asics", [], [ASICS_ARTICLE_NUMBER_DECODER]),
    input: decodedFrom({ styleCode: "GY7434" }),
    expect: { noBrand: true },
  },
  {
    name: "Nike-shaped style code must NOT recover ASICS",
    brand: "ASICS",
    pack: pack("ASICS", "asics", [], [ASICS_ARTICLE_NUMBER_DECODER]),
    input: decodedFrom({ styleCode: "CW2288-111" }),
    expect: { noBrand: true },
  },
  {
    name: "New Balance-shaped model number must NOT recover ASICS",
    brand: "ASICS",
    pack: pack("ASICS", "asics", [], [ASICS_ARTICLE_NUMBER_DECODER]),
    input: decodedFrom({ styleCode: "M990GL5" }),
    expect: { noBrand: true },
  },
  {
    name: "PUMA 6-digit style number recovers nothing (the Lee 101 rule)",
    // PUMA's style number is tag-printed and regular and is deliberately NOT a
    // decoder: a bare digit run is an ordinary number, so a pattern over it would
    // mint PUMA from any tag carrying six digits.
    brand: "PUMA",
    pack: pack("PUMA", "puma", [style("Suede Classic")]),
    input: decodedFrom({ styleCode: "380190" }),
    expect: { noBrand: true },
  },
  {
    name: "ASICS's OWN bare model number (1130) recovers nothing",
    // The same rule turned on the brand that HAS the decoder: GEL-1130 is a model
    // name, not a code. The decoder is deliberately narrow enough to refuse it.
    brand: "ASICS",
    pack: pack("ASICS", "asics", [style("GEL-1130")], [ASICS_ARTICLE_NUMBER_DECODER]),
    input: decodedFrom({ styleCode: "1130" }),
    expect: { noBrand: true },
  },
  // The decoder-less brands: enrichment must stay correct without a code.
  {
    name: "PUMA ambiguous twins (Suede vs Clyde) — never guess",
    // The Clyde IS the Suede with Frazier's endorsement: same last, same
    // silhouette, different value. Nothing in a photo separates them.
    brand: "PUMA",
    pack: pack("PUMA", "puma", [style("Suede Classic"), style("Clyde")]),
    input: decodedFrom({ brand: "PUMA" }),
    expect: { brand: "PUMA", noStyle: true },
  },
  {
    name: "Reebok ambiguous twins (Classic Leather vs Club C) — never guess",
    brand: "Reebok",
    pack: pack("Reebok", "reebok", [style("Classic Leather"), style("Club C 85")]),
    input: decodedFrom({ brand: "Reebok" }),
    expect: { brand: "Reebok", noStyle: true },
  },
  {
    name: "HOKA ambiguous twins (Bondi vs Clifton) — never guess",
    brand: "HOKA",
    pack: pack("HOKA", "hoka", [style("Bondi"), style("Clifton")]),
    input: decodedFrom({ brand: "HOKA" }),
    expect: { brand: "HOKA", noStyle: true },
  },
  // NOTE the HOKA ONE ONE -> HOKA rename is asserted in activewear-content_test.ts
  // and NOT here, deliberately: enrichment does not re-canonicalize the AI's brand
  // string on its own — only a DECODER hit overrides it, and HOKA has no decoder.
  // The rename is an ALIAS-TABLE fact (canonicalizeBrand), so that is where it is
  // tested. Asserting it here would assert something the resolver never promised.
  {
    name: "Champion single known style fills the style the AI missed",
    brand: "Champion",
    pack: pack("Champion", "champion", [style("Reverse Weave Hoodie")]),
    input: decodedFrom({ brand: "Champion" }),
    expect: { brand: "Champion", style: "Reverse Weave Hoodie" },
  },
  {
    name: "Champion Reverse Weave vs Powerblend — never guess the construction",
    // The pack's money pair: same silhouette, same sleeve C, multiples apart in
    // price, separated only by the side gusset and the tag. A model that guesses
    // here overprices a Powerblend by a multiple.
    brand: "Champion",
    pack: pack("Champion", "champion", [
      style("Reverse Weave Hoodie"),
      style("Powerblend Hoodie"),
    ]),
    input: decodedFrom({ brand: "Champion" }),
    expect: { brand: "Champion", noStyle: true },
  },
  {
    name: "Girlfriend Collective ambiguous fabrics (Compressive vs FLOAT) — never guess",
    // This brand's taxonomy is FABRIC NAMES on one silhouette, so a legging with
    // no legible tag has no identifiable style at all.
    brand: "Girlfriend Collective",
    pack: pack("Girlfriend Collective", "girlfriendcollective", [
      style("Compressive Legging"),
      style("FLOAT Legging"),
    ]),
    input: decodedFrom({ brand: "Girlfriend Collective" }),
    expect: { brand: "Girlfriend Collective", noStyle: true },
  },
  {
    name: "On Running single known style fills the style the AI missed",
    brand: "On Running",
    pack: pack("On Running", "onrunning", [style("Cloud 5")]),
    input: decodedFrom({ brand: "On Running" }),
    expect: { brand: "On Running", style: "Cloud 5" },
  },
  {
    name: "Fila ambiguous shoe vs garment line — never guess",
    // Fila is half footwear and half apparel under one name, so with only a brand
    // and no tag the style is genuinely unknowable — the pack's dual-system
    // problem showing up in the resolver rather than the charts.
    brand: "Fila",
    pack: pack("Fila", "fila", [style("Disruptor II"), style("F-Box Logo Tee")]),
    input: decodedFrom({ brand: "Fila" }),
    expect: { brand: "Fila", noStyle: true },
  },
  {
    name: "Outdoor Voices single known style fills the style the AI missed",
    brand: "Outdoor Voices",
    pack: pack("Outdoor Voices", "outdoorvoices", [style("Exercise Dress")]),
    input: decodedFrom({ brand: "Outdoor Voices" }),
    expect: { brand: "Outdoor Voices", style: "Exercise Dress" },
  },

  // ── US-1986: fast-fashion & mall, tier 2 (migration 00466) ─────────────────
  // THIS GROUP SEEDS **ZERO** DECODERS, so — like Alo Yoga (US-1731) — its cases
  // prove the enrichment stays correct WITHOUT one. The refusals are the
  // instructive half and they are fixtured as NEGATIVES below, because a refusal
  // that isn't tested is just a comment: the codes exist and are real, and each
  // one fails a DIFFERENT clause of the "tag-printed AND regular AND brand-unique
  // in FORMAT" bar.
  {
    name: "UO/BDG single known style fills the style the AI missed",
    brand: "Urban Outfitters",
    pack: pack("Urban Outfitters", "urbanoutfitters", [style("BDG Denim")]),
    input: decodedFrom({ brand: "Urban Outfitters" }),
    expect: { brand: "Urban Outfitters", style: "BDG Denim" },
  },
  {
    name: "UO ambiguous house labels (BDG vs Out From Under) — never guess a style",
    // The house-label pack's version of the ambiguity: both are UO labels, and a
    // brand alone cannot say which.
    brand: "Urban Outfitters",
    pack: pack("Urban Outfitters", "urbanoutfitters", [
      style("BDG Denim"),
      style("Out From Under"),
    ]),
    input: decodedFrom({ brand: "Urban Outfitters" }),
    expect: { brand: "Urban Outfitters", noStyle: true },
  },
  {
    name: "REFUSAL: an OB###### code does NOT recover Urban Outfitters",
    // THE GROUP'S HEADLINE REFUSAL, and the exact shape of US-1985's Reebok call.
    // OB416788 is a REAL identifier — URBN's own vendor manual specifies
    // "All Ownbrand style numbers start with OB, followed by 6 digits" — and it is
    // tag-printed AND regular, so it clears two of the three bars. It fails the
    // third, which is the one that matters: the code is **URBN-WIDE**, and URBN is
    // Urban Outfitters AND Anthropologie AND Free People. The latter two already
    // own their own packs (00457, 00449) and their own target customers, so a
    // decoder here would spell "Urban Outfitters" onto a sibling's garment with
    // DECODER authority — which outranks the AI on conflict. Reebok's code was
    // refused for the identical reason (the format is adidas's).
    //
    // Seeding no decoder means the pack simply has none to run, and the code is
    // inert. Asserted rather than assumed: no in-code DEFAULT spec may start
    // matching it either.
    brand: "Urban Outfitters",
    pack: pack("Urban Outfitters", "urbanoutfitters"),
    input: decodedFrom({ styleCode: "OB416788" }),
    expect: { noBrand: true },
  },
  {
    name: "REFUSAL: a Zara slash-separated reference does NOT recover Zara",
    // The most TEMPTING refusal in the group, because this code clears the bar
    // that killed the others: it IS on the sewn-in care label (not just the price
    // sticker), so it survives the tags being cut. It fails on FORMAT CERTAINTY
    // instead — the available sources do not agree on what the format even is
    // (4-digit/3-digit vs a third group), and a slash-separated digit run is not
    // brand-unique in any case. A pattern we cannot state confidently would let a
    // format GUESS override the tag's own brand, which is the exact failure the
    // New Balance/Converse precedence rule exists to stop.
    //
    // The second, independent reason: Zara's own lookup only resolves CURRENTLY
    // SOLD items, so on a years-old resale garment the code identifies nothing.
    // A decoder that cannot decode is not worth a false-positive budget.
    brand: "Zara",
    pack: pack("Zara", "zara"),
    input: decodedFrom({ styleCode: "5644/128/800" }),
    expect: { noBrand: true },
  },
  {
    name: "REFUSAL: a bare 8-digit Express style number does NOT recover Express",
    // The Lee-101 / PUMA-six-digit rule: a bare digit run is not a brand. An
    // 8-digit number is shared with countless brands, so a pattern over it would
    // let a FORMAT guess override the tag's own brand.
    brand: "Express",
    pack: pack("Express", "express"),
    input: decodedFrom({ styleCode: "07922317" }),
    expect: { noBrand: true },
  },
  {
    name: "Express single known style fills the style the AI missed",
    brand: "Express",
    pack: pack("Express", "express", [style("Portofino Shirt")]),
    input: decodedFrom({ brand: "Express" }),
    expect: { brand: "Express", style: "Portofino Shirt" },
  },
  {
    name: "Express ambiguous Editor vs Columnist pant — never guess a style",
    // A REAL ambiguity, not a contrived one: Editor and Columnist differ only by
    // rise and leg width, which a flat photo cannot resolve. Express's own copy is
    // the source ("the Editor sits just below the waist... the Columnist sits
    // lower"), and several blogs state it backwards — so guessing here is exactly
    // the failure the never-guess rule exists for.
    brand: "Express",
    pack: pack("Express", "express", [style("Editor Pant"), style("Columnist Pant")]),
    input: decodedFrom({ brand: "Express" }),
    expect: { brand: "Express", noStyle: true },
  },
  {
    name: "PacSun/Bullhead single known style fills the style the AI missed",
    brand: "PacSun",
    pack: pack("PacSun", "pacsun", [style("Bullhead Denim")]),
    input: decodedFrom({ brand: "PacSun" }),
    expect: { brand: "PacSun", style: "Bullhead Denim" },
  },
  {
    name: "PacSun house label vs the retailer row — never guess a style",
    // The pack's defining fact reaching the RESOLVER. ~70% of PacSun's sales were
    // other brands (its own 10-K), so 00466 seeds the retailer trap as a
    // first-class style row (the 00457 Anthropologie precedent). That row is what
    // makes a bare "PacSun" ambiguous — which is CORRECT and is the point: the
    // store is not the brand, so a store name must not fill a house label's style.
    // The prompt-side half of this fact is asserted in the content test.
    brand: "PacSun",
    pack: pack("PacSun", "pacsun", [
      style("Bullhead Denim"),
      style("Third-Party Brand at PacSun"),
    ]),
    input: decodedFrom({ brand: "PacSun" }),
    expect: { brand: "PacSun", noStyle: true },
  },
  {
    name: "REFUSAL: a Lucky Brand 7M##### product code does NOT recover the brand",
    // The group's LAST refusal and the one with the most real signal behind it:
    // Lucky's product codes genuinely follow a regular shape (7M##### men's,
    // 7W##### women's, 7MD#### outlet), visible in its own product URLs. Refused
    // because a WEBSITE SKU is not evidence of a CARE-TAG print — nothing sourced
    // says this code is on the garment at all — and no authoritative decoding
    // table exists. At best it would recover gender/channel, never the brand.
    brand: "Lucky Brand",
    pack: pack("Lucky Brand", "luckybrand"),
    input: decodedFrom({ styleCode: "7M12119" }),
    expect: { noBrand: true },
  },
  {
    name: "Lucky Brand single known fit fills the style the AI missed",
    brand: "Lucky Brand",
    pack: pack("Lucky Brand", "luckybrand", [style("121 Heritage Slim")]),
    input: decodedFrom({ brand: "Lucky Brand" }),
    expect: { brand: "Lucky Brand", style: "121 Heritage Slim" },
  },
  {
    name: "Lucky Brand ambiguous named fits — never guess a fit from a number",
    // A REAL ambiguity: Lucky's fit numbering has no decodable logic (the
    // tempting "4xx = athletic" rule has counterexamples), so with only a brand
    // the fit is unknowable and must not be guessed.
    brand: "Lucky Brand",
    pack: pack("Lucky Brand", "luckybrand", [
      style("121 Heritage Slim"),
      style("181 Relaxed Straight"),
      style("410 Athletic"),
    ]),
    input: decodedFrom({ brand: "Lucky Brand" }),
    expect: { brand: "Lucky Brand", noStyle: true },
  },
  {
    name: "Talbots single known style fills the style the AI missed",
    brand: "Talbots",
    pack: pack("Talbots", "talbots", [style("Misses / Petite / Plus size systems")]),
    input: decodedFrom({ brand: "Talbots" }),
    expect: { brand: "Talbots", style: "Misses / Petite / Plus size systems" },
  },
  {
    name: "LOFT keeps its own brand — the sister brand never folds to the parent",
    // The KnitWell three share a parent and must stay three canonicals. The
    // enrichment must not let Ann Taylor's pack claim a LOFT garment (or vice
    // versa) — the resolver half of the fold rule; the canonicalization half is
    // asserted in the content test.
    brand: "LOFT",
    pack: pack("LOFT", "loft", [style("LOFT Outlet")]),
    input: decodedFrom({ brand: "LOFT" }),
    expect: { brand: "LOFT", style: "LOFT Outlet" },
  },
  {
    name: "Ann Taylor with no decoder + no code — clean no-op",
    brand: "Ann Taylor",
    pack: pack("Ann Taylor", "anntaylor"),
    input: decodedFrom({ brand: "Ann Taylor" }),
    expect: { brand: "Ann Taylor" },
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
