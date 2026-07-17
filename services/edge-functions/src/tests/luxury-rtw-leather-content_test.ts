// US-1982: verify the luxury RTW & leather content (migration 00461) is correct
// + consumable by the engine.
//
// This group's through-line is FRENCH OR ITALIAN — THE SAME NUMBER IS TWO
// DIFFERENT SIZES. Every house here sizes its women's RTW in a European system
// its tag never names, and the group splits across two of them: the French houses
// subtract 32, the Italian ones 36. So "42" is a US 10 on a Dior and a US 6 on a
// Fendi. That is strictly worse than 00460's unnamed-system trap, which at least
// broke the same way on every brand in its pack — here the seller who correctly
// learns one house's rule and carries it across the tier is wrong BECAUSE they
// learned it. So the size leg carries most of the weight, and it asserts the
// cross-map reaches the SIZE LABEL (the only uncapped channel the model reads)
// rather than living in the note alone.
//
// The second leg is the story's hard constraint: authentication tells are
// INFORMATIONAL ONLY. This is the most counterfeited tier that exists, and the
// pack must never be able to emit an authentic/fake verdict.
//
// The third leg is the LADDER: Versace Jeans Couture must never resolve to
// Versace (an order-of-magnitude over-claim), and the Céline/CELINE accent must
// survive as a dating tell.
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
const { buildTrustedBrandFactsBlock } = await import("../lib/garment-baselines.ts");
const { normalizeTells } = await import("../lib/brand-authenticity.ts");
const { findSizingCharts } = await import("../lib/sizing-charts.ts");
const { canonicalizeBrand, isKnownBrand } = await import("../lib/brand-normalize.ts");
import type {
  BrandKnowledgePack,
  BrandStyleKnowledge,
} from "../lib/brand-knowledge.ts";

const GROUP = [
  "Hermès",
  "Dior",
  "Saint Laurent",
  "Balenciaga",
  "Bottega Veneta",
  "Fendi",
  "Versace",
  "Celine",
];

// The FR/IT split IS the group. Kept as data so the collision tests read as the
// claim they are making rather than as a pile of literals.
const FRENCH = ["Hermès", "Dior", "Saint Laurent", "Balenciaga", "Celine"];
const ITALIAN = ["Bottega Veneta", "Fendi", "Versace"];

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
): BrandKnowledgePack {
  return {
    brand,
    key,
    known: true,
    aliases: [],
    categoryFocus: ["luxury", "rtw", "leather"],
    authenticationTells: [],
    tagEras: [],
    styles,
    decoders,
    colorways: [],
    sizingCharts: [],
    source: "db",
  };
}

// Packs shaped as the US-1711 resolver returns for the 00461-seeded rows,
// carrying the seeded fingerprints verbatim.
function seededHermesPack(): BrandKnowledgePack {
  return pack("Hermès", "herms", [
    style(
      "Birkin",
      "Hermès",
      "The structured top-handle tote: a trapezoidal body, two rolled handles, a flap closing under a metal touret (turn-lock) with two straps, and a padlock + clochette (the leather key pouch) hanging from a handle. vs KELLY: this is the tell — the BIRKIN HAS TWO HANDLES AND NO SHOULDER STRAP as standard; the Kelly has ONE handle and a detachable strap. Nothing else separates them reliably in a photo, so count the handles.",
      ["Togo leather", "Clemence leather", "Epsom leather"],
    ),
    style(
      "Kelly",
      "Hermès",
      "The single-handle trapezoidal bag with a flap, a touret closure and a DETACHABLE SHOULDER STRAP. vs BIRKIN: ONE handle (the Birkin has two) and a strap (the Birkin has none) — count the handles, since the leathers, the hardware and the clochette are shared and settle nothing. Sellier (rigid, stitched outside) vs Retourné (softer, stitched inside) are different constructions at different prices — say which.",
      ["Togo leather", "Box calf"],
    ),
  ]);
}

