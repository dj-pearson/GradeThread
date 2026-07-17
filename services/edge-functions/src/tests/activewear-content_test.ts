// US-1985: verify the activewear tier-2 content (migration 00465) is correct +
// consumable by the engine.
//
// FIVE OF THE NINE ALREADY CANONICALIZED — 00389 seeded champion/fila/puma/
// reebok/asics as bare stub rows (canonical + one alias, no styles, no charts,
// no tells), so they resolved and then contributed NOTHING. 00465 promotes them
// to full packs and adds the four that were passthrough-only. What the
// assertions below really protect is the four things this group has that no
// prior pack did:
//
//   1. ONE BRAND KEY, TWO SIZING SYSTEMS. Verified below against the shipped
//      table rather than asserted in a comment: before this pack NO brand owned
//      both a Footwear chart and a garment chart. Fila/PUMA/Reebok now do, and
//      category_match is the ONLY thing keeping a hoodie off a shoe chart.
//   2. THE DESIGNED-VS-DAMAGE FACT IS A HOLE IN THE SOLE. On's CloudTec has
//      deliberate voids straight through it, so a new shoe looks worn through to
//      daylight. It must reach the EXTRACT prompt, which means it lives in a
//      FINGERPRINT — the grading block truncates tells at 900 chars (US-1740).
//   3. THE REAL CONDITION AXIS IS INVISIBLE IN A CLEAN PHOTO — foam compression
//      on HOKA/On, pilling and stretch-sheerness on the compressive knits.
//   4. THE BRAND NAME IS A PREPOSITION. "On" is the worst ordinary-word case in
//      the epic and needs BOTH defences (long canonical AND the text exclusion).
//      Asserted empirically, not argued.
//
// ASICS is the only brand here with a decodable code, so it is the only one whose
// block should carry the transcribe-the-code hint — the resolver-side decode
// itself is covered by brand-knowledge-golden.
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
const { normalizeTells } = await import("../lib/brand-authenticity.ts");
const { findSizingCharts, SIZING_CHARTS } = await import(
  "../lib/sizing-charts.ts"
);
const { canonicalizeBrand, isKnownBrand, detectBrandInText } = await import(
  "../lib/brand-normalize.ts"
);
import type {
  BrandKnowledgePack,
  BrandStyleKnowledge,
} from "../lib/brand-knowledge.ts";

const GROUP = [
  "Champion",
  "Fila",
  "PUMA",
  "Reebok",
  "ASICS",
  "On Running",
  "HOKA",
  "Outdoor Voices",
  "Girlfriend Collective",
];

/** The six that sell shoes AND clothes under one name. */
const DUAL_SYSTEM = ["Fila", "PUMA", "Reebok"];

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
): BrandKnowledgePack {
  return {
    brand,
    key,
    known: true,
    aliases: [],
    categoryFocus: ["activewear"],
    authenticationTells: [],
    tagEras: [],
    styles,
    decoders,
    colorways: [],
    sizingCharts: [],
    source: "db",
  };
}

Deno.test("US-1985: the On block says the holes in the sole are the product", () => {
  // THE most expensive error available in this pack, and the footwear mirror of
  // 00464's MOTHER frayed hem. CloudTec pods are hollow, so a BRAND-NEW shoe has
  // large open voids right through the sole and looks worn through to daylight —
  // a grader reading them as damage marks a mint shoe to Poor. It has to reach
  // the extract prompt VERBATIM, which is why it is a fingerprint and not a tell.
  const block = brandPackPromptBlock(
    pack("On Running", "onrunning", [
      style(
        "Cloud 5",
        "Cloud",
        "THE HOLES IN THE SOLE ARE THE PRODUCT. The CloudTec outsole is built from hollow rubber pods, so the shoe HAS LARGE OPEN VOIDS RIGHT THROUGH IT BY DESIGN and a brand-new pair looks worn through to daylight. Grading them as damage marks a mint shoe down to Poor. The designed voids are uniform, clean-edged and IDENTICAL ON BOTH SHOES. The real defects, which DO count: a pod that has COLLAPSED or TORN, and STONES AND DEBRIS wedged inside the pods, which is cleanable.",
        ["CloudTec", "Speedboard"],
      ),
    ]),
  );
  assert(block.includes("Cloud 5"), "names the Cloud 5");
  assert(
    /HOLES IN THE SOLE ARE THE PRODUCT/.test(block),
    "the voids are stated to be designed",
  );
  // The discriminator, not just the warning — a rule the model can actually apply.
  assert(
    /uniform, clean-edged/.test(block),
    "the block gives a way to tell a designed void from damage",
  );
  // And the inverse: real defects must still be gradeable, or the fact overshoots
  // into 'never grade an On'.
  assert(
    /COLLAPSED or TORN/.test(block),
    "the block still names the real defects",
  );
});

