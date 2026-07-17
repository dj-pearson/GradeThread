// US-1736: verify the luxury & designer content (migration 00455) is correct +
// consumable by the engine.
//
// This group splits in half and the two halves have OPPOSITE rules, which is what
// the assertions below are really protecting:
//
//   * EUROPEAN HOUSES (Chanel / Burberry / Prada) — a NATIONAL tag number (FR /
//     UK / IT) and RTW that runs SMALL against the US body the cross-map implies.
//     The signature trap is that the SAME NUMBER means different sizes: a "42" is
//     US 10 on a Chanel FR tag and US 6 on a Prada IT tag.
//   * AMERICAN ACCESSIBLE LUXURY (MK / Kate Spade / Tory Burch) — US sizing,
//     true-to-large, and the value hazard is not a fake but an entirely AUTHENTIC
//     outlet/diffusion piece. The question is which LINE, and the label answers.
//
// Chanel + Kate Spade are the only two brands here with a decodable code, so they
// are the only ones whose block should carry the transcribe-the-code hint — the
// resolver-side decode itself is covered by brand-knowledge-golden.
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
const { canonicalizeBrand, isKnownBrand } = await import("../lib/brand-normalize.ts");
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
    category: "bag",
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
    categoryFocus: ["luxury"],
    authenticationTells,
    tagEras: [],
    styles,
    decoders,
    colorways: [],
    sizingCharts: [],
    source: "db",
  };
}

Deno.test("US-1736: the Chanel block separates the Flap from the Reissue by its CHAIN", () => {
  // Packs shaped as the US-1711 resolver returns for the 00455-seeded rows,
  // carrying the seeded fingerprints verbatim.
  const block = brandPackPromptBlock(
    pack("Chanel", "chanel", [
      style(
        "Classic Flap",
        "Classic",
        "The diamond-quilted flap bag with a CC TURNLOCK and a chain that has LEATHER WOVEN THROUGH it. vs the 2.55 Reissue: these two are constantly conflated and are different prices — the Classic Flap has the CC lock and the leather-woven chain, the Reissue has neither.",
      ),
      style(
        "2.55 Reissue",
        "Reissue",
        "The heritage reissue: a rectangular MADEMOISELLE lock (not the CC turnlock) and an ALL-METAL chain with no leather woven through it. vs the Classic Flap: the lock and the chain are the two separators and both are readable in any photo of the front of the bag.",
      ),
    ]),
  );
  assert(block.includes("Classic Flap"), "names the Classic Flap");
  assert(block.includes("2.55 Reissue"), "names the 2.55 Reissue");
  // The money call: two constantly-conflated models at different prices, and both
  // separators are visible in a single front-on photo.
  assert(/LEATHER WOVEN THROUGH/.test(block), "the Flap's woven chain reaches the block");
  assert(/ALL-METAL chain/.test(block), "the Reissue's all-metal chain reaches the block");
  assert(/MADEMOISELLE lock/.test(block), "the Mademoiselle lock is the stated separator");
});

Deno.test("US-1736: the Burberry block reads the tag as a TIER and a DATE at once", () => {
  const block = brandPackPromptBlock(
    pack("Burberry", "burberry", [
      style(
        "Kensington Trench",
        "Heritage Trench",
        "The SLIM-fit heritage trench in cotton gabardine, mid-length. vs Chelsea and Westminster: all three are the same gabardine with the same storm flap, epaulettes, D-ring belt and check lining — they differ ONLY in fit and length, which is very hard to judge on a flat-lay. READ THE FIT NAME OFF THE TAG rather than estimating the cut by eye.",
        ["cotton gabardine"],
      ),
      style(
        "Burberry Prorsum",
        "Tier label",
        "NOT a garment — the discontinued RUNWAY TIER label, retired when Burberry consolidated its three sub-labels into one in 2016. It must be read as a TIER and a DATE at once: Prorsum outranks London, which outranks Brit, and any of the three means the piece predates the consolidation.",
      ),
    ]),
  );
  // The three trenches are the same coat in three cuts — the tag is the only
  // reliable separator, exactly like 00454's 13MWZ vs 936DEN.
  assert(/READ THE FIT NAME OFF THE TAG/.test(block), "the trench fit is read off the tag");
  assert(/differ ONLY in fit and length/.test(block), "the trenches are stated identical but for cut");
  // The pre-2016 sub-label is Burberry's highest-leverage fact and does double duty.
  assert(/Prorsum outranks London/.test(block), "the tier ranking reaches the block");
  assert(/TIER and a DATE at once/.test(block), "the sub-label is stated to date AND rank");
});

