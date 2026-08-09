// US-2220: verify the western content (migration 00582).
//
// Two things make western its own category, and this file protects both:
//
//   1. WIDTH IS A SIZE, NOT A PREFERENCE. Most footwear resale ignores width —
//      a sneaker is listed as "10" and nobody asks. A western boot is sized on
//      two axes (B / D / EE / EEE), so a boot listed without its width has been
//      half-sized and the buyer cannot infer it. ⚠ And the letter is
//      BRAND-RELATIVE: Ariat runs small and broad, Lucchese large and narrow, so
//      a D from one is not a D from the other.
//   2. AN EXOTIC SKIN IS A LEGAL QUESTION BEFORE IT IS A MATERIAL. Caiman,
//      crocodile, alligator and python are CITES-listed; ostrich generally is
//      not. That makes the skin a listing-compliance fact, the same shape as the
//      real-coyote ruff on a Canada Goose parka (00460) — and it must never be
//      identified from a photograph.
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
    "../../../../supabase/migrations/00582_western_brand_knowledge.sql",
    import.meta.url,
  ),
);

/** See scrubs-uniform-content_test.ts — phrase assertions read this, not SQL. */
// ⚠ The `''` step unescapes SQL's doubled apostrophe: inside a string literal
// `STORY''S` is `STORY'S` in the database, so a matcher reading the raw file
// sees neither form. Same class as the line-wrap problem — the file's ENCODING
// is not its content. PROSE stays a superset of SQL, so this is only ever more
// permissive.
const PROSE = SQL
  .replace(/^\s*--\s?/gm, " ")
  .replace(/''/g, "'")
  .replace(/\s+/g, " ");

Deno.test("US-2220: the western aliases canonicalize", () => {
  for (const brand of ["Ariat", "Justin Boots", "Lucchese"]) {
    assert(isKnownBrand(brand), `${brand} is a curated entry, not a passthrough`);
  }
  assertEquals(canonicalizeBrand("ariat"), "Ariat");
  assertEquals(canonicalizeBrand("lucchese boots"), "Lucchese");
});

Deno.test("US-2220: a bare 'Justin' resolves by TAG but never from prose", () => {
  // A very common given name. The canonical is the long "Justin Boots", so
  // detectBrandInText cannot fire on the first name — the same call made for
  // Hugo Boss, and it needs no exclusion because the canonical is already long.
  assertEquals(canonicalizeBrand("justin"), "Justin Boots", "reachable by tag");
  assertEquals(
    detectBrandInText("Nike tee, gift for Justin, size L"),
    "Nike",
    "a first name in prose must not mint the boot house",
  );
  assertEquals(
    detectBrandInText("Justin Boots square toe, 10D"),
    "Justin Boots",
    "the full name does",
  );
});

Deno.test("US-2220: Stetson is NOT re-seeded — the packs compose", () => {
  // Stetson is one of the four brands this story names for western, and it is
  // already a canonical from 00574's headwear pack. Seeding it again would
  // duplicate a row that already carries the X-rating tell.
  assert(isKnownBrand("Stetson"), "still reachable, from the headwear pack");
  assert(
    !/'stetson',\s*'Stetson'/.test(SQL),
    "and this migration must not seed a second brand_knowledge row for it",
  );
  assert(
    PROSE.includes("STETSON IS ALREADY SEEDED"),
    "the decision is recorded where the next reader will hit it",
  );
});

Deno.test("US-2220: width is seeded as a size axis, and as a RANK not a measurement", () => {
  // The letters are a shared convention, so one chart under a generic key. But
  // no maker publishes the width in inches, so the value is a rank — inventing
  // inches would be exactly the false precision the sizing note warns about.
  assert(
    SQL.includes('{"size":"EEE","measurements":{"width_rank":"4"}}'),
    "the width letters are seeded in order",
  );
  const chart = SQL.slice(SQL.indexOf("Boot widths (letter axis)"));
  const rows = chart.slice(0, chart.indexOf("]$json$"));
  assert(!/"inch|_in"|"length"/.test(rows), "no invented inch measurement");
  assert(
    PROSE.includes("WIDTH IS THE SECOND SIZE AXIS"),
    "and the reason it exists at all is stated",
  );
});

Deno.test("US-2220: the two brands' sizing offsets point OPPOSITE ways", () => {
  // This pair is what makes cross-brand boot conversion impossible, and it is
  // the footwear instance of the brand-kb-sizing-units rule.
  assert(
    PROSE.includes("RUNS ABOUT HALF A SIZE SMALL, AND FITS BROAD"),
    "Ariat's offset is recorded",
  );
  assert(
    PROSE.includes("RUNS ABOUT HALF A SIZE LARGE, AND NARROW"),
    "Lucchese's opposite offset is recorded",
  );
  assert(
    PROSE.includes("a width letter must never be converted between brands"),
    "and the consequence is stated as a rule",
  );
});

Deno.test("US-2220: the offsets are TELLS, not charts", () => {
  // Deliberate: the offsets are consistent across the retail channel but no
  // maker publishes a numeric conversion, so a chart would give them a precision
  // the sourcing does not support.
  const charts = [...SQL.matchAll(/insert into public\.brand_size_charts/gi)];
  assertEquals(charts.length, 1, "exactly one chart — the width axis");
  assert(
    !/'ariat',\s*'Ariat',\s*ARRAY\[\]::text\[\],\s*'Men'/.test(SQL),
    "no per-brand size chart invents a numeric offset",
  );
});

Deno.test("US-2220: an exotic skin is treated as compliance, not decoration", () => {
  assert(
    PROSE.includes("AN EXOTIC SKIN IS A LEGAL QUESTION BEFORE IT IS A MATERIAL"),
    "the framing is stated, not implied",
  );
  // The species split is the actionable part: which are listed and which are not.
  for (const listed of ["caiman", "crocodile", "python"]) {
    assert(PROSE.toLowerCase().includes(listed), `names the CITES species ${listed}`);
  }
  assert(
    PROSE.toLowerCase().includes("ostrich"),
    "and names the common one that generally is NOT listed",
  );
});

Deno.test("US-2220: the pack refuses to give legal advice, and refuses to guess a species", () => {
  // Two separate refusals, and both matter. Whether a shipment is lawful depends
  // on two countries, the species and the paperwork — none of which a grading
  // system can see. And caiman is routinely sold as alligator, so a species
  // claim from a photo is a legal exposure rather than a description error.
  assert(
    PROSE.includes("do NOT tell a seller whether a particular shipment is lawful") ||
      PROSE.includes("Do not advise on whether a shipment is lawful"),
    "it flags, and does not adjudicate",
  );
  assert(
    PROSE.includes("DO NOT IDENTIFY A SKIN FROM A PHOTOGRAPH"),
    "and it refuses to assert a species the seller has not stated",
  );
});

Deno.test("US-2220: construction is recorded as a value fact", () => {
  // A welted boot can be resoled and a cemented one cannot, so identical sole
  // wear is a repair on one and the end of the other. A photo of the upper
  // cannot show it, which is why it has to be asked for.
  assert(PROSE.includes("welted"), "welt construction is named");
  assert(
    PROSE.includes("resoled") || PROSE.includes("resoleable") || PROSE.includes("resole"),
    "and what it means for a worn sole",
  );
});

Deno.test("US-2220: no decoder — the style number is not brand-unique", () => {
  assert(
    !/insert\s+into\s+public\.brand_style_codes/i.test(SQL),
    "bare digit runs and short alphanumerics fail the 00460 bar",
  );
});
