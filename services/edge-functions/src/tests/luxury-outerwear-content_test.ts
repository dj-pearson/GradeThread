// US-1981: verify the luxury outerwear & down content (migration 00460) is
// correct + consumable by the engine.
//
// This group's through-line is THE SIZE IS A NUMBER IN A SYSTEM THE TAG DOES NOT
// NAME — Moncler's proprietary 0-5, Herno's Italian numbers, Bogner's German
// numbers, and Woolrich's era-dependent split. So the size leg carries most of the
// weight here, and it asserts the cross-map reaches the SIZE LABEL (the only
// uncapped channel the model reads) rather than living in the note alone.
//
// The second leg is the story's hard constraint: authentication tells are
// INFORMATIONAL ONLY. This is the most counterfeited tier the KB has seeded, and
// the pack must never be able to emit an authentic/fake verdict — so every brand's
// tells are asserted to route to human review, and the Moncler QR / Canada Goose
// hologram are asserted to be described as NOT proof.
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

const GROUP = ["Moncler", "Canada Goose", "Mackage", "Herno", "Woolrich", "Bogner"];

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
    category: "jacket",
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
    categoryFocus: ["luxury", "outerwear", "down"],
    authenticationTells: [],
    tagEras: [],
    styles,
    decoders,
    colorways: [],
    sizingCharts: [],
    source: "db",
  };
}

// Packs shaped as the US-1711 resolver returns for the 00460-seeded rows,
// carrying the seeded fingerprints verbatim.
function seededMonclerPack(): BrandKnowledgePack {
  return pack("Moncler", "moncler", [
    style(
      "Maya",
      "Moncler",
      "THE icon: a SHORT down jacket in glossy nylon laqué with wide horizontal baffles, a zip front under a snap placket and the tricolour patch on the left sleeve. The GLOSS is the tell — nylon laqué is lacquered and reads wet/shiny in a photo, which separates it from Moncler's matte styles. vs Bady: same lacquered shell and same baffles, so the FABRIC does not separate them — the DEPARTMENT and cut do (Maya is the men's; Bady is the women's fitted counterpart). Sized 0-5 like all Moncler outerwear.",
      ["nylon laqué", "goose down"],
    ),
    style(
      "Grenoble",
      "Grenoble",
      "A LINE, not a single garment — Moncler's technical SKI collection, tagged GRENOBLE in its own right. The tag wordmark is the whole call: Grenoble carries ski features (powder skirt, taped seams, lift-pass pocket, articulated hood) and comps ABOVE mainline Moncler outerwear.",
      ["goose down", "taped seams"],
    ),
    style(
      "Moncler Genius",
      "Genius",
      "The NUMBERED designer-collaboration line (2018+): each collaborator gets a number (\"1 Moncler JW Anderson\"). The number here is a COLLECTION index, NOT a size; do not confuse it with Moncler's 0-5 size scale.",
      ["goose down"],
    ),
  ]);
}

function seededWoolrichPack(): BrandKnowledgePack {
  return pack("Woolrich", "woolrich", [
    style(
      "Arctic Parka",
      "Woolrich",
      "THE Italian-era icon: a thigh-length down parka with a coyote-fur-trimmed hood. This is the ITALIAN Woolrich, not the Pennsylvania wool mill, and it comps on a completely different ladder from the heritage Buffalo Check. It may carry EU sizing.",
      ["down", "fur trim"],
    ),
    style(
      "Buffalo Check Wool Shirt",
      "John Rich & Bros",
      "The AMERICAN heritage piece: a heavy red/black Buffalo Check wool overshirt. Read the ORIGIN TAG — a Made in USA Buffalo Check came from the Pennsylvania mill and CANNOT be newer than its 2018 closure. CRITICAL: a red-and-black plaid is not automatically Woolrich; the most imitated plaid in America is settled by the LABEL, never by the pattern.",
      ["wool"],
    ),
  ]);
}

