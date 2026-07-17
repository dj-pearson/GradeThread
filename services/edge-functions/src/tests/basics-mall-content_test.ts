// US-1739: verify the basics/mall/fast-fashion content (migration 00458) is
// correct + consumable by the engine.
//
// What these assertions are really protecting:
//
//   * THE TAG SAYS THE BRAND, AND THE BRAND IS NOT THE QUESTION. This group is the
//     exact INVERSE of 00457's: there the piece was easy and the BRAND was the
//     puzzle (a WILFRED tag is an Aritzia coat). Here the tag says GAP on a
//     crewneck tee — both facts are free, and neither is worth money. What decides
//     the price of a staple is the LINE and the ERA, and both are printed on the
//     tag and invisible in the silhouette.
//   * THE OUTLET LINES FOLD BUT MUST BE DISCLOSED. Gap Factory / BR Factory are
//     made FOR the outlet at a lower band — not overstock. They fold (eBay has no
//     separate catalogue brand), so `style` is the ONLY place the distinction can
//     survive into a listing.
//   * THE ERA SPREAD IS ~10x AND IS NOT A SPLIT. 90s flag Tommy, pre-1977 A&F,
//     safari-era BR. 00456 split Fear of God at that magnitude — an ERA earns no
//     split because there is no second brand to key. LINE vs ERA is the rule.
//   * "GAP" IS A CONDITION WORD AND A REAL BRAND. Worse than 00457's "moth", which
//     could be refused outright; "Gap" MUST resolve. It can only be contained.
//   * ONE DECODER, and the first in three groups. Uniqlo's fabric trademarks are
//     COINED words, so they pass brand-unique where "Juliette" and "TNA" failed —
//     which gives this group the cut-tag recovery case the last two could not have.
//   * THE SIZING SPREAD: Uniqlo runs SMALL, Old Navy/AE run LARGE, and every one of
//     those tags says only a letter.
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
const { canonicalizeBrand, isKnownBrand, detectBrandInText } = await import(
  "../lib/brand-normalize.ts"
);
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
    department: "Unisex",
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
    categoryFocus: ["basics"],
    authenticationTells,
    tagEras: [],
    styles,
    decoders,
    colorways: [],
    sizingCharts: [],
    source: "db",
  };
}

// The seven brands of this group, with the keys migration 00458 fills. Unlike
// every prior group, all seven ALREADY had a bare alias-only row from 00389 — so
// 00458 is mostly an UPDATE, and its `on conflict do update` clauses are
// load-bearing rather than defensive.
const GROUP: Array<[string, string]> = [
  ["Uniqlo", "uniqlo"],
  ["Gap", "gap"],
  ["Banana Republic", "bananarepublic"],
  ["Old Navy", "oldnavy"],
  ["American Eagle", "americaneagle"],
  ["Abercrombie & Fitch", "abercrombiefitch"],
  ["Tommy Hilfiger", "tommyhilfiger"],
];

// ── the prompt block ────────────────────────────────────────────────────────

Deno.test("US-1739: the Uniqlo block makes the FABRIC TECH the identity", () => {
  // THE Uniqlo call. Its identity is a fabric PLATFORM, not a silhouette — and
  // the tech token is the one thing that survives a cut brand tag.
  const block = brandPackPromptBlock(
    pack("Uniqlo", "uniqlo", [
      style(
        "HEATTECH",
        "HEATTECH",
        "Thin thermal base layer; the tell is the printed HEATTECH label rather than the silhouette, which is an ordinary crew/scoop base layer. Sold in graded warmth levels (standard / Extra Warm / Ultra Warm) which are printed on the label — do not infer the level from thickness in a photo.",
        ["HEATTECH"],
      ),
    ]),
  );
  assert(
    /the tell is the printed HEATTECH label rather than the silhouette/.test(block),
    "the block says the LABEL identifies it, not the shape",
  );
  assert(
    /do not infer the level from thickness in a photo/.test(block),
    "the block refuses to guess the warmth level from a photo",
  );
  assert(/\[fabric: HEATTECH\]/.test(block), "the fabric tech reaches the block");
});

