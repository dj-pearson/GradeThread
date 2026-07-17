// US-1740: verify the footwear content (migration 00459) is correct + consumable
// by the engine.
//
// What these assertions are really protecting:
//
//   * THE SIZE IS NOT MEASURABLE — IT IS STAMPED. This is the first non-garment
//     pack in the epic and it INVERTS what a size chart is for. Every prior group's
//     chart is an ESTIMATOR (measure the bust, double it, read the row). A shoe's
//     size cannot be measured off a photo, so these charts are TRANSLATORS: the
//     brand's own number -> every other system's number.
//   * AND THE NUMBER IS IN A SYSTEM THE TAG DOES NOT NAME. A Dr. Martens stamped
//     "7" is a UK 7 (= US M8). A Birkenstock stamped "38" is an EU 38 (= US
//     W7-7.5). Neither says "UK" or "EU". This is not a pricing refinement like the
//     last three groups' era/line traps — it is a WRONG LISTING that no photo
//     reasoning catches, because the photo is not wrong: the shoe really says 7.
//   * CONVERSE AND VANS ARE THE SAME SHOE AND DO NOT SIZE THE SAME. Offset 2 vs
//     1.5, both dual-tagged, same shelf, same band. A model that learns one applies
//     it to the other.
//   * THE WIDTH LETTER FLIPS MEANING BY DEPARTMENT. "D" is STANDARD on men's New
//     Balance and WIDE on women's. The same character is correct in both.
//   * ONE DECODER, and it is the first to capture a SECOND field (gender from the
//     prefix). The PREFIX is the whole argument — which is why Dr. Martens, owner
//     of the most famous numbers in footwear, gets none: four digits is not a brand.
//   * FOUR COLORWAYS BRANDS, the first in four groups — footwear ships stable named
//     palettes where apparel ships seasonal English words.
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
const { buildTrustedBrandFactsBlock } = await import(
  "../lib/garment-baselines.ts"
);
const { findSizingCharts, SIZING_CHARTS, formatSizingChartsForPrompt } =
  await import("../lib/sizing-charts.ts");
const { canonicalizeBrand, isKnownBrand, detectBrandInText, resolveStyleCode } =
  await import("../lib/brand-normalize.ts");
const { runDecoderSpec } = await import("../lib/brand-decoders.ts");
import type {
  BrandKnowledgePack,
  BrandStyleKnowledge,
} from "../lib/brand-knowledge.ts";
import type { DecoderSpec } from "../lib/brand-decoders.ts";

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
    category: "footwear",
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
  decoders: BrandKnowledgePack["decoders"] = [],
  authenticationTells: BrandKnowledgePack["authenticationTells"] = [],
  colorways: BrandKnowledgePack["colorways"] = [],
): BrandKnowledgePack {
  return {
    brand,
    key,
    known: true,
    aliases: [],
    categoryFocus: ["footwear"],
    authenticationTells,
    tagEras: [],
    styles,
    decoders,
    colorways,
    sizingCharts: [],
    source: "db",
  };
}

// The seven brands of this group. New Balance, Vans and Converse already had a
// bare alias-only row from 00389; Dr. Martens, UGG, Birkenstock and Cole Haan are
// NEW rows — they were passthrough-only, so a "doc martens" tag rendered the
// seller's own casing into the prompt block and the eBay Brand aspect.
const GROUP: Array<[string, string]> = [
  ["New Balance", "newbalance"],
  ["Dr. Martens", "drmartens"],
  ["UGG", "ugg"],
  ["Birkenstock", "birkenstock"],
  ["Converse", "converse"],
  ["Vans", "vans"],
  ["Cole Haan", "colehaan"],
];

// The New Balance decoder EXACTLY as migration 00459 seeds it.
const NB_DECODER: DecoderSpec = {
  brandKey: "newbalance",
  decoderKind: "style_number",
  pattern: "^(?<style>(?:(?<gender>[MW])|U)\\d{3,4}[A-Z]{0,3}\\d?)$",
  fieldMap: { style: "styleCode", gender: "gender" },
  transforms: { style: "upper", gender: "genderCode" },
  confidence: 0.7,
};

// ── canonicalization ────────────────────────────────────────────────────────

Deno.test("US-1740: every footwear brand canonicalizes to its eBay spelling", () => {
  for (const [canonical] of GROUP) {
    assert(isKnownBrand(canonical), `${canonical} is a known brand`);
    assertEquals(canonicalizeBrand(canonical), canonical);
  }
});