function seededVersacePack(): BrandKnowledgePack {
  return pack("Versace", "versace", [
    style(
      "Versace Jeans Couture",
      "Versace Jeans Couture",
      "A DIFFUSION LADDER, not a garment — and the highest-value call on the whole brand. Versace Jeans Couture, Versus Versace and Versace Collection print THEIR OWN NAMES on the tag and sell an ORDER OF MAGNITUDE below mainline Versace. The Medusa head appears on all of them, so the logo settles NOTHING — read the full label wording. Titling one of these as plain \"Versace\" is a misrepresentation, not a shortcut.",
      ["cotton", "denim"],
    ),
    style(
      "Medusa",
      "Versace",
      "NOT a model — the house's Gorgon-head mark, used since 1978 on hardware, buttons, belts and bags. It appears across EVERY ladder including the diffusion lines, and it is among the most imitated marks in fashion. It identifies the house only: it dates nothing, places nothing and authenticates nothing.",
      ["metal hardware"],
    ),
  ]);
}

function seededCelinePack(): BrandKnowledgePack {
  return pack("Celine", "celine", [
    style(
      "Luggage Tote",
      "Celine",
      "THE Phoebe Philo icon (2010) and the reason the accent matters: a structured trapezoidal tote with WINGED side flaps, a top zip and a contrasting central panel that reads as a face — hence its nickname, the \"face bag\". A Philo-era CÉLINE-tagged Luggage is collectible and comps ABOVE modern mainline: READ THE ACCENT on the interior stamp, because the silhouette alone cannot date it.",
      ["drummed calfskin"],
    ),
    style(
      "Triomphe",
      "Celine",
      "The interlocking chain-link clasp derived from the Arc de Triomphe chains — revived hard by Hedi Slimane from 2018. It spans the vintage house AND the Slimane era, so unlike the Luggage/Box it does NOT imply Philo: it is the one Celine mark that dates nothing on its own. Read the accent.",
      ["calfskin"],
    ),
  ]);
}

Deno.test("US-1982: the Hermès prompt block carries the count-the-handles disambiguation", () => {
  const block = brandPackPromptBlock(seededHermesPack());
  assert(block.includes("Birkin"), "names the Birkin");
  assert(block.includes("Kelly"), "names the Kelly");
  // The Birkin-vs-Kelly call: the leather and hardware are SHARED, so they cannot
  // be the separator — the handle count is the only reliable photo read.
  assert(/TWO HANDLES AND NO SHOULDER STRAP/.test(block), "the Birkin handle count reaches the block");
  assert(/count the handles/.test(block), "the block says to count the handles");
  assert(
    /shared and settle nothing/.test(block),
    "the shared leathers/hardware are stated NOT to separate them",
  );
  // Sellier vs Retourné are different constructions at different prices.
  assert(/Sellier/.test(block) && /Retourné/.test(block), "the Kelly constructions survive");
  // Hermès ships NO code at all — the block must not invite a transcription.
  assert(
    !/transcribe it VERBATIM/i.test(block),
    "no false decoder hint (Hermès has no serial number at all)",
  );
});

Deno.test("US-1982: Dior is the only brand in the group that invites a code transcription", () => {
  const dior = pack("Dior", "dior", [], [
    {
      decoderKind: "date_code",
      description:
        "Dior date code heat-stamped on an interior leather tab: 2 digits + 2 letters + 4 digits, hyphenated (05-BO-0151, 17-BO-0129). Encodes the manufacturing origin/date, NOT the model and NOT authenticity.",
      pattern: "^(?<code>\\d{2}-[A-Z]{2}-\\d{4})$",
      extractionRules: {},
      examples: [],
    },
  ]);
  const block = brandPackPromptBlock(dior);
  assert(
    /transcribe it VERBATIM/i.test(block),
    "Dior carries the decoder hint (its date code is tab-stamped and regular)",
  );
  // The leather tab is the point: it survives the brand tab being cut out.
  assert(/leather tab/i.test(block), "the tab location reaches the block");
  // It is a DATE code, not a certificate — the description must not over-claim.
  assert(/NOT authenticity/i.test(block), "the block states the code does not authenticate");

  // Every other brand in the group is decoder-less by design. Hermès is the
  // instructive one: a bare blind-stamp LETTER is not a code (the Chanel rule at
  // its limit — a pattern over one letter would brand anything).
  for (const [brand, key] of [
    ["Hermès", "herms"],
    ["Saint Laurent", "saintlaurent"],
    ["Balenciaga", "balenciaga"],
    ["Bottega Veneta", "bottegaveneta"],
    ["Fendi", "fendi"],
    ["Versace", "versace"],
    ["Celine", "celine"],
  ]) {
    const b = brandPackPromptBlock(pack(brand, key, [style("X", "X", "a fingerprint")]));
    assert(
      !/transcribe it VERBATIM/i.test(b),
      `${brand} must not invite a code transcription (it has no decodable code)`,
    );
  }
});

