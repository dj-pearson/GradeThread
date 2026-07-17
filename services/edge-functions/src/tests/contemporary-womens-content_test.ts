// US-1738: verify the contemporary women's content (migration 00457) is correct
// + consumable by the engine.
//
// What these assertions are really protecting:
//
//   * THE TAG DOES NOT SAY THE BRAND. This group inverts the epic: Anthropologie
//     and Aritzia are RETAILERS whose house labels print their OWN names, so the
//     tag reads MAEVE or WILFRED and the brand is nowhere on the garment. The
//     piece is easy; the BRAND is the puzzle.
//   * THE HOUSE LABELS FOLD onto one canonical (the Michael Kors play) because
//     they share a price band — the opposite call from Fear of God / Essentials
//     (00456), which are 10x apart and earned two brands. The reason has to
//     survive.
//   * ANTHROPOLOGIE ALSO SELLS OTHER BRANDS, so "bought there" != "branded that".
//   * VINCE IS NOT VINCE CAMUTO — two different COMPANIES sharing a first name.
//     This is 00456's substring trap across two businesses, and it is why Vince
//     is deliberately absent from the in-code SIZING_CHARTS.
//   * THREE SIZING DIRECTIONS off ordinary-looking labels: Sézane FR 38 = US 6,
//     Aritzia runs small, Eileen Fisher runs large.
//   * NO DECODERS, for a NEW reason: the identifier is a bare ordinary GIVEN NAME.
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
const { findSizingCharts, SIZING_CHARTS } = await import("../lib/sizing-charts.ts");
const { canonicalizeBrand, isKnownBrand, brandKey, detectBrandInText } =
  await import("../lib/brand-normalize.ts");
import type {
  BrandKnowledgePack,
  BrandStyleKnowledge,
} from "../lib/brand-knowledge.ts";

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
    department: "Women",
    category: "label",
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
): BrandKnowledgePack {
  return {
    brand,
    key,
    known: true,
    aliases: [],
    categoryFocus: ["contemporary womens"],
    authenticationTells,
    tagEras: [],
    styles,
    decoders,
    colorways: [],
    sizingCharts: [],
    source: "db",
  };
}

// The seven brands of this group, with the keys migration 00457 seeds. Note
// 'szane' — brandKey() strips Sézane's accent, exactly as it strips Stüssy's
// umlaut to 'stssy' (00456).
const GROUP: Array<[string, string]> = [
  ["Anthropologie", "anthropologie"],
  ["Sézane", "szane"],
  ["Aritzia", "aritzia"],
  ["Reformation", "reformation"],
  ["Vince", "vince"],
  ["Theory", "theory"],
  ["Eileen Fisher", "eileenfisher"],
];

Deno.test("US-1738: the Aritzia block says the TAG carries the sub-label, not the brand", () => {
  // Packs shaped as the US-1711 resolver returns for the 00457-seeded rows,
  // carrying the seeded fingerprints verbatim. THE group's defining fact: a
  // seller holding a Wilfred coat is holding an Aritzia coat and nothing on the
  // garment says so.
  const block = brandPackPromptBlock(
    pack("Aritzia", "aritzia", [
      style(
        "Wilfred",
        "Sub-label",
        'NOT a garment — Aritzia\'s ELEVATED/romantic sub-label, and one of its highest-volume lines. The neck tag reads WILFRED and does not say "Aritzia". A Wilfred coat IS an Aritzia coat: the brand is ARITZIA and "Wilfred" belongs here in the style ("Aritzia Wilfred" is the search). vs WILFRED FREE: a genuinely separate, more casual line whose tag reads WILFRED FREE — note it CONTAINS "Wilfred", so read the FULL label rather than the first word.',
      ),
    ]),
  );
  assert(/tag reads WILFRED/.test(block), "the block states what the tag actually says");
  assert(
    /A Wilfred coat IS an Aritzia coat/.test(block),
    "the fold-onto-the-parent rule reaches the block",
  );
  assert(
    /read the FULL label rather than the first word/.test(block),
    "the Wilfred / Wilfred Free containment warning survives",
  );
});