Deno.test("US-1740: the sub-labels and misspellings fold onto their parent", () => {
  // Dr. Martens is the pack's spelling problem: the brand is written four ways and
  // none of them is how the shoe is labelled.
  assertEquals(canonicalizeBrand("doc martens"), "Dr. Martens");
  assertEquals(canonicalizeBrand("Doc Martens"), "Dr. Martens");
  assertEquals(canonicalizeBrand("Dr Martens"), "Dr. Martens");
  assertEquals(canonicalizeBrand("doctor martens"), "Dr. Martens");
  assertEquals(canonicalizeBrand("docmartins"), "Dr. Martens");
  // AirWair is the brand's OWN coined mark, printed on the yellow heel loop.
  assertEquals(canonicalizeBrand("AirWair"), "Dr. Martens");
  // UGG Australia is the pre-~2016 LABEL — same brand, and emphatically not a
  // claim about where the boot was made.
  assertEquals(canonicalizeBrand("UGG Australia"), "UGG");
  // Vault by Vans is the premium LINE, not a second brand: same eBay catalogue
  // brand, so it folds with the line kept in `style` (the Gap Factory play).
  assertEquals(canonicalizeBrand("Vault by Vans"), "Vans");
  assertEquals(canonicalizeBrand("Vans Off The Wall"), "Vans");
  assertEquals(canonicalizeBrand("Chuck Taylor"), "Converse");
});

Deno.test("US-1740: PLURALS fold — shoes are named in pairs, garments are not", () => {
  // The reason this group adds more plural keys than any prior one. The plural is
  // safe HERE because an alias key is an exact WHOLE-FIELD lookup — it can never
  // fire on a word inside surrounding text.
  assertEquals(canonicalizeBrand("UGGs"), "UGG");
  assertEquals(canonicalizeBrand("uggs"), "UGG");
  assertEquals(canonicalizeBrand("Birkenstocks"), "Birkenstock");
  assertEquals(canonicalizeBrand("New Balances"), "New Balance");
  assertEquals(canonicalizeBrand("Cole Haans"), "Cole Haan");
});

Deno.test("US-1740: the ordinary-word nicknames are NOT aliased", () => {
  // The rule that keeps a bare "bean" off L.L.Bean. "docs" is a word this very
  // product's text emits; "birks" is a Canadian jeweller; "chucks" is a name and a
  // verb. None may mint a brand. They must PASS THROUGH unchanged, not resolve.
  for (const nickname of ["docs", "birks", "chucks"]) {
    assert(
      !isKnownBrand(nickname),
      `"${nickname}" must not be a known brand — it is an ordinary word`,
    );
  }
});

// ── the "vans" / "ugg" token problem ────────────────────────────────────────

Deno.test("US-1740: 'vans' is an ENGLISH PLURAL and detectBrandInText is bounded", () => {
  // 00458's "Gap" shape: a real canonical brand spelled identically to a common
  // word. It cannot be removed, only contained. The both-sides boundary is the
  // containment and this pins it.
  assertEquals(detectBrandInText("Vans Old Skool Skate Shoe M8"), "Vans");
  // ...but never from an inflected form.
  assertEquals(detectBrandInText("Ford Transit vansready for work"), null);
  assertEquals(detectBrandInText("cargo vanside panel trim"), null);
});

Deno.test("US-1740: 'UGGs' does NOT resolve via detectBrandInText — and that is CORRECT", () => {
  // The asymmetry this group is the first to surface, and it must not be "fixed".
  // detectBrandInText is bounded on BOTH sides, so a trailing "s" blocks the match.
  // That trailing boundary is exactly what stops "Gap" firing on "gaps" — and
  // rebranding every "gaps" is a worse bug than missing a plural in a barcode
  // title. The plural is handled where it is safe instead: as an alias KEY.
  assertEquals(detectBrandInText("UGG Classic Mini Boot Chestnut"), "UGG");
  assertEquals(detectBrandInText("Womens UGGs size 7"), null);
  // The alias-key path picks up exactly the case detectBrandInText declines.
  assertEquals(canonicalizeBrand("UGGs"), "UGG");
});

// ── the New Balance decoder: the PREFIX is the whole argument ────────────────