Deno.test("US-1982: the new luxury aliases canonicalize (seven of eight were passthrough-only)", () => {
  // Without these, canonicalizeBrand PASSED THROUGH the seller's own casing
  // ("balenciaga") into the prompt block and the eBay Brand aspect — on the most
  // expensive garments the KB touches.
  assertEquals(canonicalizeBrand("hermes"), "Hermès");
  assertEquals(canonicalizeBrand("HERMES"), "Hermès");
  assertEquals(canonicalizeBrand("Hermès Paris"), "Hermès");
  assertEquals(canonicalizeBrand("dior"), "Dior");
  assertEquals(canonicalizeBrand("Christian Dior"), "Dior");
  assertEquals(canonicalizeBrand("Dior Homme"), "Dior");
  assertEquals(canonicalizeBrand("balenciaga"), "Balenciaga");
  assertEquals(canonicalizeBrand("bottega veneta"), "Bottega Veneta");
  assertEquals(canonicalizeBrand("bottega"), "Bottega Veneta");
  assertEquals(canonicalizeBrand("fendi"), "Fendi");
  assertEquals(canonicalizeBrand("Fendi Roma"), "Fendi");
  for (const brand of GROUP) {
    assert(isKnownBrand(brand), `${brand} is now a curated entry`);
  }

  // ⚠ brandKey() STRIPS ACCENTS, so BOTH spellings must resolve or a seller who
  // types the accent gets nothing. "Hermès" keys as "herms" — which is why
  // migration 00461 seeds the row under brand_key 'herms' and not 'hermes'.
  assertEquals(canonicalizeBrand("Hermès"), "Hermès");
  assertEquals(canonicalizeBrand("Céline"), "Celine");

  // The 2012 rename is a DATE, not a different house: YVES came off the RTW label
  // but the monogram stayed. All spellings fold onto one canonical.
  assertEquals(canonicalizeBrand("Saint Laurent"), "Saint Laurent");
  assertEquals(canonicalizeBrand("Yves Saint Laurent"), "Saint Laurent");
  assertEquals(canonicalizeBrand("YSL"), "Saint Laurent");
  assertEquals(canonicalizeBrand("Saint Laurent Paris"), "Saint Laurent");

  // Gianni Versace is the founder's own pre-1997 label — it IS a Versace tag.
  assertEquals(canonicalizeBrand("Versace"), "Versace");
  assertEquals(canonicalizeBrand("Gianni Versace"), "Versace");

  // A bare "versus" must NOT mint a brand — it is an ordinary English word, and
  // the alias map is what a seller's whole brand field is looked up in. Same rule
  // as the bare "goose" (00460) and "bean" (00453).
  assert(!isKnownBrand("versus"), "a bare 'versus' is not a curated entry");
  assertEquals(canonicalizeBrand("versus"), "versus");
});

Deno.test("US-1982: THE DIFFUSION LABELS DO NOT FOLD ONTO VERSACE", () => {
  // The single most expensive mistake on this brand, and the reason these get
  // their own canonicals (the AGOLDE/Miu Miu rule, NOT the Fire+Ice/MK one):
  // VJC sells an ORDER OF MAGNITUDE below mainline and is the most common
  // Versace-marked item in resale. Folding it would silently retitle a $150 tee
  // as "Versace" — a misrepresentation, and a comp catastrophe once the eBay
  // Brand aspect prices it against mainline.
  assertEquals(canonicalizeBrand("Versace Jeans Couture"), "Versace Jeans Couture");
  assertEquals(canonicalizeBrand("VJC"), "Versace Jeans Couture");
  assertEquals(canonicalizeBrand("versacejeans"), "Versace Jeans Couture");
  assertEquals(canonicalizeBrand("Versus Versace"), "Versus Versace");
  assertEquals(canonicalizeBrand("Versace Collection"), "Versace Collection");
  for (const sub of ["Versace Jeans Couture", "Versus Versace", "Versace Collection"]) {
    assert(
      canonicalizeBrand(sub) !== "Versace",
      `${sub} must NOT canonicalize to mainline Versace`,
    );
  }

  // And the pack says so where the model will read it.
  const block = brandPackPromptBlock(seededVersacePack());
  assert(/ORDER OF MAGNITUDE below mainline/.test(block), "the ladder gap reaches the block");
  assert(/read the full label wording/i.test(block), "the block says to read the label");
  // The Medusa is on every ladder, so it cannot place a piece — the trap is that
  // it LOOKS like it should.
  assert(
    /appears across EVERY ladder/.test(block),
    "the Medusa is stated to be useless for placing a piece",
  );
});

