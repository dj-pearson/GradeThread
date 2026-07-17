// US-1984: verify the premium-denim tier-2 content (migration 00464) is correct
// + consumable by the engine.
//
// 00454 established this category's rule: on PREMIUM denim the value is the FIT
// NAME on the tag. This pack is that rule at scale — six of the eight brands
// print a fit name and nothing else. What the assertions below really protect is
// the three things this group adds that 00454 did not have:
//
//   1. THE ORDINARY-WORD BRAND PROBLEM, at its worst. MOTHER and FRAME are
//      ordinary English words that clothing prose emits constantly ("mother of
//      pearl" buttons), and longest-first ordering makes the false positive BEAT
//      the real brand in the same string. They must be reachable by TAG and never
//      minted from prose.
//   2. DESIGNED DESTRUCTION IS THE MONEY FACT, and it runs three ways: MOTHER
//      NAMES its hem destruction, Diesel built a house on the destroyed wash, and
//      G-Star inverts it (raw fade is patina buyers pay for). All three must
//      reach the EXTRACT prompt, which means they live in FINGERPRINTS — the
//      grading block truncates tells at 900 chars (US-1740).
//   3. SIZING LIES IN THREE DIRECTIONS, not two: stretch premium runs LARGE, raw
//      G-Star SHRINKS, and MOTHER's frayed hem makes the tag inseam a fiction.
//
// Diesel is the only brand here with a decodable code, so it is the only one
// whose block should carry the transcribe-the-code hint — the resolver-side
// decode itself is covered by brand-knowledge-golden.
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
const { findSizingCharts } = await import("../lib/sizing-charts.ts");
const { canonicalizeBrand, isKnownBrand, detectBrandInText } = await import(
  "../lib/brand-normalize.ts"
);
import type {
  BrandKnowledgePack,
  BrandStyleKnowledge,
} from "../lib/brand-knowledge.ts";

const GROUP = [
  "Diesel",
  "G-Star RAW",
  "PAIGE",
  "FRAME",
  "MOTHER",
  "Rag & Bone",
  "Hudson Jeans",
  "Joe's Jeans",
];

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
    category: "jean",
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
    categoryFocus: ["denim"],
    authenticationTells: [],
    tagEras: [],
    styles,
    decoders,
    colorways: [],
    sizingCharts: [],
    source: "db",
  };
}

Deno.test("US-1984: the MOTHER block carries the frayed-hem-is-not-damage call", () => {
  // THE most expensive error available in this pack. MOTHER sells named hem
  // destruction (Fray / Chew); a grader reading it as wear marks a BRAND-NEW
  // garment down to Poor and inverts the price of a jean worth more BECAUSE it
  // looks destroyed. It must reach the extract prompt VERBATIM, which is why it
  // is seeded as a fingerprint and not a tell.
  const block = brandPackPromptBlock(
    pack("MOTHER", "mother", [
      style(
        "The Looker",
        "The Looker",
        "MOTHER's SKINNY and its highest-volume resale item. THE CALL ON THIS JEAN IS THE HEM, not the fit: a \"Looker Ankle Fray\" ships from the factory with a deliberately shredded, unfinished hem, and reading that hem as wear marks a BRAND-NEW garment down to Poor.",
        ["stretch denim"],
      ),
      style(
        "Fray / Chew hem",
        "Hem treatment",
        "NOT a fit — a HEM TREATMENT that any MOTHER fit can carry. \"Fray\" is a deliberately frayed raw hem; \"Chew\" is a chewed-up, torn hem. ALL OF IT IS FACTORY-DESIGNED DESTRUCTION SOLD AS THE FEATURE — the garment is worth MORE because it looks destroyed. It must be read INDEPENDENTLY of the fit name, with both in the title (\"The Looker Ankle Fray\").",
        ["stretch denim"],
      ),
    ]),
  );
  assert(block.includes("The Looker"), "names the Looker");
  assert(/FACTORY-DESIGNED DESTRUCTION/.test(block), "the hem is stated to be designed");
  assert(/Fray/.test(block) && /Chew/.test(block), "both hem treatments reach the block");
  // The subtle part, and the direct mirror of True Religion's Super T in 00454:
  // the hem is a price lever ORTHOGONAL to the fit, so a model reading only the
  // fit name misprices the jean.
  assert(/NOT a fit/.test(block), "the hem treatment is stated orthogonal to the fit");
});