Deno.test("US-1738: the Anthropologie block keeps the RETAILER apart from the house brand", () => {
  // The trap the rest of the epic has no equivalent for: Anthropologie SELLS
  // other brands. "Bought at Anthropologie" does not mean "branded Anthropologie".
  const block = brandPackPromptBlock(
    pack("Anthropologie", "anthropologie", [
      style(
        "Third-Party Brand at Anthropologie",
        "Retailer",
        "NOT a garment and NOT a line — the RETAILER TRAP. Anthropologie is a MULTI-BRAND RETAILER as well as a house-brand family: it stocks many third-party labels. A garment BOUGHT at Anthropologie is only an Anthropologie garment if it carries a HOUSE label (Maeve, Pilcro, Moth, Daily Practice, Hei Hei). If the tag names some other brand, THAT is the brand — the store is not.",
      ),
    ]),
  );
  assert(/MULTI-BRAND RETAILER/.test(block), "the retailer fact reaches the block");
  assert(
    /If the tag names some other brand, THAT is the brand/.test(block),
    "the block says the store is not the brand",
  );
});

Deno.test("US-1738: the Anthropologie block reads 'Moth' as damage before it reads it as a brand", () => {
  // The nastiest token in the pack. "Moth holes" / "moth damage" appear
  // constantly in the condition text this very product generates, so the knit
  // label must never be the default reading.
  const block = brandPackPromptBlock(
    pack("Anthropologie", "anthropologie", [
      style(
        "Moth",
        "House label",
        'NOT a garment — Anthropologie\'s house KNITWEAR label. CRITICAL READING ORDER: "moth" is a garment-DAMAGE term ("moth holes", "moth damage") far more often than it is this label, and that damage language appears constantly in condition text. A bare "moth" token is almost certainly DAMAGE. Only an actual MOTH neck label is the knit line.',
      ),
    ]),
  );
  assert(/garment-DAMAGE term/.test(block), "the damage-word warning reaches the block");
  assert(
    /A bare "moth" token is almost certainly DAMAGE/.test(block),
    "the block states the default reading is damage, not the brand",
  );
});

Deno.test("US-1738: the Vince block says Vince Camuto is a DIFFERENT COMPANY", () => {
  // The group's signature trap and this brand's costliest error. Structurally the
  // Fear of God / Essentials shape (00456), but worse: there the two labels were
  // at least one designer's work.
  const block = brandPackPromptBlock(
    pack("Vince", "vince", [
      style(
        "Vince Camuto is a Different Company",
        "Cross-brand",
        'NOT a garment and NOT a Vince line — the trap. VINCE CAMUTO (Camuto Group) is a SEPARATE COMPANY that merely shares a first name with Vince (Vince Holding Corp). It is not a diffusion line, not a sub-label and not a fake: it is an unrelated business at a different price point. A "Vince Camuto" tag must never be folded into Vince.',
      ),
    ]),
  );
  assert(/SEPARATE COMPANY/.test(block), "the different-company fact reaches the block");
  assert(
    /not a diffusion line, not a sub-label and not a fake/.test(block),
    "the block rules out every benign reading of the shared name",
  );
  assert(
    /must never be folded into Vince/.test(block),
    "the block forbids the fold",
  );
});

Deno.test("US-1738: the Theory block folds Theyskens' Theory but NOT Vince Camuto's shape", () => {
  // The pair that makes the rule legible: two identical-looking containing-name
  // cases that resolve OPPOSITE ways, because the corporate fact decides — not
  // the string.
  const block = brandPackPromptBlock(
    pack("Theory", "theory", [
      style(
        "Theyskens' Theory",
        "Designer line",
        "NOT a garment — the retired DESIGNER LINE under Olivier Theyskens (~2011-2014). It IS a Theory line — a line of this same brand, like Baby Milo is a BAPE line — so it folds into Theory with the line here in the style. Contrast Vince Camuto in this same pack: same containing-name shape, opposite answer, because that is a different company.",
      ),
    ]),
  );
  assert(/IS a Theory line/.test(block), "Theyskens' Theory is identified as a Theory line");
  assert(
    /same containing-name shape, opposite answer/.test(block),
    "the block contrasts the folding case with the non-folding one",
  );
});