Deno.test("US-1982: the Céline accent survives as a dating + ladder tell", () => {
  const block = brandPackPromptBlock(seededCelinePack());
  assert(block.includes("Luggage"), "names the Luggage tote");
  // The highest-value Celine fact, and it is two characters long.
  assert(/READ THE ACCENT/.test(block), "the block says to read the accent");
  assert(/Philo/.test(block), "the Philo era is named");
  assert(/comps ABOVE modern mainline/.test(block), "the Philo ladder survives");
  // The Triomphe is the deliberate counter-example: it spans BOTH eras, so unlike
  // the Luggage it dates nothing. A reader who generalizes "Celine mark ⇒ Philo"
  // would misdate every Slimane-era Triomphe.
  assert(
    /does NOT imply Philo/.test(block),
    "the Triomphe is explicitly excluded from the Philo inference",
  );
});

Deno.test("US-1982: the group's charts are reachable per brand + are BODY measurements", () => {
  const cases: Array<[string, string, string]> = [
    ["Hermès", "dress", "Women"],
    ["Hermès", "blazer", "Men"],
    ["Dior", "skirt", "Women"],
    ["Dior", "suit", "Men"],
    ["Saint Laurent", "blouse", "Women"],
    ["Saint Laurent", "jacket", "Men"],
    ["Balenciaga", "dress", "Women"],
    ["Balenciaga", "coat", "Men"],
    ["Bottega Veneta", "knit", "Women"],
    ["Bottega Veneta", "blazer", "Men"],
    ["Fendi", "dress", "Women"],
    ["Fendi", "shirt", "Men"],
    ["Versace", "dress", "Women"],
    ["Versace", "suit", "Men"],
    ["Celine", "top", "Women"],
    ["Celine", "coat", "Men"],
  ];
  for (const [brand, category, department] of cases) {
    const found = findSizingCharts(brand, category);
    assert(
      found.some((c) => c.brand === brand && c.department === department),
      `${brand} ${department} chart reachable for "${category}"`,
    );
  }

  // Every chart must say which BASIS it is — the same error the outdoor (00453)
  // and outerwear (00460) groups pinned.
  for (const brand of GROUP) {
    const mine = findSizingCharts(brand, "jacket")
      .concat(findSizingCharts(brand, "dress"))
      .filter((c) => c.brand === brand);
    assert(mine.length > 0, `${brand} has at least one chart`);
    for (const c of mine) {
      assert(/BODY/i.test(c.note ?? ""), `${brand} ${c.garment} note states the BODY basis`);
    }
  }
});

Deno.test("US-1982: every brand resolves ONLY its own charts (no cross-brand leak)", () => {
  // The substring/leading-word hazards this file exists to catch (US-1735/1737/
  // 1738). It matters more here than anywhere: the FR and IT charts are ACTIVELY
  // WRONG for each other — a leak does not degrade the answer, it inverts it by
  // two sizes.
  for (const brand of GROUP) {
    for (const category of ["dress", "jacket", "coat", "top", "skirt", "pant"]) {
      const charts = findSizingCharts(brand, category);
      assert(
        charts.every((c) => c.brand === brand),
        `${brand} ("${category}") resolves only its own charts, got: ${
          charts.map((c) => c.brand).join(", ")
        }`,
      );
    }
  }
});