Deno.test("US-1740: the NB decoder recovers the brand AND the gender from the prefix", () => {
  // The first decoder in this epic to capture a SECOND field. The prefix encodes
  // the department, which is a required eBay aspect on footwear — so this is real
  // added recovery, not a flourish.
  const hit = runDecoderSpec(NB_DECODER, "M990GL6");
  assert(hit, "M990GL6 decodes");
  assertEquals(hit.styleCode, "M990GL6", "the WHOLE code is the comp key");
  assertEquals(hit.gender, "Men", "the M prefix maps through genderCode");

  const womens = runDecoderSpec(NB_DECODER, "W574");
  assert(womens, "W574 decodes");
  assertEquals(womens.gender, "Women");
});

Deno.test("US-1740: the NB decoder's 'U' matches but does NOT capture a gender", () => {
  // Unisex is not a gender. Writing "U" into the gender field would be worse than
  // leaving it empty — and genderCode only maps M/W, so a captured "U" would pass
  // through RAW. Hence the non-capturing alternative. This rests on runDecoderSpec
  // skipping undefined groups, which is what this asserts.
  const hit = runDecoderSpec(NB_DECODER, "U327");
  assert(hit, "U327 still decodes — the brand must recover");
  assertEquals(hit.styleCode, "U327");
  assertEquals(hit.gender, undefined, "unisex leaves gender UNSET, never 'U'");
});

Deno.test("US-1740: the NB decoder captures into styleCode — brand recovery keys off it", () => {
  // enrichExtractionWithBrandKnowledge finds the recovering hit via
  // `decoderHits.find((h) => h.styleCode)`. A decoder that captured only gender
  // would match and recover NOTHING.
  const hit = runDecoderSpec(NB_DECODER, "W574");
  assert(hit?.styleCode, "a hit MUST carry a styleCode or recovery is dead");
});

Deno.test("US-1740: the NB decoder REFUSES a bare model number — three digits is not a brand", () => {
  // THE line that makes the decoder defensible. "990" is the number every buyer
  // says out loud and it is still just three digits: a price, a year, a lot number.
  for (const bare of ["990", "574", "550", "2002"]) {
    assertEquals(
      runDecoderSpec(NB_DECODER, bare),
      null,
      `"${bare}" must NOT decode — only the PREFIX makes it brand-unique`,
    );
  }
});

Deno.test("US-1740: the NB decoder refuses Dr. Martens' article numbers", () => {
  // The pack's hardest refusal, from the other side: 1460/1461/2976 are the most
  // famous numbers in footwear, printed and regular — and four digits with no
  // prefix is not a brand. Deliberately no DM decoder exists; this pins that even
  // New Balance's pattern cannot be stretched over them.
  for (const article of ["1460", "1461", "2976"]) {
    assertEquals(runDecoderSpec(NB_DECODER, article), null);
  }
});

Deno.test("US-1740: the NB decoder ignores non-code style values", () => {
  for (const notACode of ["Slim Fit", "Made in USA", "Chestnut", ""]) {
    assertEquals(runDecoderSpec(NB_DECODER, notACode), null);
  }
});

// ── resolveStyleCode: an explicit brand beats a FORMAT guess (the live bug) ──

Deno.test("US-1740: a Converse M-code is NOT relisted as a New Balance", () => {
  // A REAL, live, pre-existing bug, found while wiring the NB decoder rather than
  // reasoned about. brandFromStyleFormat reads "New Balance" out of any M+4-digit
  // code — and CONVERSE's classic style codes are ALSO M + 4 digits. Since
  // ai-listing.ts takes `styleResolution?.brand ?? canonicalBrand`, the format
  // GUESS was overriding the brand read off the actual tag: a Converse Chuck with a
  // legible M-code was silently relisted as a New Balance, taking the eBay Brand
  // aspect and the comp filter with it.
  assertEquals(
    resolveStyleCode("M9160", "Converse")?.brand,
    "Converse",
    "the tag's own brand outranks a guess made from the code's SHAPE",
  );
  // The aspects must follow the resolved brand, not the format's guess — the Brand
  // aspect is the comp filter, so a wrong one prices off the wrong product.
  assertEquals(resolveStyleCode("M9160", "Converse")?.aspects["Brand"], [
    "Converse",
  ]);
});

Deno.test("US-1740: with no brand to go on, the NB format inference still stands", () => {
  // The fix is precedence, not the removal of the inference: with nothing better to
  // go on, the format is still the best available evidence.
  assertEquals(resolveStyleCode("M990GL6")?.brand, "New Balance");
  assertEquals(resolveStyleCode("M990GL6")?.exact, false, "still a guess");
  // An AGREEING hint changes nothing.
  assertEquals(resolveStyleCode("M990GL6", "New Balance")?.brand, "New Balance");
});