Deno.test("US-1739: the Uniqlo block keeps 'Ultra Light Down' a PIECE name, not a brand token", () => {
  // The line that makes the decoder defensible, and the reason the token is
  // excluded from its pattern: "ultra light down" is a DESCRIPTIVE ENGLISH PHRASE
  // any brand may truthfully use. It fails brand-unique for exactly the reason
  // HEATTECH passes it.
  const block = brandPackPromptBlock(
    pack("Uniqlo", "uniqlo", [
      style(
        "Ultra Light Down",
        "Ultra Light Down",
        "Uniqlo's signature packable down jacket. NOTE this style name is a DESCRIPTIVE PHRASE, not a brand-unique token: it names the PIECE and must never be used to recover the brand. Contrast HEATTECH.",
      ),
    ]),
  );
  assert(
    /must never be used to recover the brand/.test(block),
    "the block says the descriptive phrase cannot recover the brand",
  );
});

Deno.test("US-1739: the Gap block reads 'gap' as DAMAGE before it reads it as a brand", () => {
  // The nastiest token in the entire epic, and worse than 00457's "moth" on the
  // axis that matters: "moth" is only a house LABEL and could be refused outright,
  // while "Gap" is a REAL canonical brand that MUST resolve. So it cannot be
  // removed — only contained.
  const block = brandPackPromptBlock(
    pack("Gap", "gap", [
      style(
        "Gap Arch Logo Sweatshirt",
        "Gap Logo",
        'The spell-out/arch "GAP" chest sweatshirt. NOTE "gap" is a garment-CONDITION word ("a gap in the waistband", "gaping at the bust") far more often than it is this brand — read it as the brand ONLY from the label or the brand field, NEVER from a description.',
      ),
    ]),
  );
  assert(
    /is a garment-CONDITION word/.test(block),
    "the condition-word warning reaches the block",
  );
  assert(
    /NEVER from a description/.test(block),
    "the block forbids minting the brand from description text",
  );
});

Deno.test("US-1739: the outlet lines are DISCLOSED in the block, not silently folded away", () => {
  // The fold is correct (eBay has no separate catalogue brand for "Gap Factory",
  // so a split would invent one and mis-map the aspect on every listing) — but a
  // fold that DROPS the line silently comps a lower-spec outlet product as
  // mainline. `style` is the only place the distinction can survive, so this
  // asserts it actually reaches the model.
  const gap = brandPackPromptBlock(
    pack("Gap", "gap", [
      style(
        "Gap Factory (outlet line)",
        "Gap Factory",
        'NOT A GARMENT — a LINE, seeded as a style so it is DISCLOSED on the listing. Gap Factory (formerly Gap Outlet) is made FOR the outlet at a lower spec and a lower price band; it is NOT mainline overstock. The tag says "Gap Factory".',
      ),
    ]),
  );
  assert(/NOT mainline overstock/.test(gap), "the Gap Factory line is disclosed");
  assert(/made FOR the outlet/.test(gap), "the made-for-outlet fact reaches the block");

  const br = brandPackPromptBlock(
    pack("Banana Republic", "bananarepublic", [
      style(
        "Banana Republic Factory Store (outlet line)",
        "BR Factory",
        '"Banana Republic Factory Store" is made FOR the outlet at a lower spec and a lower price band, NOT mainline overstock. The tag differs from mainline by two words.',
      ),
    ]),
  );
  assert(/NOT mainline overstock/.test(br), "the BR Factory line is disclosed");
});

Deno.test("US-1739: the Banana Republic block keeps the SAFARI era a different product", () => {
  // 1978-~1988 BR was a safari/travel outfitter with essentially nothing in
  // common with the mall tailoring brand now wearing the name. An ERA, not a LINE
  // — so it is carried in the styles rather than split into a second brand.
  const block = brandPackPromptBlock(
    pack("Banana Republic", "bananarepublic", [
      style(
        "Safari-era Banana Republic",
        "Safari / travel era",
        "THE Banana Republic collectible, and effectively a different brand: 1978-~1988 safari and travel outfitting from the Zieglers' hand-illustrated-catalogue era. Identify it from the LABEL, not the khaki: modern BR also sells utility-looking cotton.",
      ),
    ]),
  );
  assert(
    /Identify it from the LABEL, not the khaki/.test(block),
    "the block refuses to date the piece from the fabric look",
  );
});

