// US-2217: style-keyed condition baselines.
//
// ⚠ PREMISE CORRECTION. The story says garment_baselines "is keyed brand+category"
// and needs a style dimension added. It already HAS one: migration 00341 gave the
// table a `style` column and a unique key on (brand, garment_category, style),
// and getGarmentBaseline has always looked up style-first-then-fallback. What was
// missing was the WRITE half — generation ignored the style and the upsert
// hardcoded `style: ""` — plus the grounding, which unioned every style's fabric
// tech into one brief.
//
// The rules under test:
//   1. A named style scopes the grounding to THAT style. Unioning is what made a
//      Barbour brief describe waxed cotton and quilted nylon at once.
//   2. A style-keyed brief is persisted under its style, not into the
//      brand-level slot where a different style would read it as its own.
//   3. The style comes from TRUSTED signals only — never the seller's title.
//   4. No style => byte-identical to the brand+category behaviour.
//
//   deno test --allow-env --allow-read src/tests/garment-baseline-style_test.ts

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  BASELINE_GEN_GROUNDED_VERSION,
  BASELINE_GEN_STYLE_VERSION,
  buildTrustedBrandFactsBlock,
  resolveTrustedStyle,
  styleMatchKey,
} = await import("../lib/garment-baselines.ts");

// The story's motivating case, and a real corpus row (00469): two Barbour
// jackets whose failure modes have nothing in common.
const BARBOUR = {
  brand: "Barbour",
  key: "barbour",
  known: true,
  aliases: [],
  categoryFocus: ["outerwear"],
  authenticationTells: [],
  tagEras: [],
  decoders: [],
  colorways: [],
  sizingCharts: [],
  source: "db" as const,
  styles: [
    {
      styleName: "Bedale",
      aliases: ["bedale jacket"],
      productLine: "Waxed jackets",
      department: "Men",
      category: "jacket",
      visualFingerprint: "Short waxed cotton jacket, two lower bellows pockets, corduroy collar.",
      fabricTech: ["Waxed cotton", "Sylkoil"],
      era: null,
      msrpBand: null,
      keywords: ["bedale"],
    },
    {
      styleName: "Liddesdale",
      aliases: [],
      productLine: "Quilted jackets",
      department: "Men",
      category: "jacket",
      visualFingerprint: "Diamond-quilted nylon shell, snap front, no wax.",
      fabricTech: ["Quilted nylon", "Polyester wadding"],
      era: null,
      msrpBand: null,
      keywords: ["liddesdale"],
    },
  ],
};

// ── 1. Grounding is scoped to the identified style ─────────────────────────

Deno.test("US-2217: with no style, the block still covers the whole brand", () => {
  const block = buildTrustedBrandFactsBlock(BARBOUR);
  // A brand-level brief genuinely has to cover the brand, so the union is
  // correct HERE. It is only wrong once a style is known.
  assertStringIncludes(block, "Waxed cotton");
  assertStringIncludes(block, "Quilted nylon");
  assert(!block.includes("Identified style"));
});

Deno.test("US-2217: a named style scopes the fabric tech to THAT style", () => {
  const block = buildTrustedBrandFactsBlock(BARBOUR, "Bedale");
  assertStringIncludes(block, "Identified style: Bedale");
  assertStringIncludes(block, "Waxed cotton");
  // THE DEFECT THIS FIXES: a Bedale brief must not carry the Liddesdale's
  // materials. Re-waxing is maintenance on one and meaningless on the other.
  assert(
    !block.includes("Quilted nylon"),
    "a style-scoped block must not carry another style's fabric",
  );
  assert(!block.includes("Liddesdale"));
});

Deno.test("US-2217: the other style scopes the other way", () => {
  const block = buildTrustedBrandFactsBlock(BARBOUR, "Liddesdale");
  assertStringIncludes(block, "Quilted nylon");
  assert(!block.includes("Waxed cotton"));
});

Deno.test("US-2217: an unknown style falls back to the brand-level union", () => {
  // Never silently scope to nothing: a style we do not have is the same
  // situation as no style at all.
  const block = buildTrustedBrandFactsBlock(BARBOUR, "Beaufort");
  assertStringIncludes(block, "Waxed cotton");
  assertStringIncludes(block, "Quilted nylon");
  assert(!block.includes("Identified style"));
});

Deno.test("US-2217: style matching ignores case, spacing and punctuation", () => {
  for (const v of ["bedale", "BEDALE", "Be-dale", " Bedale "]) {
    assertStringIncludes(
      buildTrustedBrandFactsBlock(BARBOUR, v),
      "Identified style: Bedale",
    );
  }
  assertEquals(styleMatchKey("ABC Pant"), styleMatchKey("abc-pant"));
});