Deno.test("US-1738: the Eileen Fisher block calls the RELAXED drape the design, not a defect", () => {
  // GRADING-relevant, and the same rule as the Essentials drape (00456) on a
  // brand nobody expects it from.
  const block = brandPackPromptBlock(
    pack("Eileen Fisher", "eileenfisher", [
      style(
        "Relaxed Silhouette",
        "House cut",
        'NOT a garment — the HOUSE CUT. Eileen Fisher is cut deliberately loose and boxy across the whole line: dropped shoulders, straight bodies, generous ease. An Eileen Fisher M drapes like a US L. THAT IS THE DESIGN — a garment hanging away from the body is INTACT and correctly labeled. Do not grade the drape as stretching, do not read it as wear, do not call it "runs large" as though it were an error.',
      ),
    ]),
  );
  assert(/THAT IS THE DESIGN/.test(block), "the drape-is-the-design fact reaches the block");
  assert(
    /Do not grade the drape as stretching/.test(block),
    "the block blocks grading the drape as wear",
  );
  assert(/INTACT and correctly labeled/.test(block), "the block states the garment is intact");
});

Deno.test("US-1738: the Eileen Fisher block reads a RENEW tag as provenance, not a defect", () => {
  // Unique in this KB: the brand resells its own pieces, so a tag that would look
  // alarming anywhere else is a positive here.
  const block = brandPackPromptBlock(
    pack("Eileen Fisher", "eileenfisher", [
      style(
        "Eileen Fisher Renew",
        "Renew",
        "NOT a garment — EILEEN FISHER RENEW is the brand's OWN take-back and resale program: a RENEW tag means this garment was previously owned and was resold BY THE BRAND ITSELF. It is a PROVENANCE marker and is emphatically NOT a defect, NOT a factory second and NOT a counterfeit signal.",
      ),
    ]),
  );
  assert(/take-back and resale program/.test(block), "the Renew program reaches the block");
  assert(
    /NOT a defect, NOT a factory second and NOT a counterfeit signal/.test(block),
    "the block rules out every negative reading of a Renew tag",
  );
});

Deno.test("US-1738: the Reformation block makes the NAME the identity and refuses to decode it", () => {
  // The purest statement of why this group seeds no decoder.
  const block = brandPackPromptBlock(
    pack("Reformation", "reformation", [
      style(
        "Named Dress",
        "Naming convention",
        "NOT a garment — the NAMING CONVENTION. Every Reformation dress carries an ordinary woman's GIVEN NAME (Juliette, Kourtney, Wren and many more), and that name is the single most valuable listing token on the brand: buyers search the name, not the silhouette. It is also exactly why no decoder is seeded — a bare given name is not brand-unique. Use a name the seller supplies; NEVER infer one from the photos.",
      ),
    ]),
  );
  assert(/GIVEN NAME/.test(block), "the naming convention reaches the block");
  assert(
    /NEVER infer one from the photos/.test(block),
    "the block forbids inferring the style name",
  );
  assert(
    /a bare given name is not brand-unique/.test(block),
    "the block states WHY there is no decoder",
  );
});

Deno.test("US-1738: every brand in the group refuses to assert authenticity", () => {
  // The epic's hard line. It does not depend on the counterfeit rate.
  for (const [brand, key] of GROUP) {
    const block = brandPackPromptBlock(
      pack(brand, key, [], [], [
        {
          tell: "NEVER auto-authenticate",
          detail:
            `NEVER label a ${brand} item authentic; flag inconsistencies in condition notes only.`,
        },
      ]),
    );
    assert(
      /NEVER assert authenticity/.test(block),
      `${brand} block carries the never-assert-authenticity instruction`,
    );
  }
});