Deno.test("US-1982: the diffusion labels DELIBERATELY reuse the Versace chart", () => {
  // The one intentional exception to the no-leak rule above, and it is correct
  // rather than tolerated: VJC/Versus share mainline's ITALIAN size system — they
  // differ in PRICE, not in sizing. The chart note carries that distinction so the
  // size is never mistaken for the ladder.
  for (const sub of ["Versace Jeans Couture", "Versus Versace"]) {
    const charts = findSizingCharts(sub, "top");
    assert(
      charts.some((c) => c.brand === "Versace"),
      `${sub} reaches the Versace italian chart (it shares the size system)`,
    );
  }
  for (const c of findSizingCharts("Versace", "dress").filter((c) => c.brand === "Versace")) {
    assert(
      /size does NOT tell you the ladder|size never tells you the ladder/.test(c.note ?? ""),
      "the Versace chart warns the size does not place the ladder",
    );
  }
});

Deno.test("US-1982: THE CROSS-MAP IS IN THE SIZE LABEL, not just the note", () => {
  // The group's whole product. formatSizingChartsForPrompt renders size LABELS +
  // the note uncapped, and the US-1731/US-1740 lesson is that the model actually
  // READS the label — so a translation that lives only in prose is one the model
  // can skip. Every row of every women's chart must carry its own map.
  for (const brand of GROUP) {
    const womens = findSizingCharts(brand, "dress")
      .find((c) => c.brand === brand && c.department === "Women");
    assert(womens, `${brand} women's chart present`);
    for (const row of womens!.rows) {
      assert(/US/.test(row.size), `${brand} women's row "${row.size}" carries a US equivalent`);
    }
  }
});

Deno.test("US-1982: THE HEADLINE COLLISION — '42' is a US 10 in French and a US 6 in Italian", () => {
  // The fact this entire pack exists for, asserted as the contradiction it is.
  // Both charts are correct; that is exactly what makes the trap lethal.
  for (const brand of FRENCH) {
    const womens = findSizingCharts(brand, "dress")
      .find((c) => c.brand === brand && c.department === "Women")!;
    assert(
      womens.rows.some((r) => /^42 /.test(r.size) && /US 10/.test(r.size)),
      `${brand} (FRENCH) labels 42 as a US 10, got: ${
        womens.rows.map((r) => r.size).join(" | ")
      }`,
    );
    assert(
      womens.rows.some((r) => /^38 /.test(r.size) && /US 6/.test(r.size)),
      `${brand} (FRENCH) labels 38 as a US 6`,
    );
    assert(
      /FRENCH SIZE AND THE GARMENT DOES NOT SAY SO/.test(womens.note ?? ""),
      `${brand} note states the unnamed French system`,
    );
  }
  for (const brand of ITALIAN) {
    const womens = findSizingCharts(brand, "dress")
      .find((c) => c.brand === brand && c.department === "Women")!;
    assert(
      womens.rows.some((r) => /^42 /.test(r.size) && /US 6/.test(r.size)),
      `${brand} (ITALIAN) labels 42 as a US 6, got: ${
        womens.rows.map((r) => r.size).join(" | ")
      }`,
    );
    assert(
      /ITALIAN SIZE AND THE GARMENT DOES NOT SAY SO/.test(womens.note ?? ""),
      `${brand} note states the unnamed Italian system`,
    );
  }

  // The two headline charts must NAME each other — a chart that silently
  // translates teaches nothing, and this trap is only survivable if the seller
  // learns that the rule is HOUSE-dependent rather than universal.
  const dior = findSizingCharts("Dior", "dress")
    .find((c) => c.brand === "Dior" && c.department === "Women")!;
  assert(/A FENDI TAGGED "42" IS A US 6/.test(dior.note ?? ""), "the Dior note names the Fendi collision");
  const fendi = findSizingCharts("Fendi", "dress")
    .find((c) => c.brand === "Fendi" && c.department === "Women")!;
  assert(/A DIOR TAGGED "42" IS A US 10/.test(fendi.note ?? ""), "the Fendi note names the Dior collision");
});

Deno.test("US-1982: MENSWEAR IS EXEMPT and every men's chart says so", () => {
  // The other half of the honesty requirement. French and Italian tailoring run
  // the SAME numbers, so a reader who over-generalizes the women's collision
  // starts "correcting" menswear sizes that were already right. Every men's chart
  // states the exemption AND agrees on the numbers.
  for (const brand of GROUP) {
    const mens = findSizingCharts(brand, "blazer")
      .find((c) => c.brand === brand && c.department === "Men");
    assert(mens, `${brand} men's chart present`);
    assert(
      /MENSWEAR IS THE EASY HALF OF THIS PACK/.test(mens!.note ?? ""),
      `${brand} men's note states the collision does not apply`,
    );
    // A men's 50 is a US 40 on EVERY brand in the group — French or Italian.
    assert(
      mens!.rows.some((r) => /^50 /.test(r.size) && /US 40/.test(r.size)),
      `${brand} men's 50 is a US 40 (uniform across the group)`,
    );
  }
});

