// US-2221 AC3: verify the eyewear content (migration 00575).
//
// AC3 is the criterion this pack exists for: "eyewear temple/model codes are
// evaluated against the decoder bar on their merits and seeded as decoders only
// where all three tests pass — with the outcome, either way, recorded". Three
// pass and several fail, and the failures are the more useful half, so this file
// asserts BOTH directions.
//
//   PASS  Ray-Ban RB####, Oakley OO####, Persol PO####[letters] — imprinted on
//         the temple (no tag to cut, no hangtag to lose), regular, and
//         brand-unique because the prefixes are PER-BRAND even though the three
//         houses share one parent.
//   FAIL  RX / OX — the optical prefixes name the CATEGORY (Rx = prescription),
//         not the maker.
//   FAIL  the 58□14 135 size triplet — an industry standard, so it is perfectly
//         regular and identifies nobody.
//   FAIL  Warby Parker frame NAMES — the Rag & Bone "Fit 2" refusal.
//
// The load-bearing safety property is that every pattern is PREFIX-ANCHORED.
// decodeTagCode runs specs inside an already-resolved pack, so a permissive
// [A-Z]{2}\d{4} under the Ray-Ban pack would decode a licensed Luxottica frame
// (Prada PR, Versace VE, Michael Kors MK — all already canonical here) and spell
// "Ray-Ban" over a correct answer, with decoder authority. That is asserted by
// running the seeded patterns against those codes, not by trusting the comment.
import { assert, assertEquals } from "@std/assert";

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { canonicalizeBrand, isKnownBrand, detectBrandInText } = await import(
  "../lib/brand-normalize.ts"
);

const SQL = await Deno.readTextFile(
  new URL(
    "../../../../supabase/migrations/00575_eyewear_brand_knowledge.sql",
    import.meta.url,
  ),
);

/**
 * The migration's PROSE: comment markers stripped, whitespace collapsed.
 *
 * ⚠ PHRASE assertions read THIS; only statement shapes (`insert into …`) read
 * raw `SQL`. Migration headers hard-wrap at ~79 columns, so any phrase worth
 * asserting is one edit away from being split across two `--` lines — which
 * broke a content test three times in one day, every time on a migration that
 * was correct. Rewrapping a comment to satisfy a matcher makes the migration's
 * formatting load-bearing; normalising here makes the test read what a human
 * reads. PROSE is a superset of SQL, so this can only ever be more permissive.
 */
const PROSE = SQL.replace(/^\s*--\s?/gm, " ").replace(/\s+/g, " ");


/** Every `pattern` literal the migration seeds, in file order. */
function seededPatterns(): string[] {
  return [...SQL.matchAll(/^\s+'(\^\(\?<style>[^']+)',$/gm)].map((m) => m[1]);
}

Deno.test("US-2221: the eyewear aliases canonicalize", () => {
  for (const brand of ["Ray-Ban", "Oakley", "Persol", "Warby Parker"]) {
    assert(isKnownBrand(brand), `${brand} is a curated entry, not a passthrough`);
  }
  // brandKey strips the hyphen and the space, so every spelling sellers use
  // lands on the one canonical.
  for (const spelling of ["ray-ban", "Ray Ban", "RayBan", "raybans", "RAY-BAN"]) {
    assertEquals(canonicalizeBrand(spelling), "Ray-Ban", `${spelling} resolves`);
  }
  assertEquals(canonicalizeBrand("warby parker"), "Warby Parker");
  assertEquals(canonicalizeBrand("persol"), "Persol");
});

Deno.test("US-2221: the eyewear alias refusals hold", () => {
  // A bare "RB" is the DECODER PREFIX, not an alias. A two-letter brand key is
  // the worst possible false positive, and the decoder already recovers the
  // brand from RB3025 inside a resolved pack.
  assert(!isKnownBrand("RB"), "a bare 'RB' must not resolve to Ray-Ban");
  assert(!isKnownBrand("OO"), "a bare 'OO' must not resolve to Oakley");
  assert(!isKnownBrand("PO"), "a bare 'PO' must not resolve to Persol");
  // Half a name is not a name.
  assert(!isKnownBrand("Warby"), "a bare 'Warby' must not resolve");
  assert(!isKnownBrand("ray"), "a bare 'ray' is a first name, not the brand");
  // The frame NAMES are styles, not brands — that is the whole Warby refusal.
  for (const name of ["Percey", "Durand", "Haskell"]) {
    assert(
      canonicalizeBrand(name) !== "Warby Parker",
      `${name} is a frame name and must not resolve as the brand`,
    );
  }
});