Deno.test("US-1738: NO brand in this group invites a code transcription", () => {
  // The group's stance, asserted directly. 00457 seeds no decoders — but for a
  // DIFFERENT reason than 00456's. There the identifier was a GRAPHIC (not on the
  // tag, not parseable). Here the identifier IS printed and IS regular: these
  // brands NAME their pieces. It fails the third test — brand-unique — because
  // every name is an ordinary GIVEN NAME (Juliette, Maeve, Wilfred, Gaspard).
  // 00454 seeded True Religion only because "Ricky Super T" is a COMPOUND; a bare
  // first name has no second part. If a future seed adds a decoder over one of
  // them, this fails.
  for (const [brand, key] of GROUP) {
    const block = brandPackPromptBlock(
      pack(brand, key, [style("X", "X", "a fingerprint")]),
    );
    assert(
      !/transcribe it VERBATIM/i.test(block),
      `${brand} must not invite a code transcription (it has no decodable code)`,
    );
  }
});

Deno.test("US-1738: the new contemporary women's aliases canonicalize (were passthrough-only before)", () => {
  // Without these, canonicalizeBrand PASSED THROUGH the seller's own casing
  // ("aritzia", "eileen fisher") into the prompt block and the eBay Brand aspect.
  // None of the seven had even a bare alias-only row before this story.
  assertEquals(canonicalizeBrand("anthropologie"), "Anthropologie");
  assertEquals(canonicalizeBrand("aritzia"), "Aritzia");
  assertEquals(canonicalizeBrand("reformation"), "Reformation");
  assertEquals(canonicalizeBrand("The Reformation"), "Reformation");
  assertEquals(canonicalizeBrand("vince"), "Vince");
  assertEquals(canonicalizeBrand("theory"), "Theory");
  assertEquals(canonicalizeBrand("eileen fisher"), "Eileen Fisher");
  for (const [brand] of GROUP) {
    assert(isKnownBrand(brand), `${brand} is now a curated entry, not a passthrough`);
  }
});

Deno.test("US-1738: the HOUSE LABELS fold onto their parent brand", () => {
  // The Michael Kors play (00455), not the Fear of God one (00456). These
  // sub-labels share a price band with each other, so folding costs no comp
  // accuracy — and the line lives in `style`, where brand_styles can rank it.
  for (const label of ["maeve", "pilcro", "Daily Practice", "Hei Hei"]) {
    assertEquals(
      canonicalizeBrand(label),
      "Anthropologie",
      `${label} folds onto Anthropologie`,
    );
  }
  for (
    const label of ["wilfred", "Wilfred Free", "babaton", "TNA", "Sunday Best", "Talula"]
  ) {
    assertEquals(canonicalizeBrand(label), "Aritzia", `${label} folds onto Aritzia`);
  }

  // Theyskens' Theory IS a Theory line, so it folds — the OPPOSITE call from
  // Vince Camuto below, on an identical-looking containing-name shape. The
  // corporate fact decides, not the string.
  assertEquals(canonicalizeBrand("Theyskens' Theory"), "Theory");
  assertEquals(canonicalizeBrand("Theory Luxe"), "Theory");
});

Deno.test("US-1738: folding the sub-labels keeps the SHORT tokens out of the brand detector", () => {
  // The second payoff of the MK play, and the reason it is strictly better here
  // than minting a canonical per sub-label. "TNA" is three letters — as a
  // canonical it would be an AG-grade hazard in detectBrandInText (00454). As an
  // alias resolving to "Aritzia" it never enters CANONICAL_BRANDS at all.
  assertEquals(canonicalizeBrand("TNA"), "Aritzia");
  assertEquals(
    detectBrandInText("Vintage TNA-branded athletic pullover"),
    null,
    "a stray TNA token in free text does not mint a brand",
  );
  // And no sub-label became its own canonical.
  for (const label of ["Wilfred", "Babaton", "TNA", "Maeve", "Pilcro"]) {
    assert(
      detectBrandInText(`A ${label} piece`) !== label,
      `${label} is not a canonical brand of its own`,
    );
  }
});