Deno.test("US-1985: the HOKA block says the midsole is the product AND the grade", () => {
  // The pack's other half of the same idea, and the one most likely to be missed:
  // the enormous midsole is DESIGN (not swelling), but because the foam IS the
  // product a compressed one is a total loss — and a clean upper hides it.
  const block = brandPackPromptBlock(
    pack("HOKA", "hoka", [
      style(
        "Bondi",
        "Bondi",
        "THE MIDSOLE IS THE PRODUCT AND ALSO THE GRADE. Its deliberately enormous volume is the design, not swelling or delamination; but because the foam IS what the buyer wants, a COMPRESSED midsole is a TOTAL LOSS even when the upper is spotless — and it is nearly invisible in a normal photo. Look at the midsole SIDEWALL side-on: deep horizontal creasing or a collapsed section means the shoe is functionally dead.",
        ["EVA foam", "Meta-Rocker"],
      ),
    ]),
  );
  assert(/enormous volume is the design/.test(block), "the volume is designed");
  assert(
    /COMPRESSED midsole is a TOTAL LOSS/.test(block),
    "compression is stated to be fatal",
  );
  assert(
    /midsole SIDEWALL side-on/.test(block),
    "the block tells the seller WHERE to look for the invisible defect",
  );
});

Deno.test("US-1985: the Champion block carries the Reverse Weave / Powerblend split", () => {
  // The money pair in this pack: same silhouette, same sleeve C, same colours,
  // multiples apart in price. The separator is the SIDE GUSSET and the tag, and a
  // model that reads the sleeve C and stops has identified nothing.
  const block = brandPackPromptBlock(
    pack("Champion", "champion", [
      style(
        "Reverse Weave Hoodie",
        "Reverse Weave",
        "THE READ IS THE SIDE GUSSET, NOT THE LOGO: Reverse Weave is a 1938 CONSTRUCTION in which the fabric grain runs HORIZONTALLY, with a ribbed EXPANSION PANEL running vertically down each side seam. vs the Powerblend hoodie: SAME silhouette, SAME sleeve C logo, NO side gusset, and a fraction of the price. Do not read the side panel as a repair: it is the feature.",
        ["reverse weave"],
      ),
      style(
        "Powerblend Hoodie",
        "Powerblend / Eco",
        "THE DECOY. Powerblend is Champion's ORDINARY cotton-poly sweatshirt: same silhouette as the Reverse Weave, same sleeve C logo, sold at a fraction of the price. THE SEPARATOR IS THE SIDE SEAM: a Powerblend has a plain side seam and NO ribbed expansion gusset. Calling a Powerblend a Reverse Weave overprices it by a multiple.",
        ["cotton blend"],
      ),
    ]),
  );
  assert(/SIDE GUSSET/.test(block), "the gusset is the stated read");
  assert(/THE DECOY/.test(block), "the Powerblend is flagged as the decoy");
  // The gusset must not be mistaken for a defect — it is a vertical seam panel
  // down the side of the garment, which is exactly what a repair looks like.
  assert(
    /not read the side panel as a repair/.test(block),
    "the gusset is stated not to be a repair",
  );
});