Deno.test("US-2217: an unknown or empty pack still yields no block", () => {
  assertEquals(buildTrustedBrandFactsBlock(null, "Bedale"), "");
  assertEquals(
    buildTrustedBrandFactsBlock({ ...BARBOUR, known: false }, "Bedale"),
    "",
  );
});

// ── 2. Version attribution ─────────────────────────────────────────────────

Deno.test("US-2217: a style-grounded brief gets its own prompt version", () => {
  // The grading-engine prompt-lifecycle rule: a distinct dynamic-context era
  // needs a distinct suffix or accuracy-tracking cannot separate them.
  assert(BASELINE_GEN_STYLE_VERSION !== BASELINE_GEN_GROUNDED_VERSION);
  assertStringIncludes(BASELINE_GEN_STYLE_VERSION, "+style");
});

// ── 3. The style comes from trusted signals only ───────────────────────────

Deno.test("US-2217: a style code matching a style name resolves it", () => {
  assertEquals(resolveTrustedStyle(BARBOUR.styles, ["Bedale"]), "Bedale");
  assertEquals(resolveTrustedStyle(BARBOUR.styles, ["LIDDESDALE"]), "Liddesdale");
});

Deno.test("US-2217: an alias or keyword resolves too", () => {
  assertEquals(resolveTrustedStyle(BARBOUR.styles, ["bedale jacket"]), "Bedale");
  assertEquals(
    resolveTrustedStyle(BARBOUR.styles, ["MWX0018-BEDALE-01"]),
    "Bedale",
  );
});

Deno.test("US-2217: nothing matching resolves to '' rather than a near-miss", () => {
  // A fuzzy match here silently swaps one garment's factory state for
  // another's, which is worse than having no baseline at all.
  assertEquals(resolveTrustedStyle(BARBOUR.styles, ["Beaufort"]), "");
  assertEquals(resolveTrustedStyle(BARBOUR.styles, ["Bedal"]), "");
  assertEquals(resolveTrustedStyle(BARBOUR.styles, [null, undefined, ""]), "");
  assertEquals(resolveTrustedStyle([], ["Bedale"]), "");
});

Deno.test("US-2217: a very short signal cannot match everything", () => {
  // A 1-2 character token is contained in almost any string; allowing it would
  // let a stray "L" off a size tag pick the Liddesdale brief.
  assertEquals(resolveTrustedStyle(BARBOUR.styles, ["L"]), "");
  assertEquals(resolveTrustedStyle(BARBOUR.styles, ["be"]), "");
});

Deno.test("US-2217: the pipeline feeds the resolver the TAG READ, never the title", () => {
  // The load-bearing safety property. A seller who types "Bedale" onto a
  // quilted Liddesdale would otherwise get a brief saying waxed cotton is
  // expected and re-waxing is maintenance — genuine wear then reads as
  // intentional finish and the grade goes up. Choosing which trusted block is
  // injected is itself a privileged act (US-346), so it takes a trusted input.
  const src = Deno.readTextFileSync(
    new URL("../lib/grading-pipeline.ts", import.meta.url),
  );
  const call = src.slice(
    src.indexOf("resolveTrustedStyle(brandPack.styles"),
    src.indexOf("resolveTrustedStyle(brandPack.styles") + 220,
  );
  assert(call.includes('a.field === "style_code"'), "must resolve from the tag read");
  for (
    const forbidden of ["submission.title", "submission.description", "styleHint"]
  ) {
    assert(
      !call.includes(forbidden),
      `seller field ${forbidden} must not feed the resolver`,
    );
  }
});

// ── 4. Additive ────────────────────────────────────────────────────────────

Deno.test("US-2217: no style leaves the block byte-identical to the brand-level one", () => {
  assertEquals(
    buildTrustedBrandFactsBlock(BARBOUR, ""),
    buildTrustedBrandFactsBlock(BARBOUR),
  );
  assertEquals(
    buildTrustedBrandFactsBlock(BARBOUR, null),
    buildTrustedBrandFactsBlock(BARBOUR),
  );
});

Deno.test("US-2217: the brief is persisted under the style it was generated for", () => {
  // The write-half bug: `style: ""` was hardcoded, so a style-specific brief
  // landed in the brand-level slot and the next garment of a DIFFERENT style
  // read it as its own.
  const src = Deno.readTextFileSync(
    new URL("../lib/garment-baselines.ts", import.meta.url),
  );
  assert(
    !/garment_category: category,\s*\n\s*style: "",/.test(src),
    "the upsert must not hardcode an empty style",
  );
  assert(
    src.includes("_baselineGen.generate(brand, category, style)"),
    "generation must receive the style it is generating for",
  );
});
