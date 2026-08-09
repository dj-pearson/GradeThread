// US-2220: verify the golf content (migration 00583).
//
// Three things this pack has to get right:
//
//   1. ⚠ A CORRECTION TO THE STORY'S OWN PREMISE. US-2220 lists Titleist as a
//      golf apparel brand. It is an EQUIPMENT house — its own range is bags,
//      headwear, travel gear, accessories and gloves, with no polos — so a
//      Titleist item reaching a clothing grader is a cap or a glove. The row is
//      deliberately thin and the thinness is the finding.
//   2. THE LOGO IS PART OF THE ITEM, AND IT IS NOT THE BRAND. A golf polo often
//      carries a club, tournament or corporate logo that is not the maker.
//      Transcribe it; never put it in the brand field.
//   3. WIDTH AGAIN — second footwear category running. And the spike call is the
//      INVERSE of the western-boot sole call: a worn spike is a consumable, a
//      worn cemented boot sole is the end of the boot.
import { assert, assertEquals } from "@std/assert";

Deno.env.set(
  "SUPABASE_URL",
  Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321",
);
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { canonicalizeBrand, isKnownBrand } = await import(
  "../lib/brand-normalize.ts"
);

const SQL = await Deno.readTextFile(
  new URL(
    "../../../../supabase/migrations/00583_golf_brand_knowledge.sql",
    import.meta.url,
  ),
);

/**
 * The migration as a human reads it: comment markers stripped, whitespace
 * collapsed, and SQL-escaped apostrophes unescaped.
 *
 * ⚠ THE THIRD STEP IS NEW AND IT COST A FALSE FAILURE. Inside a SQL string
 * literal an apostrophe is written `''`, so "THIS STORY''S OWN PREMISE" in the
 * migration is "THIS STORY'S OWN PREMISE" in the database — and a matcher
 * reading the raw file sees neither. That is the same class as the line-wrap
 * problem this helper already solved: the file's ENCODING is not the content,
 * and a test that asserts on encoding is asserting on the wrong thing.
 *
 * PROSE stays a superset of SQL, so every step here can only be more permissive.
 */
const PROSE = SQL
  .replace(/^\s*--\s?/gm, " ")
  .replace(/''/g, "'")
  .replace(/\s+/g, " ");

Deno.test("US-2220: the golf aliases canonicalize", () => {
  for (const brand of ["FootJoy", "Greyson Clothiers", "Callaway", "Titleist"]) {
    assert(isKnownBrand(brand), `${brand} is a curated entry, not a passthrough`);
  }
  assertEquals(canonicalizeBrand("fj"), "FootJoy", "the brand's own two-letter mark");
  assertEquals(canonicalizeBrand("greyson"), "Greyson Clothiers");
  assertEquals(canonicalizeBrand("callaway golf"), "Callaway");
});

Deno.test("US-2220: no course or tournament is mapped as a brand", () => {
  // A golf polo's chest logo is frequently a course, a championship or a
  // corporate outing — none of which is the MAKER. Folding one in would put a
  // course in the brand field, mis-file the item and break its comp set. This is
  // the band-tee rule from 00579 in a new costume.
  for (const logo of ["Pebble Beach", "Augusta", "Augusta National", "Ryder Cup", "PGA"]) {
    assert(
      !isKnownBrand(logo),
      `${logo} is a logo on the chest, not the maker on the neck label`,
    );
  }
  assert(
    PROSE.includes("THE LOGO IS NOT THE BRAND"),
    "and the rule is stated where a reader will hit it",
  );
});

Deno.test("US-2220: Titleist is seeded as a correction, not as an apparel line", () => {
  assert(
    PROSE.includes("IT IS AN EQUIPMENT BRAND — EXPECT A HAT OR A GLOVE, NOT A SHIRT"),
    "the expectation is set in a tell",
  );
  assert(
    PROSE.includes("SEEDED AS A CORRECTION TO THIS STORY'S OWN PREMISE"),
    "and the note says why the row is thin",
  );
  // The correction has to be actionable: a Titleist cap grades as headwear.
  assert(
    PROSE.includes("grades as headwear") || PROSE.includes("against the headwear guidance"),
    "and it routes the real case somewhere useful",
  );
});

Deno.test("US-2220: the logo cuts both ways, and no premium is invented", () => {
  // A famous course is why one buyer wants it; a corporate outing narrows the
  // market instead. Both directions belong in the record — and neither gets a
  // number, because no figure for the premium could be sourced.
  assert(PROSE.includes("corporate outing"), "the negative direction is named");
  assert(
    PROSE.includes("MAKES NO CLAIM ABOUT A PREMIUM"),
    "and the pack refuses to invent a multiplier",
  );
  assert(
    !/\b\d+(\.\d+)?x\b|\bpremium of\b|\badds \$/i.test(PROSE),
    "no numeric premium leaked into the prose",
  );
});

Deno.test("US-2220: golf-shoe width is a size, and a RANK not a measurement", () => {
  assert(
    SQL.includes('{"size":"XW","measurements":{"width_rank":"4"}}'),
    "the width letters are seeded in order",
  );
  const chart = SQL.slice(SQL.indexOf("Golf shoe widths (letter axis)"));
  const rows = chart.slice(0, chart.indexOf("]$json$"));
  assert(!/"inch|_in"|"length"/.test(rows), "no invented inch measurement");
});

Deno.test("US-2220: the golf alphabet is NOT the western boot alphabet", () => {
  // N/M/W/XW here, B/D/EE/EEE in 00582. Same idea, different letters, and
  // converting between them would be inventing a fit.
  const chart = SQL.slice(SQL.indexOf("Golf shoe widths (letter axis)"));
  const rows = chart.slice(0, chart.indexOf("]$json$"));
  for (const bootLetter of ['"size":"D"', '"size":"EE"', '"size":"EEE"']) {
    assert(!rows.includes(bootLetter), `${bootLetter} belongs to boots, not golf shoes`);
  }
  assert(
    PROSE.includes("a boot EE is not a golf W"),
    "and the refusal to convert between them is explicit",
  );
});

Deno.test("US-2220: a worn spike is a consumable, and the receptacle is not", () => {
  // The inverse of the western-boot sole call, and the reason it is worth
  // stating: the same-looking photograph grades opposite ways in the two
  // categories.
  assert(
    PROSE.includes("WORN SPIKES ARE A CONSUMABLE, NOT DAMAGE"),
    "the design-vs-defect call is stated",
  );
  assert(
    PROSE.includes("receptacles") || PROSE.includes("RECEPTACLES"),
    "and it names what genuinely does end the shoe",
  );
  // Removing a signal without replacing it leaves the grader blind, so the pack
  // must also say when the paragraph does NOT apply.
  assert(
    PROSE.includes("spikeless"),
    "and it excludes the spikeless case explicitly",
  );
});

Deno.test("US-2220: no decoder is seeded", () => {
  assert(
    !/insert\s+into\s+public\.brand_style_codes/i.test(SQL),
    "nothing here puts a regular, brand-unique code on the garment",
  );
});