Deno.test("US-1739: the Abercrombie block says the pre-1977 brand is a DIFFERENT COMPANY", () => {
  // The sharpest era break in the epic: an elite expedition outfitter that went
  // bankrupt, whose name was later bought and rebuilt as a mall brand.
  const block = brandPackPromptBlock(
    pack("Abercrombie & Fitch", "abercrombiefitch", [
      style(
        "Vintage sporting-goods A&F (pre-1977)",
        "Original A&F",
        "A DIFFERENT COMPANY, seeded here as a style because there is no second brand to key. The original Abercrombie & Fitch (1892-1977) was an elite sporting goods and expedition outfitter that went bankrupt before the mall brand bought the name. The LABEL identifies it.",
      ),
    ]),
  );
  assert(/A DIFFERENT COMPANY/.test(block), "the pre-1977 break reaches the block");
  assert(
    /there is no second brand to key/.test(block),
    "the block records WHY an era does not earn a split",
  );
});

Deno.test("US-1739: the Abercrombie block calls the modern MISSING logo normal, not a defect", () => {
  // GRADING-relevant: the post-2016 rebrand deliberately dropped heavy logo
  // branding. Reading an absent logo as a removed graphic or a fake grades an
  // intact garment down — the same shape as 00457's Eileen Fisher drape.
  const block = brandPackPromptBlock(
    pack("Abercrombie & Fitch", "abercrombiefitch", [
      style(
        "Logo / Moose-era A&F",
        "Logo era",
        "The ~1997-2010 logo-heavy mall era. NOTE the modern brand deliberately dropped heavy logo branding, so an absent logo on a modern piece is NORMAL and is not a removed graphic or a fake.",
      ),
    ]),
  );
  assert(
    /an absent logo on a modern piece is NORMAL/.test(block),
    "the block blocks the absent-logo misread",
  );
});

Deno.test("US-1739: the Tommy block says the REVIVAL looks like the vintage on purpose", () => {
  // The trap that follows from the era spread, and the reason the era is
  // unguessable from a photo: the modern revival DELIBERATELY reissues the 90s
  // flag look, so a modern piece is SUPPOSED to look old. If the graphic could
  // date the garment, a ~10x price difference would ride on a photo.
  const block = brandPackPromptBlock(
    pack("Tommy Hilfiger", "tommyhilfiger", [
      style(
        "Vintage flag-logo Tommy",
        "1990s flag era",
        "THE Tommy collectible: 1990s big-flag/crest branding, reselling for MULTIPLES of the visually similar modern piece. CRITICAL — the modern Tommy Jeans revival DELIBERATELY reissues this look, so the GRAPHIC cannot date the garment. Only the LABEL and tag construction separate them. Never claim the vintage era from the graphic alone.",
      ),
    ]),
  );
  assert(
    /the GRAPHIC cannot date the garment/.test(block),
    "the block refuses to date the piece from the graphic",
  );
  assert(
    /Never claim the vintage era from the graphic alone/.test(block),
    "the never-claim-vintage-from-the-graphic rule survives",
  );
});