Deno.test("US-1738: VINCE CAMUTO is never folded into Vince", () => {
  // THE trap. Two DIFFERENT COMPANIES sharing a first name — not a mainline and a
  // diffusion line, which is what makes this worse than 00456's Fear of God pair.
  assertEquals(
    canonicalizeBrand("Vince Camuto"),
    "Vince Camuto",
    "Vince Camuto keeps its own canonical",
  );
  assertEquals(canonicalizeBrand("vince"), "Vince");

  // It is listed rather than left a passthrough for a PROTECTIVE reason:
  // CANONICAL_BRANDS is sorted longest-first, so "Vince Camuto" is tested BEFORE
  // the "Vince" it contains. Without the entry, this title would resolve to Vince.
  assertEquals(
    detectBrandInText("Vince Camuto Womens Wrap Dress Size 6"),
    "Vince Camuto",
    "a Vince Camuto title does not mis-detect as Vince",
  );
  assertEquals(
    detectBrandInText("Vince Cashmere Crewneck Sweater Size S"),
    "Vince",
    "a genuine Vince title still detects as Vince",
  );
});

Deno.test("US-1738: an ordinary word must never mint a brand in this group", () => {
  // This pack has the worst ordinary-word density in the epic, because the words
  // ARE the brand names. Same rule that kept a bare "bean" off L.L.Bean (00453),
  // "tory" off Tory Burch (00455) and "essentials" off Fear of God (00456).
  //
  // "moth" is the one that matters most: it is a garment-DAMAGE term that appears
  // constantly in the condition text this product itself generates, so an alias
  // would brand a garment off a description of its own damage.
  assert(!isKnownBrand("moth"), "a bare 'moth' is not a curated entry");
  assertEquals(canonicalizeBrand("moth"), "moth", "'moth' passes through unchanged");
  assertEquals(
    detectBrandInText("Small moth holes near the left cuff"),
    null,
    "moth damage in condition text does not mint Anthropologie",
  );

  assert(!isKnownBrand("ref"), "a bare 'ref' is not a curated entry");
  assert(!isKnownBrand("fisher"), "a bare 'fisher' is not a curated entry");
  assert(!isKnownBrand("eileen"), "a bare 'eileen' is not a curated entry");
});

Deno.test("US-1738: Sézane resolves under BOTH spellings, and its key is accent-stripped", () => {
  // brandKey() strips the "é" with every other non-[a-z0-9] char, so the KB row
  // is keyed 'szane' (the Stüssy 'stssy' lesson, 00456). Both alias keys are
  // seeded so the ACCENTED form is a curated entry too — Stüssy above is mapped
  // only under `stussy` and survives solely because its passthrough happens to be
  // correct, which is luck rather than design.
  assertEquals(brandKey("Sézane"), "szane", "brandKey strips the accent");
  assertEquals(brandKey("Sezane"), "sezane", "the plain spelling keys differently");
  assertEquals(canonicalizeBrand("Sézane"), "Sézane");
  assertEquals(canonicalizeBrand("sezane"), "Sézane");
  assert(isKnownBrand("Sézane"), "the accented form is a curated entry");
  assert(isKnownBrand("sezane"), "the plain form is a curated entry");
});

Deno.test("US-1738: the group's charts are reachable per brand", () => {
  const cases: Array<[string, string]> = [
    ["Anthropologie", "dress"],
    ["Anthropologie", "blouse"],
    ["Anthropologie", "jean"],
    ["Sézane", "blouse"],
    ["Sézane", "knit"],
    ["Aritzia", "blouse"],
    ["Aritzia", "puffer"],
    ["Aritzia", "jean"],
    ["Reformation", "dress"],
    ["Theory", "blazer"],
    ["Theory", "trouser"],
    ["Eileen Fisher", "knit"],
    ["Eileen Fisher", "pant"],
  ];
  for (const [brand, category] of cases) {
    const found = findSizingCharts(brand, category);
    assert(
      found.some((c) => c.brand === brand),
      `${brand} chart reachable for "${category}"`,
    );
  }

  // Sézane's canonical carries an ACCENT and norm() only lowercases — it does not
  // strip accents — so the chart needs BOTH spellings in brandMatch. The canonical
  // is what brand-knowledge.ts passes in, so the accented form is the one that
  // MUST be there; the plain form covers raw seller text.
  assert(
    findSizingCharts("Sézane", "blouse").some((c) => c.brand === "Sézane"),
    "the accented canonical resolves Sézane's chart",
  );
  assert(
    findSizingCharts("sezane", "blouse").some((c) => c.brand === "Sézane"),
    "the un-accented seller spelling still resolves Sézane's chart",
  );
});