Deno.test("US-1736: the Prada block warns that Saffiano is a FINISH, not a brand", () => {
  const block = brandPackPromptBlock(
    pack("Prada", "prada", [
      style(
        "Saffiano",
        "Saffiano",
        "The cross-hatch-stamped, wax-treated leather Prada originated. THE TRAP ON THIS LINE IS CROSS-BRAND: Saffiano is now an industry-wide FINISH, and Michael Kors builds much of its line on the same cross-hatch look at a fraction of the price — so the texture does NOT identify Prada. The triangle plaque and the label do.",
        ["Saffiano leather"],
      ),
    ]),
  );
  // The group's one CROSS-BRAND trap: two brands in this same pack share a
  // texture at wildly different prices, so reading the texture as a brand is a
  // pricing error in both directions.
  assert(/industry-wide FINISH/.test(block), "Saffiano is named as a finish");
  assert(/does NOT identify Prada/.test(block), "the texture is explicitly not the brand");
  assert(/Michael Kors/.test(block), "the block names the cross-brand lookalike by name");
});

Deno.test("US-1736: the Michael Kors block ranks the LINE, not the logo", () => {
  const block = brandPackPromptBlock(
    pack("Michael Kors", "michaelkors", [
      style(
        "Michael Kors Collection",
        "Collection",
        "NOT a garment — the TOP TIER label (the runway line, largely Made in Italy). Worth MULTIPLES of a MICHAEL Michael Kors piece that may look similar in a thumbnail. The label reads MICHAEL KORS COLLECTION and the country of manufacture usually corroborates it.",
      ),
      style(
        "MICHAEL Michael Kors",
        "MICHAEL",
        "NOT a garment — the DIFFUSION tier, and by volume the overwhelming majority of MK resale. Its label literally stacks the word MICHAEL above Michael Kors, which is the separator and is legible on any tag photo. vs Collection: the MK logo is identical on both and ranks nothing — only the label wording does.",
      ),
    ]),
  );
  // The American half's money fact: the tier is the price, and the logo — the one
  // thing a naive model reads — ranks nothing at all.
  assert(/TOP TIER/.test(block), "Collection is named the top tier");
  assert(/Worth MULTIPLES/.test(block), "the price gap between the lines is stated");
  assert(
    /the MK logo is identical on both and ranks nothing/.test(block),
    "the logo is explicitly disqualified as a tier signal",
  );
});

Deno.test("US-1736: the Kate Spade block calls outlet product AUTHENTIC, not fake", () => {
  const block = brandPackPromptBlock(
    pack("Kate Spade", "katespade", [
      style(
        "Kate Spade Outlet",
        "Outlet",
        "NOT a garment — MADE-FOR-OUTLET product, manufactured for the outlet channel and never sold at full retail. It is entirely AUTHENTIC and worth materially less than the mainline piece it resembles. Do NOT describe it as fake, and do NOT comp it against mainline.",
      ),
    ]),
  );
  // The subtle half of the never-authenticate stance: on the American brands the
  // usual error is the OPPOSITE one — calling a real outlet piece fake. Both the
  // "it's authentic" and the "don't comp it as mainline" halves have to survive,
  // because either alone gets the price wrong.
  assert(/entirely AUTHENTIC/.test(block), "outlet product is stated to be authentic");
  assert(/Do NOT describe it as fake/.test(block), "the fake misread is explicitly blocked");
  assert(/do NOT comp it against mainline/.test(block), "the mainline mis-comp is blocked too");
});