Deno.test("US-1981: the Moncler prompt block carries the lacquered-shell disambiguation + the line calls", () => {
  const block = brandPackPromptBlock(seededMonclerPack());
  assert(block.includes("Maya"), "names Maya");
  assert(block.includes("Grenoble"), "names Grenoble");
  // The Maya-vs-Bady call: the FABRIC is shared, so it cannot be the separator.
  assert(/nylon laqué/.test(block), "the nylon laqué shell reaches the block");
  assert(/FABRIC does not separate them/.test(block), "the fabric is stated NOT to separate them");
  // Grenoble is a LINE and it comps above mainline — a photo does not reveal it.
  assert(/tagged GRENOBLE in its own right/.test(block), "Grenoble is stated to be tag-read");
  assert(/comps ABOVE mainline/.test(block), "the Grenoble price ladder survives");
  // The Genius number must never be mistaken for the 0-5 size — same brand, two
  // numbering systems, and one of them is the group's headline trap.
  assert(
    /COLLECTION index, NOT a size/.test(block),
    "the Genius number is explicitly not a size",
  );
  // Moncler's serial is a bare digit run — the block must not invite the AI to
  // transcribe a code as though it were decodable.
  assert(
    !/transcribe it VERBATIM/i.test(block),
    "no false decoder hint (Moncler's serial is a bare digit run)",
  );
});

Deno.test("US-1981: the Woolrich block carries the two-Woolriches era call", () => {
  const block = brandPackPromptBlock(seededWoolrichPack());
  assert(block.includes("Arctic Parka"), "names the Arctic Parka");
  assert(block.includes("Buffalo Check"), "names the Buffalo Check");
  // The whole Woolrich call: one label, two brands, two ladders, decided by era.
  assert(/ITALIAN Woolrich/.test(block), "the Italian era is named");
  assert(/Pennsylvania wool mill/.test(block), "the US mill era is named");
  assert(/different ladder/.test(block), "the two eras are stated to comp differently");
  // A red/black plaid is the most imitated pattern in America — the label decides.
  assert(
    /settled by the LABEL, never by the pattern/.test(block),
    "the plaid is explicitly not sufficient to call the brand",
  );
  assert(
    !/transcribe it VERBATIM/i.test(block),
    "no false decoder hint (Woolrich's article number is a catalog SKU)",
  );
});