Deno.test("US-1738: Vince is DELIBERATELY absent from the in-code charts (Vince Camuto is a different company)", () => {
  // The subtle one, and the first time this epic gives a brand a DB chart and
  // withholds the in-code mirror. The two lookups do not match the same way:
  //
  //   DB charts      -> .eq("brand_key", key) — EXACT. brandKey("Vince Camuto") is
  //                     "vincecamuto", so 00457's 'vince' row can never reach it.
  //   in-code charts -> brandMatch by SUBSTRING, and "vince camuto".includes(
  //                     "vince") is TRUE.
  //
  // So an in-code ["vince"] chart would hand an UNRELATED COMPANY's garments
  // Vince's numbers, and no narrowing fixes it — there is no token unique to the
  // shorter name (the 00456 Fear of God finding). Vince falls through to the
  // generics here and gets its real chart from the DB. If someone later
  // "completes" the mirror, this test is what tells them why they can't.
  const vince = findSizingCharts("Vince", "knit");
  assert(vince.length > 0, "Vince still resolves something to reason from");
  assert(
    vince.every((c) => c.brandMatch.length === 0),
    "Vince falls through to the generic charts in the in-code fallback",
  );

  const camuto = findSizingCharts("Vince Camuto", "dress");
  assert(
    camuto.every((c) => c.brandMatch.length === 0),
    "Vince Camuto also falls through to the generics — it must NEVER inherit Vince's chart",
  );
});

Deno.test("US-1738: a house-label or short token must never bleed onto another brand's charts", () => {
  // brandMatch is a SUBSTRING test, so the house labels must be reachable ONLY via
  // the canonical — which is what brand-knowledge.ts passes anyway.
  for (const [brand] of GROUP) {
    if (brand === "Vince") continue; // deliberately chartless in-code; asserted above
    const charts = findSizingCharts(brand, "").filter((c) => c.brandMatch.length > 0);
    assert(charts.length > 0, `${brand} resolves at least one brand chart`);
    assert(
      charts.every((c) => c.brand === brand),
      `${brand} resolves only its own charts`,
    );
  }

  // "tna" is three letters and "moth" is a damage word — neither may sit in any
  // brandMatch, or they would false-fire as substrings of unrelated brand text.
  for (const chart of SIZING_CHARTS) {
    for (const m of chart.brandMatch) {
      assert(m !== "tna", "no chart matches on the bare token 'tna'");
      assert(m !== "moth", "no chart matches on the bare token 'moth'");
      assert(m !== "vince", "no chart matches on the bare token 'vince' (Vince Camuto)");
    }
  }
});

Deno.test("US-1738: a brandMatch token only fires at a WORD BOUNDARY", () => {
  // Found while seeding this group, by the test above: "eileen fisher" CONTAINS
  // "lee" ("ei-LEE-n"), so Lee's DENIM charts fired on every Eileen Fisher
  // garment — waist-and-inseam numbers for a silk tunic. findSizingCharts matched
  // brandMatch with a bare `b.includes(m)`, which makes every short token a
  // hazard, and the brand table is full of 2-4 letter brands.
  //
  // It is NOT fixable in the data: any brandMatch that still matches its own
  // canonical "lee" is necessarily also a substring of "eileen". So the matcher
  // now requires the token to START a word. It is the same class of hazard
  // LEARNINGS records for AG ("patagonia".includes("ag")) — that one was only ever
  // avoided by keeping "ag" out of brandMatch entirely, which is a discipline every
  // future short token has to remember; this rule makes it structural.
  assert(
    findSizingCharts("Eileen Fisher", "pant").every((c) => c.brand !== "Lee"),
    "Lee's denim charts no longer fire on Eileen Fisher",
  );
  assert(
    findSizingCharts("Lee", "jean").some((c) => c.brand === "Lee"),
    "Lee still resolves its OWN charts",
  );

  // THE BOUNDARY IS LEADING-ONLY, and this is the case that proves it must be.
  // A trailing letter is legitimate: English suffixes attach at the END, so the
  // pre-1999 "Burberrys" spelling is "Burberry" + s and must still reach
  // Burberry's charts (US-1736 depends on it — it is why Burberry carries no
  // second brandMatch token). A both-sides boundary silently broke this.
  assert(
    findSizingCharts("Burberrys of London", "trench").some((c) => c.brand === "Burberry"),
    "a Burberrys-spelled brand still resolves Burberry's charts",
  );

  // The boundary is letter-based, not whitespace-based, so multi-word and
  // concatenated tokens both still resolve.
  assert(
    findSizingCharts("Alo Yoga", "legging").some((c) => c.brand === "Alo Yoga"),
    "a multi-word brand still matches its short token",
  );
  assert(
    findSizingCharts("The North Face", "jacket").some((c) => /North Face/.test(c.brand)),
    "a token inside a longer brand phrase still matches at a boundary",
  );
  // And the accented canonicals are unaffected — \p{L} treats ü/é as word chars.
  assert(
    findSizingCharts("Stüssy", "tee").some((c) => c.brand === "Stüssy"),
    "an accented canonical still matches",
  );
});