Deno.test("US-1985: only ASICS invites a code transcription", () => {
  const block = brandPackPromptBlock(
    pack("ASICS", "asics", [], [{
      decoderKind: "style_number",
      description:
        "ASICS tag-printed article number, on the tongue label beside the size. Eight characters: four digits, one letter, three digits (1011B491).",
      pattern: "^(?<style>\\d{4}[A-Z]\\d{3})(?:-\\d{3})?$",
      extractionRules: {},
      examples: [],
    }]),
  );
  assert(
    /transcribe it VERBATIM/i.test(block),
    "ASICS carries the decoder hint (its code is tag-printed and brand-unique)",
  );

  // The other eight are decoder-less BY DESIGN, and the two pointed refusals are
  // the ones that look decodable: PUMA's six-digit style number (a bare digit
  // run — the Lee 101 rule) and REEBOK's code, which is tag-printed AND regular
  // and still fails because the FORMAT IS ADIDAS'S (they shared a corporate
  // coding system 2006-2021). Reebok is the sharpest refusal in the epic so far:
  // it fails only the third test.
  for (const [brand, key] of [
    ["Champion", "champion"],
    ["Fila", "fila"],
    ["PUMA", "puma"],
    ["Reebok", "reebok"],
    ["On Running", "onrunning"],
    ["HOKA", "hoka"],
    ["Outdoor Voices", "outdoorvoices"],
    ["Girlfriend Collective", "girlfriendcollective"],
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

Deno.test("US-1985: the activewear aliases canonicalize", () => {
  for (const b of GROUP) {
    assert(isKnownBrand(b), `${b} is a curated entry`);
  }

  // The four that were PASSTHROUGH-ONLY before this pack. Without these,
  // canonicalizeBrand passed the seller's own casing ("hoka one one") into the
  // prompt block and the eBay Brand aspect.
  assertEquals(canonicalizeBrand("hoka"), "HOKA");
  assertEquals(canonicalizeBrand("outdoor voices"), "Outdoor Voices");
  assertEquals(canonicalizeBrand("girlfriend collective"), "Girlfriend Collective");
  assertEquals(canonicalizeBrand("on running"), "On Running");

  // THE HOKA RENAME IS A DATE, NOT A SECOND BRAND. HOKA ONE ONE (2009-2021) and
  // HOKA (2021-) are one company; sellers type both, and both must reach ONE row
  // or the brand's comps split in half. (Tested here rather than in the golden
  // set: enrichment only re-brands on a DECODER hit, and HOKA has no decoder —
  // this is an alias-table fact.)
  assertEquals(canonicalizeBrand("hoka one one"), "HOKA");
  assertEquals(canonicalizeBrand("HOKA ONE ONE"), "HOKA");
  assertEquals(canonicalizeBrand("hokaoneone"), "HOKA");

  // The five 00389 STUB rows: they already canonicalized (that is all the stub
  // did), and the aliases the stub never had must now resolve too.
  assertEquals(canonicalizeBrand("champion"), "Champion");
  assertEquals(canonicalizeBrand("reverse weave"), "Champion");
  assertEquals(canonicalizeBrand("fila italia"), "Fila");
  assertEquals(canonicalizeBrand("puma sports"), "PUMA");
  assertEquals(canonicalizeBrand("reeboks"), "Reebok");
  assertEquals(canonicalizeBrand("reebok classic"), "Reebok");
  assertEquals(canonicalizeBrand("asics tiger"), "ASICS");

  // ONITSUKA TIGER MUST NOT FOLD ONTO ASICS. ASICS owns it, but it is a separate
  // CURRENT label with its own tag, its own buyer and its own comps — folding it
  // would retitle a fashion sneaker as ASICS and comp it against a Gel-Kayano.
  // The AGOLDE/Miu Miu rule: a parent company never decides a fold. Passthrough
  // (the seller's own text) is the correct outcome here.
  assert(!isKnownBrand("onitsuka tiger"), "Onitsuka Tiger is not folded onto ASICS");
  assertEquals(canonicalizeBrand("onitsuka tiger"), "onitsuka tiger");

  // A bare "on" resolves by TAG (an exact whole-field lookup) — which is safe,
  // and is the only reason the short form can exist at all.
  assertEquals(canonicalizeBrand("on"), "On Running");
  assertEquals(canonicalizeBrand("ov"), "Outdoor Voices");
  assertEquals(canonicalizeBrand("girlfriend"), "Girlfriend Collective");

  // Neighbouring packs must be undisturbed.
  assertEquals(canonicalizeBrand("nike"), "Nike");
  assertEquals(canonicalizeBrand("adidas"), "adidas");
  assertEquals(canonicalizeBrand("new balance"), "New Balance");
  assertEquals(canonicalizeBrand("under armour"), "Under Armour");
});

Deno.test("US-1985: On Running is never minted out of prose", () => {
  // THE trap this group has to defend against, and it is worse than 00464's
  // "mother of pearl": the brand is literally the preposition "on", and the
  // marketed long form is an ordinary English phrase that running-shoe copy emits
  // constantly. It is the only brand in the KB needing BOTH defences — a long
  // canonical AND the text exclusion.
  //
  // Longest-first ordering is what makes it ACTIVELY HARMFUL rather than merely
  // noisy: "On Running" (10 chars) BEATS a real "Nike" (4) in the same string, so
  // without the exclusion a Nike shoe is mis-branded onto On's ladder. This
  // assertion is empirical — removing "On Running" from DETECT_EXCLUDED_FROM_TEXT
  // turns it red.
  assertEquals(
    detectBrandInText("Nike shoes, great grip on running trails"),
    "Nike",
    "the real brand wins; 'on running trails' must not mint On Running",
  );
  assertEquals(
    detectBrandInText("Comfortable on running days, size 9"),
    null,
    "an ordinary-word brand is never guessed from prose",
  );

  // But it stays fully reachable by TAG — which is what the eBay Brand aspect and
  // the comp filter actually read. Excluding it from prose must not cost the tag
  // path.
  assertEquals(canonicalizeBrand("on running"), "On Running");
  assertEquals(canonicalizeBrand("on"), "On Running");
  assert(isKnownBrand("On Running"), "On Running is a curated entry");

  // The exclusion is narrow: the pack's unambiguous brands are still detected.
  assertEquals(detectBrandInText("HOKA Bondi 8 running shoes size 10"), "HOKA");
  assertEquals(detectBrandInText("ASICS GEL-Kayano 30 mens"), "ASICS");

  // 00464's exclusions must still hold (the set is shared).
  assertEquals(detectBrandInText("Vintage blouse with mother of pearl buttons"), null);
});

Deno.test("US-1985: the group's charts are reachable per brand + system", () => {
  const cases: Array<[string, string, string]> = [
    // apparel
    ["Champion", "hoodie", "Men"],
    ["Champion", "sweatshirt", "Women"],
    ["Outdoor Voices", "legging", "Women"],
    ["Outdoor Voices", "exercise dress", "Women"],
    ["Girlfriend Collective", "legging", "Women"],
    ["Girlfriend Collective", "bra", "Women"],
    // footwear
    ["Fila", "sneaker", "Men"],
    ["Fila", "sneaker", "Women"],
    ["PUMA", "sneaker", "Men"],
    ["PUMA", "sneaker", "Women"],
    ["Reebok", "sneaker", "Men"],
    ["Reebok", "sneaker", "Women"],
    ["ASICS", "sneaker", "Men"],
    ["ASICS", "sneaker", "Women"],
    ["On Running", "sneaker", "Men"],
    ["On Running", "sneaker", "Women"],
    ["HOKA", "sneaker", "Men"],
    ["HOKA", "sneaker", "Women"],
    // the dual-system brands' GARMENT side
    ["Fila", "track jacket", "Unisex"],
    ["PUMA", "track jacket", "Unisex"],
    ["Reebok", "hoodie", "Unisex"],
  ];
  for (const [brand, category, department] of cases) {
    const found = findSizingCharts(brand, category);
    assert(
      found.some((c) => c.brand === brand && c.department === department),
      `${brand} ${department} chart reachable for "${category}"`,
    );
  }

  // Women's-only / apparel-only lines: assert the ABSENCES so a later addition is
  // a deliberate act rather than an accident.
  assert(
    !findSizingCharts("Girlfriend Collective", "legging").some((c) => c.department === "Men"),
    "Girlfriend Collective has no men's chart (it is a women's line)",
  );
  for (const apparelOnly of ["Champion", "Outdoor Voices", "Girlfriend Collective"]) {
    assert(
      !SIZING_CHARTS.some((c) => c.brand === apparelOnly && /Footwear/.test(c.garment)),
      `${apparelOnly} has no footwear chart (it makes no shoes)`,
    );
  }

  // The neighbouring packs must not have been disturbed — none of the nine may
  // bleed onto them.
  for (const brand of ["New Balance", "Vans", "Converse", "UGG"]) {
    const charts = findSizingCharts(brand, "sneaker");
    assert(charts.length > 0, `${brand} still resolves a chart`);
    assert(
      charts.every((c) => c.brand === brand),
      `${brand} resolves only its own charts`,
    );
  }
  for (const brand of ["Lululemon", "Alo Yoga", "Under Armour"]) {
    const charts = findSizingCharts(brand, "legging");
    assert(
      charts.every((c) => !GROUP.includes(c.brand)),
      `${brand} must not resolve an activewear-pack chart`,
    );
  }
});

Deno.test("US-1985: ONE BRAND, TWO SIZING SYSTEMS — the pack's signature problem", () => {
  // THE thing that makes this group different from every pack before it, asserted
  // against the shipped table rather than trusted to a comment.
  //
  // Fila/PUMA/Reebok each own a Footwear chart AND a garment chart under ONE
  // brand, so the same tag's "size" is a STAMPED shoe number or an alpha chest
  // letter depending only on the item — and categoryMatch is the ONLY thing that
  // decides. A miss silently hands a hoodie a shoe chart.
  for (const brand of DUAL_SYSTEM) {
    const mine = SIZING_CHARTS.filter((c) => c.brand === brand);
    assert(
      mine.some((c) => /Footwear/.test(c.garment)),
      `${brand} owns a footwear chart`,
    );
    assert(
      mine.some((c) => !/Footwear/.test(c.garment)),
      `${brand} owns a garment chart`,
    );

    // The separation must actually WORK, in both directions — this is the whole
    // deliverable, and it is what a wrong category token would silently break.
    const shoe = findSizingCharts(brand, "sneaker");
    assert(shoe.length > 0 && shoe.every((c) => /Footwear/.test(c.garment)),
      `${brand} + "sneaker" resolves ONLY footwear charts`);
    const top = findSizingCharts(brand, "hoodie");
    assert(top.length > 0 && top.every((c) => !/Footwear/.test(c.garment)),
      `${brand} + "hoodie" resolves ONLY garment charts`);

    // And the model has to be able to SEE which system it was handed, because the
    // two read in opposite directions (translator vs estimator).
    for (const c of mine) {
      const isShoe = /Footwear/.test(c.garment);
      assert(
        isShoe
          ? /TRANSLATOR/.test(c.note ?? "")
          : /ESTIMATOR/.test(c.note ?? ""),
        `${brand} ${c.garment} note names its system`,
      );
    }
  }

  // categoryMatch is a plain SUBSTRING test (deliberately — "long sleeve
  // tee".includes("tee") is intended), which makes a careless token dangerous:
  // a "boot" token would fire on "bootcut". Guard the invariant directly.
  for (const brand of DUAL_SYSTEM) {
    for (const c of SIZING_CHARTS.filter((x) => x.brand === brand && /Footwear/.test(x.garment))) {
      assert(
        !c.categoryMatch.includes("boot"),
        `${brand} footwear categoryMatch must not carry "boot" (it fires on "bootcut")`,
      );
    }
  }
});

Deno.test("US-1985: a shoe chart is a TRANSLATOR and says the size is stamped", () => {
  // The 00459 rule, re-asserted for this pack's six shoe brands: a garment chart
  // is an ESTIMATOR (measure the chest, double it) but a shoe size CANNOT be
  // measured from a photo — it is STAMPED and must be READ, then converted. So
  // every footwear label carries the full US/UK/EU triple, where the model
  // actually reads it.
  for (const brand of ["Fila", "PUMA", "Reebok", "ASICS", "On Running", "HOKA"]) {
    const charts = findSizingCharts(brand, "sneaker").filter((c) => c.brand === brand);
    assert(charts.length > 0, `${brand} has at least one footwear chart`);
    for (const c of charts) {
      assert(
        /STAMPED/.test(c.note ?? ""),
        `${brand} ${c.department} note says the size is stamped, not measured`,
      );
      for (const r of c.rows) {
        assert(
          /US [MW]?\d/.test(r.size) && /UK /.test(r.size) && /EU /.test(r.size),
          `${brand} ${c.department} row "${r.size}" carries the US/UK/EU triple`,
        );
      }
    }
  }
});

Deno.test("US-1985: the shoe sizing warns in BOTH directions, not one", () => {
  // The group's signature sizing trap: there is NO single "athletic shoes run X"
  // rule, and a reader who applies one is wrong for half the pack. Each note has
  // to name its own direction AND the contrast, or the default silently wins.

  // 1. RUNS SMALL — a Japanese last (ASICS), a narrow Swiss one (On), and PUMA.
  for (const brand of ["ASICS", "On Running", "PUMA"]) {
    const charts = findSizingCharts(brand, "sneaker").filter((c) => c.brand === brand);
    assert(
      charts.some((c) => /RUNS? SMALL/i.test(c.note ?? "")),
      `${brand} carries the runs-small caveat`,
    );
  }
  const asics = findSizingCharts("ASICS", "sneaker").find((c) => c.department === "Men");
  assert(/JAPANESE GRADE/.test(asics!.note ?? ""), "the ASICS note names the mechanism");

  // 2. RUNS LARGE — the Reebok classics, the pack's lone opposite, and its note
  //    must name the contrast with its own group or a reader applies the default.
  const reebok = findSizingCharts("Reebok", "sneaker").find((c) => c.department === "Men");
  assert(/RUN LARGE/.test(reebok!.note ?? ""), "the Reebok classics are stated to run large");
  assert(
    /OPPOSITE TO MOST OF THIS PACK/.test(reebok!.note ?? ""),
    "the Reebok note names the contrast with its own group",
  );

  // 3. And the runs-large fact must NOT leak onto Reebok's APPAREL — it is a
  //    footwear fact about a last, not about a garment block.
  const reebokTop = findSizingCharts("Reebok", "hoodie").find((c) => c.brand === "Reebok");
  assert(
    /does NOT transfer here/.test(reebokTop!.note ?? ""),
    "the Reebok apparel note refuses the footwear brand's runs-large caveat",
  );
});

Deno.test("US-1985: the charts carry the invisible-defect warnings", () => {
  // The facts a clean flat photo actively hides, which is why they belong in the
  // uncapped chart notes (formatSizingChartsForPrompt renders the note IN FULL —
  // the only uncapped channel, US-1740).

  // Foam compression: the shoe is dead while the upper looks new.
  for (const brand of ["HOKA", "ASICS"]) {
    const c = findSizingCharts(brand, "sneaker").find((x) => x.department === "Men");
    assert(
      /COMPRESS|COMPRESSED/.test(c!.note ?? ""),
      `${brand} note warns the midsole compresses`,
    );
  }
  const hoka = findSizingCharts("HOKA", "sneaker").find((c) => c.department === "Men");
  assert(/TOTAL LOSS/.test(hoka!.note ?? ""), "HOKA states compression is fatal");
  // ...and that the shape itself is NOT a defect (the rocker doesn't sit flat).
  assert(/META-ROCKER/.test(hoka!.note ?? ""), "HOKA states the rocker is designed");

  // On: the voids are the product — the chart repeats it because the chart note
  // is uncapped and this is the pack's costliest error.
  const on = findSizingCharts("On Running", "sneaker").find((c) => c.department === "Men");
  assert(
    /HOLES THROUGH THE SOLE ARE THE PRODUCT/.test(on!.note ?? ""),
    "the On chart note repeats the designed-void rule",
  );

  // The compressive knits: pilling + stretch-sheerness, invisible flat.
  for (const brand of ["Outdoor Voices", "Girlfriend Collective"]) {
    const c = findSizingCharts(brand, "legging").find((x) => x.brand === brand);
    assert(/PILLING/.test(c!.note ?? ""), `${brand} note warns about pilling`);
    assert(
      /SHEER WHEN STRETCHED/.test(c!.note ?? ""),
      `${brand} note warns the fabric goes sheer when stretched`,
    );
  }

  // Girlfriend Collective's run is the widest in the KB and that is the brand's
  // point, not a footnote — the letter must never be cross-mapped to a brand that
  // stops at XL.
  const gf = findSizingCharts("Girlfriend Collective", "legging")
    .find((c) => c.brand === "Girlfriend Collective");
  assert(gf!.rows.some((r) => r.size.startsWith("6XL")), "the run reaches 6XL");
  assert(gf!.rows.some((r) => r.size.startsWith("XXS")), "the run starts at XXS");
  assert(
    /NEVER cross-map the letter between brands/.test(gf!.note ?? ""),
    "the note forbids cross-brand letter mapping",
  );
});

Deno.test("US-1985: a short/ordinary brandMatch token is never in the chart table", () => {
  // The US-1735 bug, guarded directly rather than trusted to a comment:
  // findSizingCharts matches brandMatch as a LEADING-word substring, so a bare
  // "on" would hand an Onitsuka Tiger On Running's charts ("on" starts
  // "onitsuka"), and a bare "ov"/"girlfriend" is the "ag"-hands-Patagonia-AG's-
  // charts hazard. All three are alias KEYS only, where an exact whole-field
  // lookup makes them safe.
  const banned = new Set(["on", "ov", "girlfriend", "outdoor", "cloud", "one one"]);
  for (const c of SIZING_CHARTS) {
    for (const m of c.brandMatch) {
      assert(!banned.has(m), `chart ${c.brand} must not carry the brandMatch token "${m}"`);
    }
  }

  // The empirical half: an Onitsuka Tiger must not reach On Running's charts.
  const onitsuka = findSizingCharts("Onitsuka Tiger", "sneaker");
  assert(
    !onitsuka.some((c) => c.brand === "On Running"),
    "Onitsuka Tiger must not resolve On Running's charts",
  );

  // And the brands are still reachable via the canonical, which is what
  // brand-knowledge.ts actually passes.
  for (const brand of ["On Running", "Outdoor Voices", "Girlfriend Collective"]) {
    const charts = findSizingCharts(canonicalizeBrand(brand), brand === "On Running" ? "sneaker" : "legging");
    assert(
      charts.some((c) => c.brand === brand),
      `${brand} resolves its own chart via the canonical`,
    );
  }
});

Deno.test("US-1985: no seeded tell claims a garment can be authenticated", () => {
  // The KB never emits an authentic/fake verdict — that is the US-1767/1768
  // authenticity add-on's job (normalizeTells → getEffectiveTells →
  // ai-authenticity), which is confidence-capped, disclaimer-bounded and routes
  // low confidence to human review BY CONSTRUCTION. It matters on this pack
  // because Champion's vintage tags are a known reproduction trade and PUMA's
  // style number is public — neither is an authentication.
  //
  // These rows use the {tell, detail} shape every brand-group migration has used
  // (00443..00465); coerceTell maps that legacy shape onto claim/check on read.
  const guard = {
    tell: "Never auto-authenticate",
    detail:
      "No serial, date code or published authentication standard exists. Grade condition only; route authenticity to human review.",
  };
  const tells = normalizeTells([
    guard,
    { tell: "A second tell", detail: "some detail" },
  ]);
  assertEquals(tells.length, 2, "both tells normalize");
  assertEquals(tells[0].claim, guard.tell, "the guard's claim survives coercion");
  assertEquals(tells[0].check, guard.detail, "the guard's detail becomes the check");
  assert(
    /human review/i.test(tells[0].check ?? ""),
    "the guard routes authenticity to human review",
  );
});