Deno.test("US-1739: every brand in the group refuses to assert authenticity", () => {
  // The epic's hard line. Vintage Tommy and 2000s A&F are heavily counterfeited,
  // which raises the stakes and does not change the stance.
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

Deno.test("US-1739: ONLY Uniqlo invites a code transcription", () => {
  // The group's stance, asserted directly, and the INVERSE of 00456/00457's (where
  // NO brand had a decoder). Uniqlo earns one because its identifier is a COINED
  // trademark; the other six name their pieces with ordinary English words and
  // must never invite a transcription. If a future seed adds a decoder to one of
  // them — Old Navy's "Powersoft" is the tempting one — this fails.
  const uniqlo = brandPackPromptBlock(
    pack("Uniqlo", "uniqlo", [style("HEATTECH", "HEATTECH", "a fingerprint")], [
      {
        decoderKind: "style_name",
        description: "Care/neck-label fabric-technology trademark.",
        pattern: "^(?<style>HEATTECH|AIRISM|BLOCKTECH|DRY-?EX)$",
        extractionRules: {
          fieldMap: { style: "styleCode" },
          transforms: { style: "upper" },
          confidence: 0.72,
        },
        examples: [],
      },
    ]),
  );
  assert(
    /transcribe it VERBATIM/i.test(uniqlo),
    "Uniqlo DOES invite a transcription — its tech token is brand-unique",
  );

  for (const [brand, key] of GROUP) {
    if (key === "uniqlo") continue;
    const block = brandPackPromptBlock(
      pack(brand, key, [style("X", "X", "a fingerprint")]),
    );
    assert(
      !/transcribe it VERBATIM/i.test(block),
      `${brand} must not invite a code transcription (its names are ordinary words)`,
    );
  }
});

// ── canonicalization ────────────────────────────────────────────────────────

Deno.test("US-1739: the group's brands still canonicalize (they were already curated)", () => {
  // Unlike every prior group, none of these was a passthrough — the value this
  // story adds is the CONTENT on the rows, not the alias. Asserted so a future
  // edit to brand-normalize cannot quietly drop one.
  assertEquals(canonicalizeBrand("uniqlo"), "Uniqlo");
  assertEquals(canonicalizeBrand("gap"), "Gap");
  assertEquals(canonicalizeBrand("The Gap"), "Gap");
  assertEquals(canonicalizeBrand("banana republic"), "Banana Republic");
  assertEquals(canonicalizeBrand("old navy"), "Old Navy");
  assertEquals(canonicalizeBrand("american eagle"), "American Eagle");
  assertEquals(canonicalizeBrand("abercrombie"), "Abercrombie & Fitch");
  assertEquals(canonicalizeBrand("tommy hilfiger"), "Tommy Hilfiger");
  for (const [brand] of GROUP) {
    assert(isKnownBrand(brand), `${brand} is a curated entry, not a passthrough`);
  }
});

Deno.test("US-1739: the SUB-LABELS and OUTLET LINES fold onto their parent brand", () => {
  // These WERE passthrough-only before this story — an "aerie" tag rendered
  // "aerie" into the prompt block and the eBay Brand aspect. They fold on the
  // Michael Kors / Aritzia play: each shares its parent's price band, so folding
  // costs no comp accuracy, and the line survives in `style`.
  for (const label of ["babyGap", "GapKids", "GapFit", "GapBody", "Gap Factory"]) {
    assertEquals(canonicalizeBrand(label), "Gap", `${label} folds onto Gap`);
  }
  for (
    const label of ["Banana Republic Factory", "Banana Republic Factory Store"]
  ) {
    assertEquals(
      canonicalizeBrand(label),
      "Banana Republic",
      `${label} folds onto Banana Republic`,
    );
  }
  // ⚠ "aerie"/"Aerie" USED to fold onto American Eagle here — US-1991 PROMOTED
  // Aerie to its own canonical for the intimates category (it comps on its own
  // eBay ladder), so it is no longer in this loop. American Eagle's own store
  // forms still fold.
  for (const label of ["American Eagle Outfitters", "AEO"]) {
    assertEquals(
      canonicalizeBrand(label),
      "American Eagle",
      `${label} folds onto American Eagle`,
    );
  }
  // Aerie now stands on its own (see intimates-loungewear-content_test.ts).
  assertEquals(canonicalizeBrand("aerie"), "Aerie", "Aerie is its own brand (US-1991)");
  for (const label of ["Tommy Jeans", "Tommy Hilfiger Denim", "Hilfiger"]) {
    assertEquals(
      canonicalizeBrand(label),
      "Tommy Hilfiger",
      `${label} folds onto Tommy Hilfiger`,
    );
  }
  assertEquals(canonicalizeBrand("Uniqlo U"), "Uniqlo");
  assertEquals(canonicalizeBrand("Abercrombie & Fitch"), "Abercrombie & Fitch");
  assertEquals(canonicalizeBrand("abercrombie kids"), "Abercrombie & Fitch");
});

Deno.test("US-1739: HOLLISTER does NOT fold into Abercrombie (the parent company is not the brand)", () => {
  // The counter-example that makes the folds above a rule rather than a habit.
  // A&F Co OWNS Hollister — and Hollister is separately branded, separately
  // searched, and a LOWER price band, so it keeps its own canonical. Folding it
  // would comp a Hollister tee against an A&F one. The corporate fact NEVER
  // decides a fold; the price band and the eBay catalogue do.
  assertEquals(canonicalizeBrand("hollister"), "Hollister");
  assertEquals(canonicalizeBrand("Hollister"), "Hollister");
  assert(
    canonicalizeBrand("hollister") !== "Abercrombie & Fitch",
    "Hollister must never fold into its parent's brand",
  );
});

Deno.test("US-1739: a bare 'Tommy' never resolves (Tommy Bahama is a different company)", () => {
  // 00457's Vince / Vince Camuto shape — unrelated businesses sharing a first
  // name — with ONE structural difference that changes the remedy. Vince Camuto
  // CONTAINS "Vince", so it needed a protective canonical entry to win the
  // longest-first sort. Neither Tommy full-name contains the other, so full-name
  // matching separates them cleanly and the only hazard is the bare first name.
  // So the bare first name is simply never mapped.
  assertEquals(
    canonicalizeBrand("Tommy"),
    "Tommy",
    "a bare 'Tommy' passes through rather than minting Tommy Hilfiger",
  );
  assertEquals(
    canonicalizeBrand("Tommy Bahama"),
    "Tommy Bahama",
    "Tommy Bahama passes through — it is a different company",
  );
  assert(
    canonicalizeBrand("Tommy Bahama") !== "Tommy Hilfiger",
    "Tommy Bahama must never fold into Tommy Hilfiger",
  );
  // And the detector does not mint Tommy Hilfiger from a Tommy Bahama title.
  assertEquals(
    detectBrandInText("Tommy Bahama silk camp shirt, size L"),
    null,
    "a Tommy Bahama title does not mint Tommy Hilfiger",
  );
  assertEquals(
    detectBrandInText("Tommy Hilfiger flag rugby polo, size L"),
    "Tommy Hilfiger",
    "the full name still resolves",
  );
});

Deno.test("US-1739: an ordinary word must never mint a brand in this group", () => {
  // The pack is dense with them, and every one is contained the same way: the
  // alias table matches the WHOLE brand field, and CANONICAL_BRANDS is built from
  // the VALUES — so an alias KEY like "aerie" never reaches detectBrandInText.
  assertEquals(
    detectBrandInText("Levi's 501 jeans, no gaping at the waist"),
    "Levi's",
    "a condition-word 'gaping' does not beat the real brand in the title",
  );
  assertEquals(
    detectBrandInText("silk blouse with a small gaping seam at the placket"),
    null,
    "'gaping' does not mint Gap",
  );
  assertEquals(
    detectBrandInText("wide-leg trousers, gaps between the buttons"),
    null,
    "'gaps' does not mint Gap — the detector is word-bounded on BOTH sides",
  );
  assertEquals(
    detectBrandInText("cotton tee with an aerie of birds printed on the chest"),
    null,
    "'aerie' in free text does not mint American Eagle",
  );
  assertEquals(
    detectBrandInText("vintage rockstar graphic tour tee"),
    null,
    "'rockstar' does not mint Old Navy",
  );
  // But the REAL brand still resolves from a title — the containment must not
  // have cost us the brand itself.
  assertEquals(
    detectBrandInText("Gap 1969 straight leg jeans W32 L32"),
    "Gap",
    "the real Gap brand still resolves in a title",
  );
});

// ── sizing charts ───────────────────────────────────────────────────────────

Deno.test("US-1739: the group's charts are reachable per brand", () => {
  const cases: Array<[string, string]> = [
    ["Uniqlo", "tee"],
    ["Uniqlo", "heattech"],
    ["Uniqlo", "sweater"],
    ["Gap", "hoodie"],
    ["Gap", "jean"],
    ["Banana Republic", "blouse"],
    ["Banana Republic", "merino"],
    ["Old Navy", "tee"],
    ["Old Navy", "jean"],
    ["American Eagle", "jean"],
    ["American Eagle", "denim"],
    ["Abercrombie & Fitch", "jean"],
    ["Abercrombie & Fitch", "polo"],
    ["Tommy Hilfiger", "polo"],
    ["Tommy Hilfiger", "sweater"],
  ];
  for (const [brand, category] of cases) {
    const found = findSizingCharts(brand, category);
    assert(
      found.some((c) => c.brand === brand),
      `${brand} chart reachable for "${category}"`,
    );
  }
});

Deno.test("US-1739: the CONCATENATED Gap sub-labels reach Gap's charts", () => {
  // THE first bill come due from the US-1738 leading-boundary fix, and the reason
  // the concatenated spellings are listed explicitly in brandMatch rather than
  // left to a bare "gap".
  //
  //   "babygap".indexOf("gap") is preceded by "y" — a WORD CHARACTER — so the
  //   leading-boundary matcher does NOT fire, and babyGap would silently miss
  //   Gap's charts entirely.
  //
  // The concatenated forms are how the tags actually print, so this is not a
  // hypothetical. The fix is right and the cost is real: every future short-token
  // brand must list its concatenated sub-labels.
  for (const label of ["babyGap", "GapKids", "GapFit", "GapBody"]) {
    assert(
      findSizingCharts(label, "tee").some((c) => c.brand === "Gap"),
      `${label} reaches Gap's charts despite the leading-boundary matcher`,
    );
  }
  // The spaced form was never at risk — it matches "gap" at a word start.
  assert(
    findSizingCharts("Baby Gap", "tee").some((c) => c.brand === "Gap"),
    "the spaced 'Baby Gap' still reaches Gap's charts",
  );
  assert(
    findSizingCharts("Gap Factory", "jean").some((c) => c.brand === "Gap"),
    "the outlet line shares the parent's grade",
  );
});

Deno.test("US-1739: no token in this group bleeds onto another brand's charts", () => {
  // "gap" is three letters, "aerie" is an ordinary noun, "tommy" is a first name —
  // exactly the shape that produced the Lee/"eileen fisher" bug in US-1738. The
  // leading-boundary matcher contains them; this asserts it.
  assert(
    findSizingCharts("Gap", "tee").every((c) => c.brand === "Gap"),
    "Gap's brand text selects only Gap charts",
  );
  assert(
    findSizingCharts("Old Navy", "tee").every((c) => c.brand === "Old Navy"),
    "Old Navy's brand text selects only Old Navy charts",
  );
  assert(
    findSizingCharts("Uniqlo", "tee").every((c) => c.brand === "Uniqlo"),
    "Uniqlo's brand text selects only Uniqlo charts",
  );
  assert(
    findSizingCharts("Banana Republic", "blouse").every((c) =>
      c.brand === "Banana Republic"
    ),
    "Banana Republic's brand text selects only its own charts",
  );
  // Tommy Bahama is a DIFFERENT COMPANY and must not reach Tommy Hilfiger's
  // charts. This is the in-code half of the containing-name trap: brandMatch
  // carries the FULL name ("tommy hilfiger"), never a bare "tommy", so a Tommy
  // Bahama garment falls through to the generics — the correct behaviour, and the
  // same outcome 00457 achieved for Vince Camuto.
  assert(
    findSizingCharts("Tommy Bahama", "polo").every((c) => c.brand !== "Tommy Hilfiger"),
    "Tommy Bahama never reaches Tommy Hilfiger's charts",
  );
  assert(
    findSizingCharts("Tommy Hilfiger", "polo").some((c) => c.brand === "Tommy Hilfiger"),
    "Tommy Hilfiger still reaches its own charts",
  );
  // And Hollister — a real, separate canonical — must not land on A&F's charts.
  assert(
    findSizingCharts("Hollister", "tee").every((c) => c.brand !== "Abercrombie & Fitch"),
    "Hollister never reaches Abercrombie's charts",
  );
});

Deno.test("US-1739: the sizing SPREAD warns in each brand's own direction", () => {
  // The pack's real sizing story: these tags all say the same letters and mean
  // different bodies, and NOTHING ON THE TAG SAYS SO. Each cross-map is written
  // INSIDE the size label — the 00455 lesson — because that is where the model
  // actually reads it, not in a note it may or may not weigh.
  const uniqlo = SIZING_CHARTS.filter((c) => c.brand === "Uniqlo");
  assert(uniqlo.length > 0, "Uniqlo charts exist");
  for (const c of uniqlo) {
    assert(/RUNS SMALL/.test(c.garment), `Uniqlo ${c.garment} announces the direction`);
    assert(/RUNS SMALL/.test(c.note ?? ""), "the Uniqlo note states the direction");
    assert(
      c.rows.every((r) => /fits ≈US/.test(r.size)),
      "every Uniqlo size label carries its US cross-map",
    );
  }

  const oldNavy = SIZING_CHARTS.filter((c) => c.brand === "Old Navy");
  assert(oldNavy.length > 0, "Old Navy charts exist");
  for (const c of oldNavy) {
    assert(/RUNS LARGE/.test(c.garment), `Old Navy ${c.garment} announces the direction`);
    assert(/VANITY-SIZED/.test(c.note ?? ""), "the Old Navy note names the cause");
  }

  // THE point of the pair: the SAME letter, the OPPOSITE body, and both notes say
  // so explicitly. A model that carries one brand's grade onto the other is the
  // failure this is built to prevent.
  const uniqloTop = uniqlo.find((c) => c.department === "Women");
  const onTop = oldNavy.find((c) => c.department === "Women" && /Tops/.test(c.garment));
  assert(
    /Uniqlo M is nearer a US 4-6/.test(onTop?.note ?? ""),
    "Old Navy's note points AT Uniqlo, the other direction",
  );
  assert(
    /OPPOSITE way/.test(uniqloTop?.note ?? ""),
    "Uniqlo's note points at the brands running the other way",
  );
  assert(
    /is the grade, not stretching, not a mislabel/.test(onTop?.note ?? ""),
    "Old Navy's generosity is called the grade, not a defect",
  );
});

Deno.test("US-1739: the named FIT is treated as read-off-the-tag, never inferred", () => {
  // The story's own priority ("prioritize size charts + fit names"). On a staple
  // the fit name IS the identification, and it separates two visually identical
  // pairs at different values — which is exactly why it must never be guessed.
  const ae = SIZING_CHARTS.find((c) =>
    c.brand === "American Eagle" && c.department === "Women"
  );
  assert(
    /never guess it from the photo/.test(ae?.note ?? ""),
    "AE's chart refuses to infer the fit from a photo",
  );
  // CURVE LOVE / CURVY measure a larger hip at the same waist BY DESIGN — a
  // grading fact, the same shape as 00457's Eileen Fisher drape.
  assert(
    /not a mislabel and not a stretched garment/.test(ae?.note ?? ""),
    "AE's Curvy fit is called the design, not a defect",
  );
  const af = SIZING_CHARTS.find((c) =>
    c.brand === "Abercrombie & Fitch" && c.department === "Women"
  );
  assert(
    /not a mislabel, not a stretched garment/.test(af?.note ?? ""),
    "A&F's Curve Love fit is called the design, not a defect",
  );
});

Deno.test("US-1739: the era spread is written into the charts that cannot see it", () => {
  // A chart describes ONE grade. Tommy's 90s flag era was cut deliberately
  // oversized, so a vintage garment measures far larger than the modern table —
  // and reading that as a mislabel or a stretched garment is exactly the error a
  // ~10x-spread brand cannot afford. The chart says so itself.
  for (
    const c of SIZING_CHARTS.filter((c) => c.brand === "Tommy Hilfiger")
  ) {
    assert(
      /ERA IS THE PRICE/.test(c.note ?? ""),
      `Tommy ${c.department} chart flags that the era decides the price`,
    );
    assert(
      /normal for its era|NORMAL for its era/.test(c.note ?? ""),
      `Tommy ${c.department} chart blocks the oversized-vintage misread`,
    );
  }
});

Deno.test("US-1739: every chart in the group tells the seller to measure", () => {
  // The epic's standing rule: a chart is a reference, not gospel, and the tag is a
  // claim to check. Doubly true here, where the whole group's tags are unreliable
  // in three different directions.
  const brands = GROUP.map(([b]) => b);
  const charts = SIZING_CHARTS.filter((c) => brands.includes(c.brand));
  assertEquals(charts.length, 14, "all 14 group charts are present in-code");
  for (const c of charts) {
    assert(
      /[Mm]easure/.test(c.note ?? ""),
      `${c.brand} / ${c.garment} tells the seller to measure`,
    );
    assert(
      /not .*published specs|not published specs/.test(c.note ?? ""),
      `${c.brand} / ${c.garment} admits the figures are approximations`,
    );
  }
});