Deno.test("US-1736: the Tory Burch block separates Reva from Miller by the MEDALLION", () => {
  const block = brandPackPromptBlock(
    pack("Tory Burch", "toryburch", [
      style(
        "Reva Ballet Flat",
        "Reva",
        "THE Tory Burch icon: a soft ballet flat with a large double-T medallion sitting FLAT on the toe. vs the Miller sandal: the Reva's medallion is a solid plate applied to the vamp, while the Miller's medallion is CUT THROUGH so the strap passes between the toes.",
      ),
      style(
        "Miller Sandal",
        "Miller",
        "The thong sandal whose double-T medallion is CUT OUT — the toe strap passes through the medallion itself. vs the Reva: the Reva's medallion is solid and sits flat on a closed toe.",
      ),
    ]),
  );
  // Both icons carry the same medallion, so the medallion's PRESENCE separates
  // nothing — how it is USED (solid plate vs cut through) is the whole tell.
  assert(/CUT THROUGH/.test(block), "the Miller's cut-out medallion reaches the block");
  assert(/solid plate/.test(block), "the Reva's solid medallion reaches the block");
});

Deno.test("US-1736: every brand in the group refuses to assert authenticity", () => {
  // The story's hard line, and it holds for all six regardless of tier. The block
  // renders one generic authentication line whenever a pack carries tells — so
  // what this asserts is that the never-authenticate framing reaches the prompt
  // for every brand that has tells seeded, which in 00455 is all six.
  const brands: Array<[string, string]> = [
    ["Chanel", "chanel"],
    ["Burberry", "burberry"],
    ["Prada", "prada"],
    ["Michael Kors", "michaelkors"],
    ["Kate Spade", "katespade"],
    ["Tory Burch", "toryburch"],
  ];
  for (const [brand, key] of brands) {
    const block = brandPackPromptBlock(
      pack(brand, key, [], [], [
        {
          tell: "NEVER auto-authenticate",
          detail: `NEVER label a ${brand} item authentic; flag inconsistencies in condition notes only.`,
        },
      ]),
    );
    assert(
      /NEVER assert authenticity/.test(block),
      `${brand} block carries the never-assert-authenticity instruction`,
    );
  }
});

Deno.test("US-1736: only Kate Spade invites a code transcription", () => {
  const block = brandPackPromptBlock(
    pack("Kate Spade", "katespade", [], [{
      decoderKind: "style_number",
      description:
        "Kate Spade tag-printed style number: a 4-letter family prefix + 4 digits (e.g. PXRU5228). Identifies the STYLE FAMILY only.",
      pattern: "^(?<style>(?:PXRU|WKRU|PXRC|WKRC)[0-9]{4})$",
      extractionRules: {},
      examples: [],
    }]),
  );
  assert(
    /transcribe it VERBATIM/i.test(block),
    "Kate Spade carries the decoder hint (its code is garment-printed)",
  );

  // The other five are decoder-less by design. CHANEL is the pointed one — its
  // serial sticker IS tag-printed and regular, so it looks decodable, and it
  // deliberately is not: a bare 7-8 digit run is an ordinary number, so a pattern
  // over it would mint a Chanel from any tag carrying an 8-digit number. The rest
  // print a line name or a retailer SKU, not a brand-unique garment code.
  for (const [brand, key] of [
    ["Chanel", "chanel"],
    ["Burberry", "burberry"],
    ["Prada", "prada"],
    ["Michael Kors", "michaelkors"],
    ["Tory Burch", "toryburch"],
  ]) {
    const b = brandPackPromptBlock(pack(brand, key, [
      style("X", "X", "a fingerprint"),
    ]));
    assert(
      !/transcribe it VERBATIM/i.test(b),
      `${brand} must not invite a code transcription (it has no decodable code)`,
    );
  }
});