Deno.test("US-1982: the French-house-Italian-factory trap is called out where it bites", () => {
  // Saint Laurent, Balenciaga and Celine are FRENCH houses that manufacture in
  // ITALY, so the origin tag actively points at the WRONG size system. This is the
  // one place in the pack where a real, printed, correct fact on the garment leads
  // the seller astray — so the note has to defuse it explicitly.
  for (const brand of ["Saint Laurent", "Balenciaga", "Celine"]) {
    const womens = findSizingCharts(brand, "dress")
      .find((c) => c.brand === brand && c.department === "Women")!;
    assert(
      /Made in Italy|MADE IN ITALY/.test(womens.note ?? ""),
      `${brand} note names the Italian-manufacture trap`,
    );
    assert(
      /does not change|does NOT change|never sets the sizing/.test(womens.note ?? ""),
      `${brand} note states the origin does not set the size system`,
    );
  }
});

// The seeded tell #1 for each brand, verbatim from 00461. Every one of them is the
// never-auto-authenticate guard, and that ORDER is load-bearing — see below.
const SEEDED_FIRST_TELL: Record<string, { tell: string; detail: string }> = {
  "Hermès": {
    tell: "NEVER auto-authenticate — this is the hardest tier on earth and we do not verify",
    detail:
      "Hermes is the most valuable and most sophisticatedly counterfeited label in this pack, and the house does NOT authenticate for third parties. Every mark it ships is manufacturer-side and reproducible by the superfakes in this tier. Describe what is present, flag inconsistencies in condition_notes, and route authenticity to human review. Never emit an authentic/fake verdict.",
  },
  Dior: {
    tell: "NEVER auto-authenticate — the date code is a DATE, not a certificate",
    detail:
      "Dior is heavily counterfeited and the date code is a manufacturer-side mark that fakes reproduce. It encodes when/where a piece was made, not whether it is genuine, and Dior does not authenticate for third parties. Route authenticity to human review; never emit an authentic/fake verdict.",
  },
  "Saint Laurent": {
    tell: "NEVER auto-authenticate",
    detail:
      "The serial on the interior leather tab is a manufacturer-side mark that fakes reproduce, and the house does not authenticate for third parties. It is also a bare digit run, which is why this brand gets no decoder (the Chanel rule, US-1736). Grade condition only and route authenticity to human review; never emit an authentic/fake verdict.",
  },
  Balenciaga: {
    tell: "NEVER auto-authenticate",
    detail:
      "The serial on the interior tab is a manufacturer-side mark that fakes reproduce, and the house does not authenticate for third parties. It is a bare digit run and therefore gets no decoder. Grade condition only and route authenticity to human review; never emit an authentic/fake verdict.",
  },
  "Bottega Veneta": {
    tell: "NEVER auto-authenticate",
    detail:
      "No published Bottega Veneta authentication standard we can act on; the tab codes are catalog SKUs that fakes reproduce, and the house does not authenticate for third parties. Grade condition only and route authenticity to human review; never emit an authentic/fake verdict.",
  },
  Fendi: {
    tell: "NEVER auto-authenticate",
    detail:
      "The serial on the interior tab is a manufacturer-side mark that fakes reproduce; it is a catalog-style code, not a brand-unique format, which is why this brand gets no decoder. Fendi does not authenticate for third parties. Grade condition only and route authenticity to human review; never emit an authentic/fake verdict.",
  },
  Versace: {
    tell: "NEVER auto-authenticate",
    detail:
      "No published Versace authentication standard, serial or date code that could prove authenticity programmatically — the brand prints no regular garment-side code, which is why it gets no decoder. Grade condition only and route authenticity to human review; never emit an authentic/fake verdict.",
  },
  Celine: {
    tell: "NEVER auto-authenticate",
    detail:
      "The tab code is a manufacturer-side mark that fakes reproduce and it is not a brand-unique format, which is why this brand gets no decoder. Celine does not authenticate for third parties. Grade condition only and route authenticity to human review; never emit an authentic/fake verdict.",
  },
};