Deno.test("US-1740: an APPAREL brandHint does not suppress a sneaker code", () => {
  // The bound on the fix. Only a known SNEAKER brand may outrank the format — a
  // Nike code on an item mis-tagged "Hanes" should still resolve to Nike, because
  // there the format really is the better evidence.
  assertEquals(resolveStyleCode("CW2288-111", "Hanes")?.brand, "Nike");
  assertEquals(resolveStyleCode("GZ5230", "Gap")?.brand, "adidas");
});

Deno.test("US-1740: the CURATED table still outranks an explicit brand", () => {
  // An exact code→product match is stronger evidence than either the tag or the
  // format, so the precedence ladder is: curated > tag > format.
  const r = resolveStyleCode("CW2288-111", "Converse");
  assertEquals(r?.brand, "Nike");
  assertEquals(r?.exact, true);
});

// ── which channel actually carries which fact ───────────────────────────────
//
// FOUND WHILE WIRING THIS PACK, and it decides where every fact above had to be
// put. The three renderers do NOT carry the same content, and the difference is
// easy to get wrong because all three are fed the same pack:
//
//   brandPackPromptBlock   — renders styles (visualFingerprint VERBATIM),
//                            decoders and colorways. The authentication tells
//                            collapse to ONE GENERIC LINE: the prose never
//                            reaches the extract prompt at all.
//   buildTrustedBrandFactsBlock — renders the tells (tell — detail), but only the
//                            FIRST FOUR, and the whole block is hard-capped at 900
//                            chars. It grounds the grading baseline, not extract.
//   formatSizingChartsForPrompt — renders the size LABELS and the note IN FULL,
//                            uncapped. This is the channel this pack lives on.
//
// So a fact that must reach the identification prompt belongs in a style's
// visualFingerprint or a chart note — NOT in a tell. That is why this group's
// load-bearing content (the UK/EU cross-maps, the offsets, the width flip) is
// written into the size labels and chart notes, and why the tests below assert it
// there rather than in the tells.

Deno.test("US-1740: authentication tell PROSE does not reach the extract prompt", () => {
  // Pinning the surprise rather than assuming it. brandPackPromptBlock reduces
  // every tell to a generic "has known tells" line — so a fact seeded ONLY as a
  // tell is invisible to identification. Anyone extending this pack needs to know.
  const block = brandPackPromptBlock(
    pack("Dr. Martens", "drmartens", [
      style("1460 (8-eye boot)", "1460", "The 8-eyelet ankle boot.", ["AirWair"]),
    ], [], [{
      tell: "THE SIZE ON THE TAG IS A UK SIZE",
      detail: "A boot stamped '7' is a UK 7 = US MEN'S 8.",
    }]),
  );
  assert(
    /NEVER assert authenticity/.test(block),
    "the tells render as ONE generic line...",
  );
  assert(
    !/US MEN'S 8/.test(block),
    "...and the tell's own prose does NOT reach the extract prompt",
  );
});