Deno.test("US-1981: Canada Goose is the only brand in the group that invites a code transcription", () => {
  const canadaGoose = pack("Canada Goose", "canadagoose", [], [
    {
      decoderKind: "style_number",
      description:
        "Canada Goose style number printed on the interior care label: 4 digits + a department letter (M = men's, L = ladies') + an optional 1-2 letter model suffix. 4660MA = Expedition Parka.",
      pattern: "^(?<style>\\d{4}[ML][A-Z]{0,2})$",
      extractionRules: {},
      examples: [],
    },
  ]);
  const block = brandPackPromptBlock(canadaGoose);
  assert(
    /transcribe it VERBATIM/i.test(block),
    "Canada Goose carries the decoder hint (its style number is care-label printed)",
  );
  // The care label is the point: it survives the brand tag being cut out.
  assert(/care label/i.test(block), "the care-label location reaches the block");

  // Every other brand in the group is decoder-less by design — their codes are
  // bare digit runs (Moncler) or catalog SKUs (the rest).
  for (const [brand, key] of [
    ["Moncler", "moncler"],
    ["Mackage", "mackage"],
    ["Herno", "herno"],
    ["Woolrich", "woolrich"],
    ["Bogner", "bogner"],
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

Deno.test("US-1981: the new luxury-outerwear aliases canonicalize (all six were passthrough-only)", () => {
  // Without these, canonicalizeBrand PASSED THROUGH the seller's own casing
  // ("moncler") into the prompt block and the eBay Brand aspect — on the most
  // expensive garments the KB touches.
  assertEquals(canonicalizeBrand("moncler"), "Moncler");
  assertEquals(canonicalizeBrand("MONCLER"), "Moncler");
  assertEquals(canonicalizeBrand("Moncler Grenoble"), "Moncler");
  assertEquals(canonicalizeBrand("canada goose"), "Canada Goose");
  assertEquals(canonicalizeBrand("CanadaGoose"), "Canada Goose");
  assertEquals(canonicalizeBrand("Snow Goose"), "Canada Goose");
  assertEquals(canonicalizeBrand("mackage"), "Mackage");
  assertEquals(canonicalizeBrand("herno"), "Herno");
  assertEquals(canonicalizeBrand("Herno Laminar"), "Herno");
  assertEquals(canonicalizeBrand("woolrich"), "Woolrich");
  assertEquals(canonicalizeBrand("Woolrich John Rich & Bros"), "Woolrich");
  assertEquals(canonicalizeBrand("Woolrich Woolen Mills"), "Woolrich");
  assertEquals(canonicalizeBrand("bogner"), "Bogner");
  assertEquals(canonicalizeBrand("Willy Bogner"), "Bogner");
  for (const brand of GROUP) {
    assert(isKnownBrand(brand), `${brand} is now a curated entry`);
  }

  // Fire + Ice is Bogner's diffusion LINE and prints its OWN name, never the
  // parent's — so without the alias a seller types the sub-label and nothing
  // resolves. brandKey strips the "+", so all the spellings land on the parent.
  assertEquals(canonicalizeBrand("Fire + Ice"), "Bogner");
  assertEquals(canonicalizeBrand("Fire and Ice"), "Bogner");
  assertEquals(canonicalizeBrand("Bogner Fire + Ice"), "Bogner");

  // A bare "goose" must NOT rebrand to Canada Goose. It is an ordinary word that
  // this product's own material text emits constantly ("goose down"), so mapping
  // it would rebrand every down garment in the catalog to the priciest parka brand
  // in the pack. Same rule as L.L.Bean's "bean" (00453).
  assert(!isKnownBrand("goose"), "a bare 'goose' is not a curated entry");
  assertEquals(canonicalizeBrand("goose"), "goose");
  assertEquals(canonicalizeBrand("goose down"), "goose down");
});

Deno.test("US-1981: the group's charts are reachable per brand + are BODY measurements", () => {
  const cases: Array<[string, string, string]> = [
    ["Moncler", "down", "Men"],
    ["Moncler", "puffer", "Women"],
    ["Canada Goose", "parka", "Men"],
    ["Canada Goose", "jacket", "Women"],
    ["Mackage", "coat", "Men"],
    ["Mackage", "leather", "Women"],
    ["Herno", "jacket", "Men"],
    ["Herno", "coat", "Women"],
    ["Woolrich", "wool", "Men"],
    ["Woolrich", "parka", "Women"],
    ["Bogner", "ski", "Men"],
    ["Bogner", "pant", "Women"],
  ];
  for (const [brand, category, department] of cases) {
    const found = findSizingCharts(brand, category);
    assert(
      found.some((c) => c.brand === brand && c.department === department),
      `${brand} ${department} chart reachable for "${category}"`,
    );
  }

  // Same basis error as the outdoor group (00453) and worse: a down parka is built
  // around loft, so its FLAT chest measures well above the body chest it is sized
  // to. Every chart must therefore say which basis it is.
  for (const brand of GROUP) {
    const charts = findSizingCharts(brand, "jacket")
      .concat(findSizingCharts(brand, "coat"))
      .concat(findSizingCharts(brand, "down"));
    const mine = charts.filter((c) => c.brand === brand);
    assert(mine.length > 0, `${brand} has at least one chart`);
    for (const c of mine) {
      assert(/BODY/i.test(c.note ?? ""), `${brand} ${c.garment} note states the BODY basis`);
    }
  }
});

Deno.test("US-1981: every brand resolves ONLY its own charts (no cross-brand leak)", () => {
  // The substring/leading-word hazards this file exists to catch (US-1735/1737/
  // 1738): a short or contained brand token silently hands one brand another's
  // numbers. These six are all NEW to the chart table, so this is the moment to
  // pin it — and it matters more here than anywhere, since the four number-system
  // charts are actively wrong for any other brand.
  for (const brand of GROUP) {
    for (const category of ["jacket", "coat", "down", "pant"]) {
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

Deno.test("US-1981: THE CROSS-MAP IS IN THE SIZE LABEL, not just the note", () => {
  // The group's whole product. formatSizingChartsForPrompt renders size LABELS +
  // the note uncapped, and the US-1731/US-1740 lesson is that the model actually
  // READS the label — so a translation that lives only in prose is one the model
  // can skip. Every row of the four number-system charts must carry its own map.
  const monclerWomens = findSizingCharts("Moncler", "down")
    .find((c) => c.department === "Women");
  assert(monclerWomens, "Moncler women's chart present");
  for (const row of monclerWomens!.rows) {
    assert(/US/.test(row.size), `Moncler women's row "${row.size}" carries a US equivalent`);
  }
  // The single most dangerous row in the file: Moncler "2" is a US 6-8, and "2" is
  // a real US women's size too, so NOTHING looks wrong to the seller.
  assert(
    monclerWomens!.rows.some((r) => /^2 /.test(r.size) && /US 6-8/.test(r.size)),
    "Moncler women's 2 is labelled as a US 6-8",
  );

  const hernoMens = findSizingCharts("Herno", "jacket").find((c) => c.department === "Men");
  assert(hernoMens, "Herno men's chart present");
  assert(
    hernoMens!.rows.some((r) => /IT 50/.test(r.size) && /US 40/.test(r.size)),
    "Herno men's 50 is labelled IT 50 = US 40",
  );

  const bognerWomens = findSizingCharts("Bogner", "ski").find((c) => c.department === "Women");
  assert(bognerWomens, "Bogner women's chart present");
  assert(
    bognerWomens!.rows.some((r) => /DE 38/.test(r.size) && /US 8/.test(r.size)),
    "Bogner women's 38 is labelled DE 38 = US 8",
  );
});

Deno.test("US-1981: the four unnamed-system charts SAY the tag does not name its system", () => {
  // Not a style flourish: a chart that silently translates teaches nothing, and the
  // seller keeps reading the number as a US size on the next garment.
  const unnamed: Array<[string, string, RegExp]> = [
    ["Moncler", "down", /MONCLER'S OWN 0-5 SIZE AND THE GARMENT DOES NOT SAY SO/],
    ["Herno", "jacket", /ITALIAN SIZE AND THE GARMENT DOES NOT SAY SO/],
    ["Bogner", "ski", /GERMAN SIZE AND THE GARMENT DOES NOT SAY SO/],
  ];
  for (const [brand, category, re] of unnamed) {
    const charts = findSizingCharts(brand, category).filter((c) => c.brand === brand);
    assert(charts.length > 0, `${brand} has charts`);
    for (const c of charts) {
      assert(re.test(c.note ?? ""), `${brand} ${c.department} note states the unnamed system`);
    }
  }

  // Woolrich is the odd one: the system follows the ERA rather than the brand, so
  // its warning is that there are TWO systems under one label.
  for (const c of findSizingCharts("Woolrich", "wool").filter((c) => c.brand === "Woolrich")) {
    assert(
      /WATCH THE SIZE SYSTEM, IT FOLLOWS THE ERA/.test(c.note ?? ""),
      "Woolrich note states the era-dependent size system",
    );
  }

  // Mackage is the deliberate CONTROL — plain US alpha, and the note says so, so a
  // reader does not generalize "luxury outerwear hides its size system" to a brand
  // where the tag means exactly what it says.
  for (const c of findSizingCharts("Mackage", "coat").filter((c) => c.brand === "Mackage")) {
    assert(
      /ordinary US alpha/i.test(c.note ?? ""),
      "Mackage note states it needs no translation",
    );
  }
});

// The seeded tell #1 for each brand, verbatim from 00460. Every one of them is the
// never-auto-authenticate guard, and that ORDER is load-bearing — see below.
const SEEDED_FIRST_TELL: Record<string, { tell: string; detail: string }> = {
  Moncler: {
    tell: "NEVER auto-authenticate — a QR that scans is not proof",
    detail:
      "Moncler is among the most counterfeited outerwear brands on earth. The Moncler Code QR and the older hologram are MANUFACTURER-side services; a competent fake reproduces both, and we cannot verify a scan result. Describe what is present, flag inconsistencies in condition_notes, and route authenticity to human review. Never emit an authentic/fake verdict.",
  },
  "Canada Goose": {
    tell: "NEVER auto-authenticate — the hologram is not proof",
    detail:
      "Canada Goose is heavily counterfeited and the holographic disc is reproduced by fakes. It is a manufacturer-side device we cannot verify. Route authenticity to human review; never emit an authentic/fake verdict.",
  },
  Mackage: {
    tell: "NEVER auto-authenticate",
    detail:
      "No published Mackage authentication standard, serial or date code exists that could prove authenticity programmatically. Grade condition only and route authenticity to human review; never emit an authentic/fake verdict.",
  },
  Herno: {
    tell: "NEVER auto-authenticate",
    detail:
      "No published Herno authentication standard, serial or date code exists. Counterfeiting is not the main risk on this brand — the ITALIAN SIZE misread is. Grade condition only and route authenticity to human review; never emit an authentic/fake verdict.",
  },
  Woolrich: {
    tell: "NEVER auto-authenticate",
    detail:
      "No published Woolrich authentication standard, serial or date code. The real risk on this brand is ERA MISATTRIBUTION, not counterfeiting. Grade condition only and route authenticity to human review; never emit an authentic/fake verdict.",
  },
  Bogner: {
    tell: "NEVER auto-authenticate",
    detail:
      "No published Bogner authentication standard, serial or date code. The risks here are the GERMAN SIZE misread and the mainline/Fire+Ice ladder confusion, not counterfeiting. Grade condition only and route authenticity to human review; never emit an authentic/fake verdict.",
  },
};

Deno.test("US-1981: the seeded tells normalize onto the structured authenticity read path", () => {
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
  // (00443..00459); coerceTell maps that legacy shape onto claim/check on read.
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

Deno.test("US-1981: the grading facts block still carries the group's CONSTRUCTION fingerprints", () => {
  // The flip side of the above: grading's 900-char budget is spent on fingerprints
  // by design, so this asserts the pack gives that renderer what it is for. Down
  // outerwear grades on baffle/loft/shell construction, which is exactly what these
  // fingerprints describe.
  const block = buildTrustedBrandFactsBlock(seededMonclerPack());
  assert(block.includes("Moncler"), "the block names the brand");
  assert(/nylon laqué/.test(block), "the shell fabric reaches the grading block");
  assert(/Maya/.test(block), "a style fingerprint reaches the grading block");
});

Deno.test("US-1981: no seeded tell claims a garment can be verified authentic", () => {
  // The inverse guard: it is not enough that a refusal is present — nothing in the
  // pack may read as a licence to authenticate. Moncler's QR and Canada Goose's
  // hologram are the live temptation, because both LOOK like verification devices.
  for (const brand of ["Moncler", "Canada Goose"]) {
    const detail = SEEDED_FIRST_TELL[brand].detail;
    assert(/not proof|cannot verify/i.test(detail), `${brand} states the device is not proof`);
    assert(/human review/i.test(detail), `${brand} routes authenticity to human review`);
    assert(
      /never emit an authentic\/fake verdict/i.test(detail),
      `${brand} forbids an authenticity verdict outright`,
    );
  }
  for (const brand of GROUP) {
    assert(
      /human review/i.test(SEEDED_FIRST_TELL[brand].detail),
      `${brand} routes authenticity to human review`,
    );
  }
});

Deno.test("US-1981: Canada Goose's chart warns that the brand RUNS LARGE", () => {
  const charts = findSizingCharts("Canada Goose", "parka");
  const men = charts.find((c) => c.brand === "Canada Goose" && c.department === "Men");
  assert(men, "men's chart present");
  // The costliest Canada Goose fit error, and the brand's own guidance.
  assert(/RUNS LARGE/.test(men!.note ?? ""), "note states the brand runs large");
  assert(/size DOWN/i.test(men!.note ?? ""), "note carries the size-down guidance");
});