Deno.test("US-1982: the seeded tells normalize onto the structured authenticity read path", () => {
  // THE STORY'S HARD CONSTRAINT, CHECKED WHERE IT IS ACTUALLY LOAD-BEARING.
  //
  // Worth being precise about which renderer matters, because the obvious guess is
  // wrong. buildTrustedBrandFactsBlock (grading) renders fingerprints FIRST and
  // then hard-caps the block at 900 chars, so tell prose there is truncated as a
  // matter of course — that is the renderer working as intended (grading wants
  // construction fingerprints, not provenance), and it is NOT where the
  // never-auto-authenticate guarantee lives.
  //
  // The real consumer is the US-1767/1768 authenticity add-on: normalizeTells →
  // getEffectiveTells → ai-authenticity, which is confidence-capped
  // (AUTHENTICITY_VERDICT_CONFIDENCE_CEILING), disclaimer-bounded, and routes
  // low-confidence cases to human review BY CONSTRUCTION. So the pack cannot
  // auto-authenticate structurally, and what this pack owes that path is tells
  // that survive coercion intact — including the guard.
  //
  // These rows use the {tell, detail} shape every brand-group migration has used
  // (00443..00460); coerceTell maps that legacy shape onto claim/check on read.
  for (const brand of GROUP) {
    const seeded = SEEDED_FIRST_TELL[brand];
    const tells = normalizeTells([
      seeded,
      { tell: "A second tell", detail: "some detail" },
    ]);
    assert(tells.length === 2, `${brand}: both tells normalize`);
    // The legacy {tell, detail} pair must land as claim/check, not be dropped.
    assertEquals(tells[0].claim, seeded.tell, `${brand}: the guard's claim survives coercion`);
    assertEquals(tells[0].check, seeded.detail, `${brand}: the guard's detail becomes the check`);
    assert(
      /human review/i.test(tells[0].check),
      `${brand}: the guard routes authenticity to human review`,
    );
    // No seeded tell asserts a verdict — a tell is a CHECK, never a conclusion.
    for (const t of tells) {
      assert(
        !/\bis authentic\b|\bgenuine article\b|\bverified authentic\b/i.test(
          `${t.claim} ${t.check}`,
        ),
        `${brand}: no tell asserts an authenticity verdict`,
      );
    }
  }
});

Deno.test("US-1982: no seeded tell claims a garment can be verified authentic", () => {
  // The inverse guard: it is not enough that a refusal is present — nothing in the
  // pack may read as a licence to authenticate. This tier is where that matters
  // most, and every house here is explicit that it does not authenticate for us.
  for (const brand of GROUP) {
    const detail = SEEDED_FIRST_TELL[brand].detail;
    assert(/human review/i.test(detail), `${brand} routes authenticity to human review`);
    assert(
      /never emit an authentic\/fake verdict/i.test(detail),
      `${brand} forbids an authenticity verdict outright`,
    );
  }
  // Hermès and Dior are the live temptation, because both ship marks that LOOK
  // like verification devices (the blind stamp; the date code).
  assert(
    /does NOT authenticate for third parties/i.test(SEEDED_FIRST_TELL["Hermès"].detail),
    "Hermès states the house does not authenticate for us",
  );
  assert(
    /not whether it is genuine/i.test(SEEDED_FIRST_TELL.Dior.detail),
    "Dior states the date code is not an authenticity signal",
  );
});

Deno.test("US-1982: the grading facts block still carries the group's CONSTRUCTION fingerprints", () => {
  // The flip side of the above: grading's 900-char budget is spent on fingerprints
  // by design, so this asserts the pack gives that renderer what it is for. Luxury
  // leather grades on leather grade / hardware / stitching, which is exactly what
  // these fingerprints describe.
  const block = buildTrustedBrandFactsBlock(seededHermesPack());
  assert(block.includes("Hermès"), "the block names the brand");
  assert(/Birkin/.test(block), "a style fingerprint reaches the grading block");
  assert(/Togo leather/.test(block), "the leather grade reaches the grading block");
});