Deno.test("US-1740: the tells DO reach the grading baseline via the facts block", () => {
  // The other renderer, and the tells' real consumer. Note the 900-char cap and
  // the first-four slice: the ordering of a row's tells is load-bearing, which is
  // why every row in 00459 leads with NEVER-auto-authenticate and puts THE call
  // for that brand second.
  const facts = buildTrustedBrandFactsBlock(
    pack("Dr. Martens", "drmartens", [], [], [
      { tell: "NEVER auto-authenticate", detail: "Flag inconsistencies only." },
      {
        tell: "THE SIZE ON THE TAG IS A UK SIZE — AND THE TAG DOES NOT SAY SO",
        detail: "A boot stamped '7' is a UK 7 = US MEN'S 8 = US WOMEN'S 9.",
      },
    ]),
  );
  assert(/UK SIZE — AND THE TAG DOES NOT SAY SO/.test(facts));
  assert(/US MEN'S 8/.test(facts), "the tell's detail reaches the baseline");
  assert(facts.length <= 900, "the facts block is hard-capped at 900 chars");
});

// ── the prompt block: styles are what actually render ───────────────────────

Deno.test("US-1740: the Dr. Martens block refuses to date an unchanged silhouette", () => {
  // The 1460 has been in production essentially unchanged since 1960, so a 2024
  // pair and a 1994 pair look alike. This has to be in the FINGERPRINT to reach
  // the model — it is exactly the kind of fact a tell would have swallowed.
  const block = brandPackPromptBlock(
    pack("Dr. Martens", "drmartens", [
      style(
        "1460 (8-eye boot)",
        "1460",
        "THE Dr. Martens — the 8-eyelet ankle boot, in continuous production since 1 April 1960. CRITICAL: the silhouette has barely changed in 65 years, so a photo CANNOT date the boot — only the heel loop, the footbed stamp and the construction can. The article number identifies THIS PIECE and must never be read as the brand.",
        ["AirWair"],
      ),
    ]),
  );
  assert(
    /a photo CANNOT date the boot/.test(block),
    "the block refuses to date an unchanged silhouette",
  );
  assert(
    /must never be read as the brand/.test(block),
    "the block keeps the article number a PIECE identifier",
  );
  assert(/\[fabric: AirWair\]/.test(block), "the coined mark reaches the block");
});

Deno.test("US-1740: the Birkenstock block makes the footbed impression WEAR, not damage", () => {
  // The grading call with no equivalent in the apparel groups: the cork footbed
  // moulds to its wearer BY DESIGN, so the impression is the product working. It
  // rides the fingerprint (and the chart note), because a tell would not render.
  const block = brandPackPromptBlock(
    pack("Birkenstock", "birkenstock", [
      style(
        "Boston",
        "Boston",
        "A CLOSED-TOE clog with a single buckled strap over the instep and an open back — clearly distinct from the open-toe Arizona in any photo. The cork-latex footbed MOULDS to its wearer by design, so a visible FOOT IMPRESSION is NORMAL and expected, not damage — but cork CRUMBLING at the exposed edge and a SEPARATED sole ARE defects.",
        ["cork-latex footbed"],
      ),
    ]),
  );
  assert(
    /FOOT IMPRESSION is NORMAL and expected, not damage/.test(block),
    "the block refuses to grade the design as a defect",
  );
  assert(
    /cork CRUMBLING at the exposed edge/.test(block),
    "the block still names the real defects — the DISTINCTION is the point",
  );
});

Deno.test("US-1740: the Converse block separates Chuck 70 from a standard Chuck (both ship NOW)", () => {
  // Both in production, near-identical, materially different bands. The separators
  // must reach the model or it prices the wrong shoe.
  const block = brandPackPromptBlock(
    pack("Converse", "converse", [
      style(
        "Chuck 70",
        "Chuck 70",
        "The premium reissue of the 1970s All Star spec, at a materially higher band than the standard Chuck — and NOT an era: both are in production side by side today. The separators are details and ARE legible when photographed: HEAVIER canvas, a GLOSSY off-white (egret) midsole, the VINTAGE star-chevron heel patch, and a BLACK license-plate tag at the heel.",
        ["heavier canvas"],
      ),
    ]),
  );
  assert(
    /both are in production side by side today/.test(block),
    "the block says the photo cannot date it — both ship now",
  );
  assert(
    /GLOSSY off-white \(egret\) midsole/.test(block),
    "the actual separator reaches the block",
  );
});

Deno.test("US-1740: the Cole Haan block reads a Nike mark as a DATE, not a fake", () => {
  // The brand's most misread tell, and it looks exactly like a counterfeiter's
  // mistake: a Nike mark inside a dress shoe. Nike owned the brand 1988-2012, so
  // it is period-correct. Carried on the fingerprint so it actually renders.
  const block = brandPackPromptBlock(
    pack("Cole Haan", "colehaan", [
      style(
        "Original Grand",
        "Original Grand",
        "The wingtip oxford on the lightweight Grand.OS sole. Cemented, so sole wear is not economically repairable. Pairs from the Nike era (pre-2012) may carry a genuine NIKE AIR or LUNARLON sole mark: that is period-correct and dates the shoe, and is NOT a fake or a replaced sole.",
        ["Grand.OS", "Nike Air (pre-2012)"],
      ),
    ]),
  );
  assert(
    /period-correct and dates the shoe, and is NOT a fake or a replaced sole/
      .test(block),
    "the block refuses the false-counterfeit reading of a genuine Nike mark",
  );
});

Deno.test("US-1740: the decoder line tells the model to transcribe the code VERBATIM", () => {
  // The decoder's own channel. A decoder is worthless if the model paraphrases the
  // tongue label — the pattern is anchored, so "M990 (grey)" would not match.
  const block = brandPackPromptBlock(
    pack("New Balance", "newbalance", [
      style(
        "990 series",
        "990",
        "The brand's flagship runner. The NUMBER is on the shoe, but the VERSION (v1-v6) and the ORIGIN are not reliably readable from it: check the tongue label and the box.",
        ["ENCAP"],
      ),
    ], [{
      decoderKind: "style_number",
      description:
        'Tongue-label / box model number. The PREFIX LETTER is what makes the token brand-unique (a bare "990" is nothing; "M990" can only be New Balance) and it also encodes the department.',
      pattern: NB_DECODER.pattern,
      extractionRules: {},
      examples: [],
    }]),
  );
  assert(
    /transcribe it VERBATIM into style_code/.test(block),
    "the block asks for a verbatim code — the pattern is anchored",
  );
  assert(
    /"M990" can only be New Balance/.test(block),
    "the decoder's description carries the PREFIX argument to the model",
  );
  assert(
    /not reliably readable from it/.test(block),
    "the fingerprint refuses to read the version off the numeral",
  );
});

Deno.test("US-1740: a colourway pack renders the named palette", () => {
  // The first colourways in four groups. Footwear ships stable named palettes that
  // buyers search BY NAME; apparel ships seasonal English words.
  const block = brandPackPromptBlock(
    pack("UGG", "ugg", [style("Classic Tall", "Classic", "The tall sheepskin pull-on boot.")], [], [], [
      { colorName: "Chestnut", aliases: ["chestnut"], hex: "#9F6B4A", years: "ongoing" },
      { colorName: "Chocolate", aliases: ["chocolate"], hex: "#5A3A28", years: "ongoing" },
    ]),
  );
  assert(/Chestnut/.test(block), "the named colourway reaches the block");
  assert(/Chocolate/.test(block), "...and its siblings");
});

// ── sizing charts: the TRANSLATOR, not the estimator ────────────────────────

Deno.test("US-1740: every footwear brand's charts are reachable by brand text", () => {
  for (const [canonical] of GROUP) {
    const charts = findSizingCharts(canonical, "shoes");
    assert(
      charts.length > 0,
      `${canonical} must reach a footwear chart from its brand field`,
    );
  }
});

Deno.test("US-1740: the plural brand text still reaches the charts (leading boundary)", () => {
  // The other half of the plural asymmetry: brandTextMatches is LEADING-boundary
  // only, so a trailing "s" is fine here — which is exactly why "UGGs" reaches
  // these charts while detectBrandInText declines it.
  assert(findSizingCharts("UGGs", "boots").length > 0);
  assert(findSizingCharts("Birkenstocks", "sandals").length > 0);
});

Deno.test("US-1740: THE Dr. Martens chart carries the UK cross-map IN THE SIZE LABEL", () => {
  // The US-1731 lesson and this pack's entire deliverable: the cross-map must be
  // where the model reads it — inside the label — not in a note alone.
  const charts = findSizingCharts("Dr. Martens", "boots");
  assertEquals(charts.length, 1);
  const chart = charts[0];
  assertEquals(chart.department, "Unisex", "one UK run serves both departments");

  const uk7 = chart.rows.find((r) => r.size.startsWith("UK 7"));
  assert(uk7, "the UK 7 row exists");
  assert(
    /US M8/.test(uk7.size) && /US W9/.test(uk7.size),
    "the UK 7 label carries BOTH US equivalents: got " + uk7.size,
  );
  assert(/EU 41/.test(uk7.size), "...and the EU equivalent");

  // Every row must translate, or the chart is not doing its job.
  for (const row of chart.rows) {
    assert(/^UK \d/.test(row.size), `row leads with the UK size: ${row.size}`);
    assert(/US M\d/.test(row.size), `row carries a US men's size: ${row.size}`);
    assert(/EU \d/.test(row.size), `row carries an EU size: ${row.size}`);
  }
});

Deno.test("US-1740: the Birkenstock chart is EU-led and its US equivalents are RANGES", () => {
  // The ranges are not sloppiness — they are the data. Birkenstock has NO half
  // sizes, so the brand's grade is coarser than the US one and one EU size
  // genuinely covers two US halves. A single US number would be a false precision.
  const charts = findSizingCharts("Birkenstock", "sandals");
  assertEquals(charts.length, 1);
  const chart = charts[0];

  const eu38 = chart.rows.find((r) => r.size.startsWith("EU 38"));
  assert(eu38, "the EU 38 row exists");
  assert(
    /US W7-7\.5/.test(eu38.size),
    "EU 38 maps to a RANGE of US women's sizes: got " + eu38.size,
  );

  for (const row of chart.rows) {
    assert(/^EU \d/.test(row.size), `row leads with the EU size: ${row.size}`);
  }
  assert(
    /NO HALF SIZES/.test(chart.note ?? ""),
    "the note explains WHY the equivalents are ranges",
  );
});

Deno.test("US-1740: Converse and Vans carry DIFFERENT dual-tag offsets", () => {
  // THE quiet trap: same shoe, same shelf, same band, different offsets — and no
  // photo can catch it. Both are asserted from the shipped rows rather than trusted.
  const converse = findSizingCharts("Converse", "sneakers")[0];
  const vans = findSizingCharts("Vans", "sneakers")[0];
  assert(converse && vans);

  const cM8 = converse.rows.find((r) => r.size.startsWith("US M8 "));
  assert(cM8, "Converse M8 row exists");
  assert(
    /US W10\b/.test(cM8.size),
    "CONVERSE offset is TWO — M8 = W10: got " + cM8.size,
  );

  const vM8 = vans.rows.find((r) => r.size.startsWith("US M8 "));
  assert(vM8, "Vans M8 row exists");
  assert(
    /US W9\.5/.test(vM8.size),
    "VANS offset is ONE AND A HALF — M8 = W9.5: got " + vM8.size,
  );

  // The two must not have been copied from one another — that is the actual bug
  // this case exists to catch.
  assert(
    cM8.size !== vM8.size,
    "the two brands' M8 rows must differ — a shared offset means one was copied",
  );
});

Deno.test("US-1740: each of Converse/Vans warns about THE OTHER by name", () => {
  // A note that only states its own offset does not prevent the error; the error is
  // carrying the neighbour's offset across. Each note must name the other brand.
  const converse = findSizingCharts("Converse", "sneakers")[0];
  const vans = findSizingCharts("Vans", "sneakers")[0];
  assert(/VANS IS NOT THE SAME/.test(converse.note ?? ""));
  assert(/W9\.5/.test(converse.note ?? ""), "Converse's note quotes Vans' offset");
  assert(/CONVERSE IS NOT THE SAME/.test(vans.note ?? ""));
  assert(/W10/.test(vans.note ?? ""), "Vans' note quotes Converse's offset");
});

Deno.test("US-1740: the New Balance width letter FLIPS between the two charts", () => {
  // The same character, correct in both readings, and only the department decides.
  // Both charts must state their own reading AND the contradicting one.
  const mens = findSizingCharts("New Balance", "sneakers").find(
    (c) => c.department === "Men",
  );
  const womens = findSizingCharts("New Balance", "sneakers").find(
    (c) => c.department === "Women",
  );
  assert(mens && womens);

  assert(
    /"D" IS THE STANDARD WIDTH/.test(mens.note ?? ""),
    "men's: D is standard",
  );
  assert(
    /OPPOSITE OF THE WOMEN'S READING/.test(mens.note ?? ""),
    "men's note names the contradiction",
  );
  assert(
    /"D" IS WIDE/.test(womens.note ?? ""),
    "women's: D is WIDE",
  );
  assert(
    /OPPOSITE OF THE MEN'S READING/.test(womens.note ?? ""),
    "women's note names the contradiction",
  );
});

Deno.test("US-1740: every footwear chart says the size is STAMPED, not measured", () => {
  // The cross-cutting fact that separates this pack from every garment chart in the
  // file. A chart that omits it invites the model to estimate a shoe size from a
  // photo, which cannot be done.
  const FOOTWEAR_BRANDS = [
    "Dr. Martens",
    "Birkenstock",
    "New Balance",
    "Converse",
    "Vans",
    "UGG",
    "Cole Haan",
  ];
  const charts = SIZING_CHARTS.filter((c) =>
    FOOTWEAR_BRANDS.includes(c.brand) && /Footwear/.test(c.garment)
  );
  assertEquals(charts.length, 10, "all ten footwear charts are present");
  for (const c of charts) {
    assert(
      /STAMPED, NOT MEASURED/.test(c.note ?? ""),
      `${c.brand} / ${c.department} must say the size is stamped`,
    );
    // And every row must ground a foot length — the sanity check for a shoe in hand.
    for (const row of c.rows) {
      assert(
        row.measurements.footLength,
        `${c.brand} ${row.size} needs a footLength`,
      );
    }
  }
});

Deno.test("US-1740: the UGG chart calls the packed-down sheepskin WEAR, not a defect", () => {
  // Two effects compound (runs large + the lining compresses) and BOTH are the
  // material behaving as designed. A worn pair that fits large is not "stretched
  // out" and must not be graded as damage.
  const chart = findSizingCharts("UGG", "boots").find(
    (c) => c.department === "Women",
  );
  assert(chart);
  assert(/RUNS LARGE/.test(chart.note ?? ""));
  assert(/PACKS DOWN/.test(chart.note ?? ""));
  assert(
    /NOT a defect of manufacture/.test(chart.note ?? ""),
    "the note refuses to grade the design as damage",
  );
  assert(
    /never silently adjust the stamped number/.test(chart.note ?? ""),
    "the note reports the stamp AND the guidance rather than doing the maths",
  );
});

Deno.test("US-1740: the Cole Haan chart makes CONSTRUCTION the value and demands a sole photo", () => {
  // The dress-shoe fact with no apparel equivalent: welted resoles, cemented does
  // not — and the upper does not show which. The tell needs a photo nobody takes.
  const chart = findSizingCharts("Cole Haan", "loafer").find(
    (c) => c.department === "Men",
  );
  assert(chart);
  assert(/GOODYEAR-WELTED/.test(chart.note ?? ""));
  assert(/CEMENTED/.test(chart.note ?? ""));
  assert(
    /SOLE-EDGE\s+photo/.test(chart.note ?? ""),
    "the note demands the photo the tell actually needs",
  );
  assert(
    /UNCONFIRMED/.test(chart.note ?? ""),
    "...and refuses to assume when it is absent",
  );
});

Deno.test("US-1740: the footwear categoryMatch narrows within a brand's own charts", () => {
  // The categoryMatch bound, asserted where it actually bites. NOTE the designed
  // fallback: findSizingCharts returns the WHOLE brand pool when the category
  // narrows to nothing, so a "Dr. Martens tee" still gets the boot chart — that is
  // deliberate ("the model still gets a reference table to reason from") and is
  // harmless for these brands, which sell no apparel we chart. Do not assert the
  // opposite; the real bound is that a footwear query reaches footwear charts and
  // does NOT drag in another brand's.
  const vans = findSizingCharts("Vans", "sneakers");
  assert(vans.length > 0 && vans.every((c) => /Footwear/.test(c.garment)));
  assert(vans.every((c) => c.brand === "Vans"), "no other brand's charts leak in");

  // Cole Haan charts both departments; a loafer query must reach both, not one.
  const ch = findSizingCharts("Cole Haan", "loafer");
  assertEquals(ch.length, 2, "men's + women's");
  assert(ch.every((c) => c.brand === "Cole Haan"));
});

Deno.test("US-1740: THE cross-map survives into the rendered vision prompt", () => {
  // The end-to-end assertion this whole pack exists for, and the one that would
  // actually catch a regression: it is not enough for the UK map to be in the data
  // — it has to come out the other side of the renderer the vision pass reads.
  // formatSizingChartsForPrompt emits the size LABELS and the note in full.
  const rendered = formatSizingChartsForPrompt(
    findSizingCharts("Dr. Martens", "boots"),
  );
  assert(/UK 7 = US M8 \/ US W9 = EU 41/.test(rendered), "the cross-map renders");
  assert(
    /THE NUMBER STAMPED ON A DR\. MARTENS IS A UK SIZE/.test(rendered),
    "and so does the warning that explains it",
  );

  // Same for the Birkenstock EU map — the other unnamed system.
  const birk = formatSizingChartsForPrompt(
    findSizingCharts("Birkenstock", "sandals"),
  );
  assert(/EU 38 = US W7-7\.5/.test(birk));
  assert(/EU-SIZED ONLY/.test(birk));
});

Deno.test("US-1740: 'ugg' does not steal another brand's charts", () => {
  // A 3-letter brandMatch is exactly the AG/"patAGonia" hazard from US-1738. The
  // leading-boundary matcher is what contains it; this pins that it holds.
  for (const other of ["Lululemon", "Patagonia", "The North Face", "Gap"]) {
    const charts = findSizingCharts(other, "shoes");
    assert(
      !charts.some((c) => c.brand === "UGG"),
      `"${other}" must not reach UGG's charts`,
    );
  }
});