Deno.test("US-2221 AC3: three decoders are seeded and every one is prefix-anchored", () => {
  const patterns = seededPatterns();
  assertEquals(patterns.length, 3, "exactly three decoders — RB, OO, PO");
  for (const p of patterns) {
    assert(p.startsWith("^(?<style>"), `anchored at the start: ${p}`);
    assert(
      /\^\(\?<style>(RB|OO|PO)/.test(p),
      `the LITERAL prefix is inside the anchor, not a character class: ${p}`,
    );
  }
});

Deno.test("US-2221 AC3: the anchors refuse a sibling brand's code", () => {
  // THE SAFETY PROPERTY, RUN RATHER THAN ASSERTED. Luxottica makes licensed
  // frames for houses already canonical in this KB; a permissive two-letter
  // pattern would decode one and then spell the brand from pack.brand.
  const SIBLINGS = ["PR17WS", "VE4361", "MK2141", "BE4216", "RL8181"];
  for (const raw of seededPatterns()) {
    const re = new RegExp(raw + "$");
    for (const code of SIBLINGS) {
      assert(
        !re.test(code),
        `${raw} must not match the licensed-sibling code ${code}`,
      );
    }
  }

  // And the OPTICAL prefixes, which are refused for a different reason: RX and
  // OX name the prescription CATEGORY, not the maker.
  for (const raw of seededPatterns()) {
    const re = new RegExp(raw + "$");
    for (const optical of ["RX5154", "OX8046"]) {
      assert(!re.test(optical), `${raw} must not match the optical code ${optical}`);
    }
  }
});

Deno.test("US-2221 AC3: the decoders still match the real codes", () => {
  // The complement of the refusals — an anchor that refuses everything is not a
  // decoder, it is a broken regex, and the two tests together are what tell them
  // apart.
  const wanted: Record<string, string[]> = {
    RB: ["RB3025", "RB2140", "RB3016"],
    OO: ["OO9102"],
    PO: ["PO0714S", "PO3092SM"],
  };
  const expected = Object.values(wanted).flat().length;
  let checked = 0;
  for (const raw of seededPatterns()) {
    const prefix = /\^\(\?<style>(RB|OO|PO)/.exec(raw)?.[1] ?? "";
    // ⚠ THIS ASSERTION IS THE POINT, and it was missing in the first draft.
    // Without it, mutating a seeded prefix (OO -> OQ) made the lookup miss, the
    // inner loop ran zero times, and THIS TEST STAYED GREEN while the decoder
    // no longer matched a single real Oakley code. Found by negative
    // verification, not by review: a test that skips silently is worse than one
    // that is absent, because the absent one does not claim coverage.
    assert(
      prefix,
      `a seeded pattern has no recognised brand prefix, so nothing below checks it: ${raw}`,
    );
    const re = new RegExp(raw + "$");
    for (const code of wanted[prefix] ?? []) {
      const m = re.exec(code);
      assert(m, `${raw} must match its own brand's code ${code}`);
      assertEquals(m?.groups?.style, code, "the style group captures the code");
      checked++;
    }
  }
  assertEquals(checked, expected, "every real code above was actually tested");
});

Deno.test("US-2221: the size triplet is refused as a brand signal", () => {
  // Perfectly regular and identifies nobody: lens width, bridge width and temple
  // length in millimetres is an industry standard printed by every maker. It is
  // the frame's SIZE and belongs in a listing; it is never evidence of a brand.
  for (const raw of seededPatterns()) {
    const re = new RegExp(raw + "$");
    for (const size of ["58", "5814135", "58-14-135"]) {
      assert(!re.test(size), `${raw} must not match a size string (${size})`);
    }
  }
  assert(
    PROSE.includes("INDUSTRY STANDARD"),
    "the migration records WHY the size triplet cannot be a decoder",
  );
});

Deno.test("US-2221: no size chart is seeded, and that is the correct answer", () => {
  // The inverse of 00574. A hat's size is a BRAND'S label that has to be looked
  // up, so headwear got five charts. A frame's size is printed on the frame in
  // millimetres, so there is nothing to look up and a chart would be invented.
  assert(
    !/insert\s+into\s+public\.brand_size_charts/i.test(SQL),
    "the eyewear pack must seed no size chart — the frame carries its own measurements",
  );
  assert(
    PROSE.includes("NO brand_size_charts ROWS, DELIBERATELY"),
    "the absence is recorded as a decision, not left to read as an omission",
  );
});

Deno.test("US-2221: prose detection is unchanged for the eyewear brands", () => {
  // None of the four is in DETECT_EXCLUDED_FROM_TEXT, and that was a decision:
  // "Oakley" is the only near-miss (a surname and a city) and the true positive
  // dominates in clothing copy. Pinned so a later exclusion is a deliberate act.
  assertEquals(detectBrandInText("Ray-Ban Aviator RB3025, gold"), "Ray-Ban");
  assertEquals(detectBrandInText("Oakley Holbrook sunglasses"), "Oakley");
  assertEquals(detectBrandInText("Persol 714 folding, havana"), "Persol");
});