Deno.test("US-1736: the new luxury aliases canonicalize (were passthrough-only before)", () => {
  // Without these, canonicalizeBrand PASSED THROUGH the seller's own casing
  // ("chanel") into the prompt block and the eBay Brand aspect.
  assertEquals(canonicalizeBrand("chanel"), "Chanel");
  assertEquals(canonicalizeBrand("COCO CHANEL"), "Chanel");
  assertEquals(canonicalizeBrand("prada"), "Prada");
  assertEquals(canonicalizeBrand("Prada Milano"), "Prada");
  assertEquals(canonicalizeBrand("tory burch"), "Tory Burch");
  assert(isKnownBrand("chanel"), "Chanel is now a curated entry");
  assert(isKnownBrand("tory burch"), "Tory Burch is now a curated entry");

  // "Burberrys" (with the S) is the PRE-1999 label — it is a Burberry tag, so it
  // canonicalizes to Burberry. The spelling is a dating tell (a tag_era in
  // 00455), not a separate brand.
  assertEquals(canonicalizeBrand("Burberrys"), "Burberry");
  assertEquals(canonicalizeBrand("Burberrys of London"), "Burberry");
  assertEquals(canonicalizeBrand("Burberry London"), "Burberry");

  // Every MK line resolves to the ONE eBay brand. The tier is a style, not a
  // brand — which is exactly what lets brand_styles rank it.
  for (const raw of [
    "MK",
    "Kors",
    "MICHAEL Michael Kors",
    "KORS Michael Kors",
    "Michael Kors Collection",
  ]) {
    assertEquals(canonicalizeBrand(raw), "Michael Kors", `${raw} → Michael Kors`);
  }
  assertEquals(canonicalizeBrand("kate spade new york"), "Kate Spade");
  assertEquals(canonicalizeBrand("KSNY"), "Kate Spade");

  // Miu Miu is a PRADA GROUP label but is NOT Prada — the same rule that keeps
  // AGOLDE off AG Jeans (00454). It must stay a passthrough, never get relabeled.
  assertEquals(canonicalizeBrand("Miu Miu"), "Miu Miu");
  assert(!isKnownBrand("miu miu"), "Miu Miu is not silently folded into Prada");

  // A bare "tory" must NOT rebrand — it is an ordinary given name, so it stays a
  // passthrough rather than minting a brand from a stray tag token (the same rule
  // that keeps a bare "citizens" off Citizens of Humanity).
  assert(!isKnownBrand("tory"), "a bare 'tory' is not a curated entry");
  assertEquals(canonicalizeBrand("tory"), "tory");
});

Deno.test("US-1736: a short luxury token must never bleed onto another brand", () => {
  // The US-1735 trap, re-checked for this group: findSizingCharts matches
  // brandMatch by SUBSTRING, so a 2-4 letter entry false-fires inside other
  // brands' names. "mk" and "tory" are exact-key BRAND_ALIASES entries ONLY and
  // are deliberately absent from every brandMatch. Guard the invariant directly
  // rather than trusting a comment to survive.
  for (const brand of ["Michael Kors", "Tory Burch"]) {
    const charts = findSizingCharts(brand, "dress");
    assert(charts.length > 0, `${brand} resolves a chart`);
    assert(
      charts.every((c) => c.brand === brand),
      `${brand} resolves only its own charts`,
    );
  }

  // The canonical is what brand-knowledge.ts actually passes, and it is what
  // reaches the chart — which is the whole reason "mk" stays an alias key only.
  const mk = findSizingCharts(canonicalizeBrand("MK"), "dress");
  assert(
    mk.some((c) => c.brand === "Michael Kors"),
    "MK resolves its own chart via the canonical brand",
  );
  const tory = findSizingCharts(canonicalizeBrand("tory burch"), "skirt");
  assert(
    tory.some((c) => c.brand === "Tory Burch"),
    "Tory Burch resolves its own chart via the canonical brand",
  );

  // The pre-1999 "Burberrys" spelling still reaches Burberry's charts — the
  // substring match covers it, which is why there is no second brandMatch token.
  const burberrys = findSizingCharts("Burberrys of London", "trench");
  assert(
    burberrys.some((c) => c.brand === "Burberry"),
    "a Burberrys-spelled brand still resolves Burberry's charts",
  );
});