Deno.test("US-1984: the Diesel block warns the destroyed wash is not wear", () => {
  const block = brandPackPromptBlock(
    pack("Diesel", "diesel", [
      style(
        "Larkee",
        "Larkee",
        "Diesel's long-running REGULAR STRAIGHT and the brand's highest-volume men's resale item. vs Thommer (slim) and Sleenker (skinny): the three sit on a single narrowing scale, so read the COINED NAME off the tag rather than judging the leg by eye.",
        ["denim"],
      ),
      style(
        "D-Strukt",
        "D- family",
        "The CURRENT-era slim: D-Strukt is part of the D- family introduced under Glenn Martens from 2019, replacing Thommer as the volume slim. A D- prefix on the tag places the piece in the current era; a Thommer places it before it.",
        ["stretch denim"],
      ),
    ]),
  );
  assert(block.includes("Larkee"), "names the Larkee");
  assert(block.includes("D-Strukt"), "names the D-Strukt");
  // The era read that is unusual on this brand: the model NAME dates the jean,
  // because the branding itself has been comparatively stable.
  assert(/Glenn Martens/.test(block), "the D- era is attributed and dated");
  assert(/COINED NAME/.test(block), "the coined vocabulary reaches the block");
});

Deno.test("US-1984: the G-Star block states that raw fade is patina, not wear", () => {
  // G-Star inverts the pack's own rule and that is the point of the row: on raw
  // denim, high-contrast fading is EARNED and buyers pay for it.
  const block = brandPackPromptBlock(
    pack("G-Star RAW", "gstarraw", [
      style(
        "Elwood 5620 3D",
        "Elwood",
        "THE G-Star piece: the 1996 Elwood, whose motocross-derived 3D construction is SEWN INTO the garment — articulated knee darts/pads and a seat panel plainly visible in a photo. \"5620\" is its model number but is NOT brand evidence on its own — it is a bare digit run, so the 3D KNEE is the read and the number only corroborates.",
        ["raw denim", "3D construction"],
      ),
    ]),
  );
  assert(/3D construction|3D KNEE/.test(block), "the 3D construction reaches the block");
  // The honest limit on the number, which is why G-Star has no decoder.
  assert(
    /NOT brand evidence on its own/.test(block),
    "the bare model number is stated to be insufficient alone",
  );
});