Deno.test("US-1738: the same ordinary label means OPPOSITE things across this group", () => {
  // THE trap this group exists to defend against, asserted as a real data
  // conflict rather than a comment. An "M" tag means a US 6-8 on Aritzia and a US
  // 10-12 drape on Eileen Fisher — opposite directions, nothing on either tag to
  // warn anyone.
  const aritziaM = findSizingCharts("Aritzia", "blouse")
    .find((c) => c.brand === "Aritzia")!
    .rows.find((r) => r.size.startsWith("M "));
  const efM = findSizingCharts("Eileen Fisher", "knit")
    .find((c) => c.brand === "Eileen Fisher")!
    .rows.find((r) => r.size.startsWith("M "));
  assert(aritziaM && efM, "both brands grade an M");
  assert(aritziaM!.size.includes("US 6-8"), "an Aritzia M is a US 6-8");
  assert(efM!.size.includes("US 10-12"), "an Eileen Fisher M drapes like a US 10-12");
  assert(
    aritziaM!.measurements.bust !== efM!.measurements.bust,
    "the two Ms carry different bust measurements",
  );

  // The cross-map has to survive into the RENDERED table, which means it must be
  // in the size LABEL — a note alone is not enough, because the label is what sits
  // beside the measurements the model is matching against (the 00455 lesson).
  const aritzia = findSizingCharts("Aritzia", "dress").find((c) => c.brand === "Aritzia");
  assert(
    aritzia!.rows.every((r) => /US \d/.test(r.size)),
    "every Aritzia size label carries its US numeric equivalent",
  );
  const ef = findSizingCharts("Eileen Fisher", "knit")
    .find((c) => c.brand === "Eileen Fisher");
  assert(
    ef!.rows.every((r) => /drapes ≈US/.test(r.size)),
    "every Eileen Fisher size label carries its US drape equivalent",
  );
  // And Sézane's bare number is the third direction: FR 38 is a US 6, not a US 38.
  const sezane = findSizingCharts("Sézane", "blouse").find((c) => c.brand === "Sézane");
  assert(
    sezane!.rows.every((r) => /^FR \d+ \(US \d+\)$/.test(r.size)),
    "every Sézane size label names the FR system AND its US equivalent",
  );
  assert(
    sezane!.rows.some((r) => r.size === "FR 38 (US 6)"),
    "the FR 38 = US 6 anchor is present",
  );
});