Deno.test("US-1736: the group's charts are reachable per brand", () => {
  const cases: Array<[string, string, string]> = [
    ["Chanel", "jacket", "Women"],
    ["Chanel", "dress", "Women"],
    ["Burberry", "trench", "Women"],
    ["Burberry", "blazer", "Men"],
    ["Prada", "dress", "Women"],
    ["Prada", "suit", "Men"],
    ["Michael Kors", "dress", "Women"],
    ["Michael Kors", "pant", "Women"],
    ["Kate Spade", "dress", "Women"],
    ["Kate Spade", "blouse", "Women"],
    ["Tory Burch", "dress", "Women"],
    ["Tory Burch", "skirt", "Women"],
  ];
  for (const [brand, category, department] of cases) {
    const found = findSizingCharts(brand, category);
    assert(
      found.some((c) => c.brand === brand && c.department === department),
      `${brand} ${department} chart reachable for "${category}"`,
    );
  }

  // The three luxury flagships already seeded (Coach 00398 / LV 00399 / Gucci
  // 00400) carry no sizing charts, and none of the six new brands may invent one
  // for them by bleeding across — they must still fall through to the generics.
  for (const brand of ["Coach", "Louis Vuitton", "Gucci"]) {
    const charts = findSizingCharts(brand, "dress");
    assert(
      charts.every((c) => c.brandMatch.length === 0),
      `${brand} still falls through to the generic charts`,
    );
  }
});

Deno.test("US-1736: every chart names its sizing SYSTEM and says to measure", () => {
  // The group's signature trap. Three national systems are in this pack, so a
  // chart that does not name its own system is unreadable — the model has no way
  // to know whether a "42" is FR or IT.
  const european: Array<[string, string]> = [
    ["Chanel", "FRENCH sizing"],
    ["Burberry", "UK sizing"],
    ["Prada", "ITALIAN sizing"],
  ];
  for (const [brand, system] of european) {
    const charts = findSizingCharts(brand, "").filter((c) => c.brand === brand);
    assert(charts.length > 0, `${brand} has charts`);
    for (const c of charts) {
      assert(
        /(FRENCH|ITALIAN|UK) (sizing|numeric)/.test(c.note ?? ""),
        `${brand} ${c.garment} note names its national system`,
      );
      // The only defensible number on a used garment.
      assert(
        /Measure the (garment|coat|chest|flat waistband)/i.test(c.note ?? ""),
        `${brand} ${c.garment} note tells the seller to measure`,
      );
    }
    // The brand's primary system is named on at least one of its charts.
    assert(
      charts.some((c) => (c.note ?? "").includes(system)),
      `${brand} names "${system}"`,
    );
  }

  // The cross-map has to survive into the RENDERED table, which means it must be
  // in the size LABEL — a note is not enough, because the label is what sits
  // beside the measurements the model is matching against.
  const chanel = findSizingCharts("Chanel", "dress").find((c) => c.brand === "Chanel");
  assert(chanel!.rows.some((r) => r.size === "FR 42 (US 10)"), "Chanel labels FR 42 as US 10");
  const prada = findSizingCharts("Prada", "dress").find((c) => c.brand === "Prada");
  assert(prada!.rows.some((r) => r.size === "IT 42 (US 6)"), "Prada labels IT 42 as US 6");
  const burberry = findSizingCharts("Burberry", "trench")
    .find((c) => c.brand === "Burberry" && c.department === "Women");
  assert(burberry!.rows.some((r) => r.size === "UK 12 (US 8)"), "Burberry labels UK 12 as US 8");
});