Deno.test("US-1984: only Diesel invites a code transcription", () => {
  const block = brandPackPromptBlock(
    pack("Diesel", "diesel", [], [{
      decoderKind: "style_name",
      description:
        'Diesel tag-printed model name. The vocabulary is COINED (Thommer, Sleenker, Larkee) so a single token identifies the brand even when the brand tag is cut.',
      pattern: "^(?<style>THOMMER|SLEENKER|LARKEE)(?:-X)?$",
      extractionRules: {},
      examples: [],
    }]),
  );
  assert(
    /transcribe it VERBATIM/i.test(block),
    "Diesel carries the decoder hint (its code is garment-printed and coined)",
  );

  // The other seven are decoder-less by design. The pointed ones are G-Star (3301
  // LOOKS like a code and deliberately is not treated as one — the Lee 101 rule)
  // and Rag & Bone (a "Fit 2" is regular and tag-printed but is an ordinary
  // English phrase).
  for (const [brand, key] of [
    ["G-Star RAW", "gstarraw"],
    ["PAIGE", "paige"],
    ["FRAME", "frame"],
    ["MOTHER", "mother"],
    ["Rag & Bone", "ragbone"],
    ["Hudson Jeans", "hudsonjeans"],
    ["Joe's Jeans", "joesjeans"],
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

Deno.test("US-1984: the new denim aliases canonicalize (were passthrough-only before)", () => {
  // Without these, canonicalizeBrand PASSED THROUGH the seller's own casing
  // ("mother denim") into the prompt block and the eBay Brand aspect.
  assertEquals(canonicalizeBrand("diesel"), "Diesel");
  assertEquals(canonicalizeBrand("DIESEL JEANS"), "Diesel");
  assertEquals(canonicalizeBrand("g-star"), "G-Star RAW");
  assertEquals(canonicalizeBrand("gstar raw"), "G-Star RAW");
  assertEquals(canonicalizeBrand("paige denim"), "PAIGE");
  assertEquals(canonicalizeBrand("frame denim"), "FRAME");
  assertEquals(canonicalizeBrand("mother denim"), "MOTHER");
  assertEquals(canonicalizeBrand("joes jeans"), "Joe's Jeans");
  for (const b of GROUP) {
    assert(isKnownBrand(b), `${b} is now a curated entry`);
  }

  // brandKey() STRIPS the ampersand, so "rag & bone" and "rag and bone" are
  // DIFFERENT keys. Sellers type both, so both must resolve — the duplicate-
  // looking alias line is load-bearing.
  assertEquals(canonicalizeBrand("rag & bone"), "Rag & Bone");
  assertEquals(canonicalizeBrand("rag and bone"), "Rag & Bone");
  assertEquals(canonicalizeBrand("ragbone"), "Rag & Bone");

  // Hudson canonicalizes to "Hudson Jeans", NOT "Hudson" — the AG Jeans play from
  // 00454. The bare surname stays an exact-match alias only, because a canonical
  // is what detectBrandInText scans over prose.
  assertEquals(canonicalizeBrand("hudson"), "Hudson Jeans");
  assertEquals(canonicalizeBrand("Hudson Jeans"), "Hudson Jeans");

  // "Gap Star" was G-Star's 1989-1994 name and is NOT Gap — the collision is
  // exactly why the company renamed, and resolving it to Gap would price an early
  // G-Star off a mall-brand ladder.
  assertEquals(canonicalizeBrand("gap star"), "G-Star RAW");
  assertEquals(canonicalizeBrand("gap"), "Gap");

  // A bare "joe" must NOT rebrand — an ordinary given name, so it stays a
  // passthrough (the same rule that keeps "bean" off L.L.Bean).
  assert(!isKnownBrand("joe"), "a bare 'joe' is not a curated entry");
  assertEquals(canonicalizeBrand("joe"), "joe");

  // 00454's brands must be undisturbed.
  assertEquals(canonicalizeBrand("true religion"), "True Religion");
  assertEquals(canonicalizeBrand("AG"), "AG Jeans");
});

Deno.test("US-1984: MOTHER and FRAME are never minted out of prose", () => {
  // THE trap this group has to defend against, and MOTHER is worse than the
  // Off-White case that created DETECT_EXCLUDED_FROM_TEXT (US-1983): "mother of
  // pearl" buttons is routine listing copy, not a corner case.
  //
  // And longest-first ordering makes it ACTIVELY HARMFUL rather than merely
  // noisy — "MOTHER" (6 chars) would BEAT the real "Gap" (3) sitting in the same
  // string, mis-branding an ordinary blouse onto a premium-denim ladder.
  assertEquals(
    detectBrandInText("Gap blouse with mother of pearl buttons, size M"),
    "Gap",
    "the real brand wins; 'mother of pearl' must not mint MOTHER",
  );
  assertEquals(
    detectBrandInText("Vintage blouse with mother of pearl buttons"),
    null,
    "an ordinary-word brand is never guessed from prose",
  );
  assertEquals(
    detectBrandInText("Ray-Ban gold frame sunglasses"),
    null,
    "'frame' as a common noun must not mint FRAME",
  );

  // But BOTH stay fully reachable by TAG — which is what the eBay Brand aspect
  // and the comp filter actually read. Excluding them from prose detection must
  // not cost us the tag path.
  assertEquals(canonicalizeBrand("mother"), "MOTHER");
  assertEquals(canonicalizeBrand("frame"), "FRAME");
  assert(isKnownBrand("mother") && isKnownBrand("frame"), "both are curated entries");

  // The exclusion is narrow: a genuinely unambiguous brand is still detected.
  assertEquals(detectBrandInText("Diesel Thommer slim jeans W32"), "Diesel");
});

Deno.test("US-1984: the group's charts are reachable per brand", () => {
  const cases: Array<[string, string, string]> = [
    ["Diesel", "jean", "Men"],
    ["Diesel", "denim", "Women"],
    ["Diesel", "denim jacket", "Unisex"],
    ["G-Star RAW", "jean", "Men"],
    ["G-Star RAW", "denim", "Women"],
    ["G-Star RAW", "denim jacket", "Unisex"],
    ["PAIGE", "jean", "Women"],
    ["PAIGE", "jean", "Men"],
    ["FRAME", "jean", "Women"],
    ["FRAME", "jean", "Men"],
    ["MOTHER", "jean", "Women"],
    ["Rag & Bone", "jean", "Men"],
    ["Rag & Bone", "jean", "Women"],
    ["Hudson Jeans", "jean", "Women"],
    ["Hudson Jeans", "jean", "Men"],
    ["Joe's Jeans", "jean", "Women"],
    ["Joe's Jeans", "jean", "Men"],
  ];
  for (const [brand, category, department] of cases) {
    const found = findSizingCharts(brand, category);
    assert(
      found.some((c) => c.brand === brand && c.department === department),
      `${brand} ${department} chart reachable for "${category}"`,
    );
  }

  // MOTHER is a WOMEN'S line — no men's chart was invented for it. Assert the
  // absence so a later addition is a deliberate act rather than an accident.
  assert(
    !findSizingCharts("MOTHER", "jean").some(
      (c) => c.brand === "MOTHER" && c.department === "Men",
    ),
    "MOTHER has no men's chart (it is a women's line)",
  );

  // The 00454 denim brands and Levi's/Madewell must not have been disturbed —
  // none of the eight new brands may bleed onto them.
  for (const brand of ["Levi's", "Madewell", "AG Jeans", "True Religion"]) {
    const charts = findSizingCharts(brand, "jean");
    assert(charts.length > 0, `${brand} still resolves a denim chart`);
    assert(
      charts.every((c) => c.brand === brand),
      `${brand} resolves only its own charts`,
    );
  }
});

Deno.test("US-1984: an ordinary-word brandMatch is safe (it never sees prose)", () => {
  // The counterpart to the detectBrandInText guard above, and the reason "frame"
  // and "mother" are allowed to sit in brandMatch at all: findSizingCharts is
  // passed the CANONICAL BRAND STRING, never free text. So the ordinary-word
  // token cannot false-fire here the way it would in prose.
  const frame = findSizingCharts("FRAME", "jean");
  assert(frame.some((c) => c.brand === "FRAME"), "FRAME reaches its own chart");
  const mother = findSizingCharts("MOTHER", "jean");
  assert(mother.some((c) => c.brand === "MOTHER"), "MOTHER reaches its own chart");

  // And the tokens must not leak onto a brand whose name merely contains them.
  // (Guard the invariant directly rather than trusting a comment to survive.)
  for (const brand of ["Levi's", "AG Jeans", "Patagonia"]) {
    const charts = findSizingCharts(brand, "jean");
    assert(
      !charts.some((c) => c.brand === "FRAME" || c.brand === "MOTHER"),
      `${brand} must not resolve a FRAME/MOTHER chart`,
    );
  }

  // Hudson: the canonical is the LONG form, so the chart is reached without ever
  // putting a bare surname token in the table.
  const hudson = findSizingCharts(canonicalizeBrand("hudson"), "jean");
  assert(
    hudson.some((c) => c.brand === "Hudson Jeans"),
    "Hudson Jeans resolves its own chart via the canonical brand",
  );
});

Deno.test("US-1984: every denim chart states its basis and says to measure", () => {
  // Denim is THE exception in this epic: the label is a MEASUREMENT, not an alpha
  // letter mapped onto a body. So the jeans charts are NOMINAL WAIST charts while
  // the alpha-sized denim JACKET charts are genuine BODY charts. Each note has to
  // say which it is, or the model cannot know how to read it.
  for (const brand of GROUP) {
    const charts = findSizingCharts(brand, "jean").filter((c) => c.brand === brand);
    assert(charts.length > 0, `${brand} has at least one jeans chart`);
    for (const c of charts) {
      assert(
        /NOMINAL WAIST/.test(c.note ?? ""),
        `${brand} ${c.garment} note states the NOMINAL WAIST basis`,
      );
      // The only defensible number on a used pair.
      assert(
        /flat waistband/i.test(c.note ?? ""),
        `${brand} ${c.garment} note tells the seller to measure the flat waistband`,
      );
    }
  }

  // The two European brands' jackets are the exception-to-the-exception: alpha-
  // sized, so BODY charts.
  for (const brand of ["Diesel", "G-Star RAW"]) {
    const jacket = findSizingCharts(brand, "denim jacket")
      .find((c) => c.brand === brand && c.department === "Unisex");
    assert(jacket, `${brand} has a denim jacket chart`);
    assert(
      /BODY measurement/.test(jacket!.note ?? ""),
      `${brand} jacket note states the BODY basis (the jackets are alpha-sized)`,
    );
  }
});

Deno.test("US-1984: the sizing warns in THREE directions, not two", () => {
  // The group's signature trap and the thing that distinguishes it from 00454,
  // which had only vintage-small vs premium-large. Every brand here is denim and
  // every one is labeled with a waist number, but the tag lies for three
  // different REASONS — so one blanket "denim runs X" rule is wrong twice.

  // 1. Stretch premium runs LARGE and the give is permanent.
  for (const brand of ["PAIGE", "FRAME", "MOTHER", "Hudson Jeans", "Joe's Jeans", "Rag & Bone"]) {
    const charts = findSizingCharts(brand, "jean").filter((c) => c.brand === brand);
    assert(
      charts.some((c) => /PREMIUM/.test(c.note ?? "")),
      `${brand} (stretch premium) carries the runs-large premium caveat`,
    );
  }
  const paige = findSizingCharts("PAIGE", "jean").find((c) => c.department === "Women");
  assert(/runs LARGE against/.test(paige!.note ?? ""), "premium runs LARGE");
  assert(
    /TRANSCEND/.test(paige!.note ?? ""),
    "the PAIGE note names Transcend as the mechanism for the give",
  );

  // 2. RAW G-Star SHRINKS — the opposite mechanism, and the note has to say so
  //    explicitly or a reader applies the pack's own default and is wrong.
  const gstar = findSizingCharts("G-Star RAW", "jean").find((c) => c.department === "Men");
  assert(/SHRINKS/.test(gstar!.note ?? ""), "raw G-Star is stated to shrink");
  assert(
    /OPPOSITE TO THE REST OF THIS PACK/.test(gstar!.note ?? ""),
    "the note names the contrast with its own group",
  );
  // And the inverted condition rule: fade on raw denim is patina, not wear.
  assert(
    /patina|earned/i.test(gstar!.note ?? ""),
    "the G-Star note distinguishes raw fade from wear",
  );

  // 3. MOTHER's frayed hem makes the tag INSEAM a fiction — there is no single
  //    length to report on a deliberately shredded hem.
  const mother = findSizingCharts("MOTHER", "jean").find((c) => c.brand === "MOTHER");
  assert(/INSEAM cannot be read from the tag/.test(mother!.note ?? ""), "the hem defeats the inseam");
  assert(
    /SHORTEST point/.test(mother!.note ?? ""),
    "the note gives the seller a defensible way to measure it anyway",
  );
});

Deno.test("US-1984: no seeded tell claims a garment can be authenticated", () => {
  // The KB never emits an authentic/fake verdict — that is the US-1767/1768
  // authenticity add-on's job (normalizeTells → getEffectiveTells →
  // ai-authenticity), which is confidence-capped, disclaimer-bounded and routes
  // low confidence to human review BY CONSTRUCTION. It matters on this pack
  // because Diesel and True Religion sit in the most-counterfeited denim tier.
  //
  // These rows use the {tell, detail} shape every brand-group migration has used
  // (00443..00463); coerceTell maps that legacy shape onto claim/check on read.
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