Deno.test("US-1738: the three sizing directions each warn in their own direction", () => {
  // Mirrors 00454's vintage-vs-premium, 00455's European-vs-American and 00456's
  // Japanese-vs-oversized splits: one blanket "contemporary womens runs X" rule
  // would be wrong for most of the pack.
  const sezane = findSizingCharts("Sézane", "").filter((c) => c.brand === "Sézane");
  assert(sezane.length > 0, "Sézane has charts");
  for (const c of sezane) {
    assert(/FRENCH national sizing/.test(c.note ?? ""), "Sézane names its national system");
    assert(/runs SMALL/.test(c.note ?? ""), "Sézane says it runs small");
  }

  const aritzia = findSizingCharts("Aritzia", "dress").filter((c) => c.brand === "Aritzia");
  assert(aritzia.some((c) => /RUNS SMALL/.test(c.note ?? "")), "Aritzia states it runs small");

  const ef = findSizingCharts("Eileen Fisher", "").filter((c) => c.brand === "Eileen Fisher");
  assert(ef.length > 0, "Eileen Fisher has charts");
  for (const c of ef) {
    assert(
      /DELIBERATELY RELAXED/.test(c.note ?? ""),
      `Eileen Fisher ${c.garment} states the relaxed cut`,
    );
    // The grading half of the fact: the drape must not be read as a defect.
    assert(
      /not a fit error|must NOT be graded as a defect|do not grade it as wear/i.test(
        c.note ?? "",
      ),
      `Eileen Fisher ${c.garment} blocks grading the drape as wear`,
    );
  }

  // The US-sized brands say so, which is what stops the FR arithmetic carrying
  // onto an Anthropologie or Reformation tag.
  for (const brand of ["Anthropologie", "Aritzia", "Reformation", "Theory"]) {
    const charts = findSizingCharts(brand, "").filter((c) => c.brand === brand);
    assert(charts.length > 0, `${brand} has charts`);
    assert(
      charts.some((c) => /no national cross-map applies/i.test(c.note ?? "")),
      `${brand} states that no national cross-map applies`,
    );
  }
});

Deno.test("US-1738: every chart tells the seller to measure, and keeps the label off the fit", () => {
  // The only defensible number on a used garment.
  for (const [brand] of GROUP) {
    if (brand === "Vince") continue; // deliberately chartless in-code
    const charts = findSizingCharts(brand, "").filter((c) => c.brand === brand);
    assert(charts.length > 0, `${brand} has charts`);
    for (const c of charts) {
      assert(
        /Measure the (garment|flat waistband)/i.test(c.note ?? ""),
        `${brand} ${c.garment} note tells the seller to measure`,
      );
    }
  }

  // A real and easy inference error, and the mirror of 00456's season-vs-fit trap:
  // the HOUSE LABEL and the STYLE NAME are the biggest facts on this group, so a
  // model can over-apply them and start adjusting the SIZE by line. It doesn't
  // work that way.
  const reformation = findSizingCharts("Reformation", "dress")
    .find((c) => c.brand === "Reformation");
  assert(
    /The STYLE NAME changes the price, not the fit/.test(reformation!.note ?? ""),
    "the Reformation chart decouples the style name from the fit",
  );
  const theory = findSizingCharts("Theory", "blazer").find((c) => c.brand === "Theory");
  assert(
    /THE FABRIC PLATFORM changes the price, not the fit/.test(theory!.note ?? ""),
    "the Theory chart decouples the fabric platform from the fit",
  );
});

Deno.test("US-1738: the retailer charts say the tag carries the house label", () => {
  // The group's defining fact has to survive into the SIZING surface too, because
  // a seller reading a chart for "Aritzia" is holding a garment that says WILFRED.
  const aritzia = findSizingCharts("Aritzia", "dress").find((c) => c.brand === "Aritzia");
  assert(
    /THE TAG SAYS THE SUB-LABEL/.test(aritzia!.note ?? ""),
    "the Aritzia chart states the tag carries the sub-label",
  );
  const anthro = findSizingCharts("Anthropologie", "dress")
    .find((c) => c.brand === "Anthropologie");
  assert(
    /THE TAG USUALLY SAYS A HOUSE LABEL/.test(anthro!.note ?? ""),
    "the Anthropologie chart states the tag carries the house label",
  );
  // And the retailer caveat: the chart must not be applied to a third-party brand
  // that merely happens to be sold at Anthropologie.
  assert(
    /does NOT apply to a THIRD-PARTY brand/.test(anthro!.note ?? ""),
    "the Anthropologie chart excludes third-party brands sold in the store",
  );
});