Deno.test("US-1736: the same tag number means DIFFERENT sizes across this group", () => {
  // THE trap this group exists to defend against, asserted as a real conflict
  // rather than a comment: a "42" tag is US 10 on Chanel and US 6 on Prada. Both
  // charts must be able to prove that, and each must warn about the other — a
  // model that reads one chart's 42 and applies it to the other brand is two
  // sizes off on a high-value garment.
  const chanel42 = findSizingCharts("Chanel", "dress")
    .find((c) => c.brand === "Chanel")!
    .rows.find((r) => r.size.startsWith("FR 42"));
  const prada42 = findSizingCharts("Prada", "dress")
    .find((c) => c.brand === "Prada")!
    .rows.find((r) => r.size.startsWith("IT 42"));
  assert(chanel42 && prada42, "both brands grade a 42");
  assert(
    chanel42!.size !== prada42!.size,
    "a 42 does not resolve to the same US size in both systems",
  );
  assert(chanel42!.size.includes("US 10"), "Chanel's 42 is a US 10");
  assert(prada42!.size.includes("US 6"), "Prada's 42 is a US 6");
  // And the measurements actually differ, so the conflict is in the data and not
  // only in the label text.
  assert(
    chanel42!.measurements.bust !== prada42!.measurements.bust,
    "the two 42s carry different bust measurements",
  );

  // Each European chart names the OTHER system it is confused with.
  const chanelNote = findSizingCharts("Chanel", "jacket")
    .find((c) => c.brand === "Chanel")!.note ?? "";
  assert(/DO NOT read it as Italian/.test(chanelNote), "Chanel warns against the Italian read");
  const pradaNote = findSizingCharts("Prada", "dress")
    .find((c) => c.brand === "Prada")!.note ?? "";
  assert(/DO NOT read it as French/.test(pradaNote), "Prada warns against the French read");
});

Deno.test("US-1736: the European and American halves warn in OPPOSITE directions", () => {
  // The group's other split, and it mirrors 00454's vintage-vs-premium shape.
  // Both halves are labeled with a number, but the number lies in opposite
  // directions — so one blanket "luxury runs X" rule would be wrong for half the
  // pack. The European houses do not do US vanity sizing; the American ones do.
  for (const brand of ["Chanel", "Burberry", "Prada"]) {
    const charts = findSizingCharts(brand, "").filter((c) => c.brand === brand);
    assert(
      charts.every((c) => /runs SMALL against/.test(c.note ?? "")),
      `${brand} (European) warns on every chart that it runs SMALL against the cross-map`,
    );
  }

  for (const brand of ["Michael Kors", "Kate Spade", "Tory Burch"]) {
    const charts = findSizingCharts(brand, "").filter((c) => c.brand === brand);
    assert(charts.length > 0, `${brand} has charts`);
    for (const c of charts) {
      assert(
        /runs true-to-large/.test(c.note ?? ""),
        `${brand} (American) carries the true-to-large caveat`,
      );
      // The absence of a cross-map is itself the fact worth stating here — it is
      // what stops a model carrying the FR/IT arithmetic onto a US tag.
      assert(
        /no (national )?cross-map applies|NOT the FR\/IT\/UK systems/.test(c.note ?? ""),
        `${brand} states that no national cross-map applies`,
      );
    }
  }

  // Spelled out on the MK tops chart, which is where the contrast is stated.
  const mk = findSizingCharts("Michael Kors", "dress")
    .find((c) => c.brand === "Michael Kors" && c.garment.includes("Tops"));
  assert(
    /the opposite of Chanel\/Prada\/Burberry/.test(mk!.note ?? ""),
    "the note names the contrast with the European half of its own group",
  );
});

Deno.test("US-1736: the line hierarchy never changes the SIZE, only the price", () => {
  // A real and easy inference error: the American brands' line hierarchy is the
  // biggest fact on them, so a model can over-apply it and start adjusting the
  // SIZE by line. It doesn't work that way, and the charts say so explicitly.
  const mk = findSizingCharts("Michael Kors", "dress")
    .find((c) => c.brand === "Michael Kors" && c.garment.includes("Tops"));
  assert(
    /the line changes the price, not the fit/.test(mk!.note ?? ""),
    "the MK chart decouples the line from the fit",
  );
  const ks = findSizingCharts("Kate Spade", "dress")
    .find((c) => c.brand === "Kate Spade");
  assert(
    /the LINE changes the price, not the fit/.test(ks!.note ?? ""),
    "the Kate Spade chart decouples the line from the fit",
  );
});
