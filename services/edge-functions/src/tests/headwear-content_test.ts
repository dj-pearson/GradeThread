// US-2221: verify the headwear content (migration 00574) is correct and
// consumable by the engine.
//
// New Era, Stetson, Kangol and Goorin Bros. were ABSENT from the KB entirely —
// no brand_knowledge row, no alias, no chart. What the assertions below protect
// are the three things this group has that no prior pack did, and they all fall
// out of one category shift:
//
//     A HAT IS SIZED IN A UNIT THE REST OF THIS KB DOES NOT CARRY.
//
//   1. THE CHARTS ARE IN HEAD CIRCUMFERENCE, not chest/waist/bust, and their
//      LABELS are eighth-inch hat sizes or alpha bands rather than apparel sizes.
//   2. THE UNITS DISAGREE ACROSS BRANDS. New Era prints 22 3/4 in for a 7 1/4 and
//      Stetson prints 23 in for the same label. Both are the brands' own charts.
//      A cross-brand hat-size conversion is therefore lossy by up to a quarter
//      inch, and this file pins the disagreement so nobody "fixes" it into
//      agreement later.
//   3. NO DECODER, AND NEW ERA IS THE INTERESTING REFUSAL — `5950` names the
//      SILHOUETTE (a bare four-digit run: the Chanel/Lee refusal), and the
//      per-cap code lives on a REMOVABLE VISOR STICKER, which is 00468's hangtag
//      rule exactly. A refusal that is only a comment is not a refusal, so it is
//      asserted against the migration here.
//
// brand-normalize.ts and sizing-charts.ts import supabase at load → dummy env
// first.
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

const MIGRATION = new URL(
  "../../../../supabase/migrations/00574_headwear_brand_knowledge.sql",
  import.meta.url,
);
const SQL = await Deno.readTextFile(MIGRATION);

const GROUP = ["New Era", "Stetson", "Kangol", "Goorin Bros."];

Deno.test("US-2221: the headwear aliases canonicalize", () => {
  for (const brand of GROUP) {
    assert(
      isKnownBrand(brand),
      `${brand} is a curated entry, not a passthrough`,
    );
  }

  assertEquals(canonicalizeBrand("new era"), "New Era");
  assertEquals(canonicalizeBrand("NEWERA"), "New Era");
  assertEquals(canonicalizeBrand("New Era Cap"), "New Era");
  assertEquals(canonicalizeBrand("stetson"), "Stetson");
  assertEquals(canonicalizeBrand("kangol"), "Kangol");

  // brandKey() strips the period, so the label form and the bare surname both
  // land on the one canonical — and so does the 1921 registered spelling, which
  // is still printed inside older hats.
  for (const spelling of ["Goorin", "Goorin Bros.", "goorin bros", "Goorin Brothers"]) {
    assertEquals(
      canonicalizeBrand(spelling),
      "Goorin Bros.",
      `${spelling} lands on the one canonical`,
    );
  }

  // The founder's name is printed in vintage Stetson sweatbands and is the only
  // string on some hats.
  assertEquals(canonicalizeBrand("John B. Stetson"), "Stetson");
});

Deno.test("US-2221: the alias refusals hold", () => {
  // A BARE "era" IS NOT NEW ERA. It is an ordinary English noun AND this KB's
  // own vocabulary for a tag generation (brand_knowledge.tag_eras), so it shows
  // up in seeded prose constantly. Only the compound forms resolve.
  assert(!isKnownBrand("era"), "a bare 'era' must not resolve to New Era");
  assertEquals(canonicalizeBrand("era"), "era");

  // A BARE "bros" is not Goorin — it is a suffix half the hat trade uses.
  assert(!isKnownBrand("bros"), "a bare 'bros' must not resolve to Goorin Bros.");

  // The X RATING IS NOT A BRAND. "10X" on a sweatband is a felt grade, and it
  // appears on hats from many makers, so it must never reach a brand field.
  for (const x of ["4X", "10X", "100X"]) {
    assert(!isKnownBrand(x), `${x} is a felt grade, not a brand`);
  }
});

Deno.test("US-2221: 'New Era' is never minted out of free text", () => {
  // The most ORDINARY phrase in DETECT_EXCLUDED_FROM_TEXT: not a noun that
  // happens to be a brand, a stock marketing phrase. And the collision clusters
  // exactly where the true positives live — sports listings say "a new era"
  // about teams constantly, and a New Era cap is licensed sports product.
  assertEquals(
    detectBrandInText("Nike tee, a new era of comfort, size M"),
    "Nike",
    "the real brand in the string must win — longest-first would give 'New Era' (7) over 'Nike' (4)",
  );
  assertEquals(
    detectBrandInText("A new era for the franchise"),
    null,
    "prose alone must not mint the cap house",
  );

  // Still fully reachable BY TAG, which is what the eBay Brand aspect and the
  // comp filter actually read. Excluding detection must not cost that.
  assertEquals(canonicalizeBrand("New Era"), "New Era");
  assert(isKnownBrand("New Era"));

  // The other three are NOT excluded — none is an ordinary word, and losing
  // prose detection for them would cost recall for nothing.
  assertEquals(detectBrandInText("Vintage Stetson 6X fur felt hat"), "Stetson");
  assertEquals(detectBrandInText("Kangol 504 wool cap, black"), "Kangol");
});

Deno.test("US-2221 AC2: the charts are in head circumference, not apparel units", () => {
  // The whole point of the AC. If a headwear chart ever grows a chest or waist
  // key, it has been re-encoded as apparel and the size is no longer the hat's.
  const APPAREL = ["chest", "waist", "bust", "hip", "inseam", "sleeve"];
  // From the INSERT, not from the first mention of the table — the header
  // comment names brand_size_charts too, and splitting on the name gave the
  // PROSE between the two, which contains no measurement at all and so passed
  // the apparel check vacuously. Found by this test failing on its own positive
  // assertion, which is why that assertion is here.
  const insertAt = SQL.indexOf("insert into public.brand_size_charts");
  assert(insertAt > 0, "the migration must seed size charts");
  const headwearCharts = SQL.slice(insertAt, SQL.indexOf("insert into public.brand_styles"));
  for (const key of APPAREL) {
    assert(
      !headwearCharts.includes(`"${key}"`),
      `a headwear chart must not carry the apparel measurement "${key}"`,
    );
  }
  assert(
    headwearCharts.includes('"head_circumference"'),
    "every headwear chart measures head circumference",
  );

  // The LABELS are hat sizes and alpha bands, seeded as published.
  for (const label of ['"7 1/4"', '"7 3/8"', '"XXL"', '"OS (adjustable)"']) {
    assert(SQL.includes(label), `the published label ${label} is seeded verbatim`);
  }
});

Deno.test("US-2221: the brands disagree on inches for the SAME printed size", () => {
  // MEASURED, NOT ASSUMED — both numbers are the brands' own published charts.
  // 7.25 x pi = 22.78, so New Era states the circumference and Stetson rounds up
  // for fit (its own guidance is to size up when between sizes).
  //
  // This test exists so the disagreement cannot be quietly "corrected" into
  // agreement by someone who assumes a hat size is a hat size. It is not: a
  // cross-brand conversion is lossy by up to a quarter inch.
  const neweraChart = chartRows(SQL, "'newera', 'New Era'", "Caps (fitted");
  const stetsonChart = chartRows(SQL, "'stetson', 'Stetson'", "Hats (US hat sizes)");

  assert(
    neweraChart.includes('{"size":"7 1/4","measurements":{"head_circumference":"22.75"}}'),
    "New Era publishes 22 3/4 in for a 7 1/4",
  );
  assert(
    stetsonChart.includes('{"size":"7 1/4","measurements":{"head_circumference":"23"}}'),
    "Stetson publishes 23 in for the same printed 7 1/4",
  );
  assert(
    !neweraChart.includes('{"size":"7 1/4","measurements":{"head_circumference":"23"}}'),
    "the two must not be reconciled — they are different charts making different claims",
  );
});

Deno.test("US-2221: NO decoder is seeded, and the refusal is deliberate", () => {
  // The story's own notes call New Era 59FIFTY one of the two strongest decoder
  // candidates in the grading-KB review. It is refused on the 00460 bar, and a
  // refusal that is only a comment is not a refusal.
  assert(
    !/insert\s+into\s+public\.brand_style_codes/i.test(SQL),
    "the headwear pack must seed no decoder — 5950 names the silhouette, and the per-cap code leaves with the visor sticker",
  );

  // And the reasoning has to survive in the file, because the next author will
  // re-derive it otherwise. Both grounds, not just one.
  assert(
    SQL.includes("NAMES THE SILHOUETTE"),
    "the migration records WHY 5950 is not a decoder",
  );
  assert(
    SQL.includes("VISOR STICKER"),
    "the migration records that the per-cap code is on the removable sticker",
  );
});

Deno.test("US-2221: every datable era carries a source and a confidence", () => {
  // Migration 00572 (US-2212 AC5) enforces this in the database with a NOT VALID
  // CHECK, so a violation would fail the db lane. Asserted here too because the
  // db lane needs Docker and this file runs everywhere — an uncited decade is
  // invention, and the cheap check should be the one that always runs.
  const eras = SQL.matchAll(/\{"era":[^}]*\}/g);
  let checked = 0;
  for (const [entry] of eras) {
    const years = /"years":"([^"]*)"/.exec(entry)?.[1] ?? "";
    if (!/(\d{4}|\d0s)/.test(years)) continue; // a format note makes no dating claim
    checked++;
    assert(
      /"source_url":"https?:\/\//.test(entry),
      `a datable era must cite a source: ${years}`,
    );
    assert(
      /"confidence":\d/.test(entry),
      `a datable era must carry a numeric confidence: ${years}`,
    );
  }
  assert(checked >= 15, `expected the pack's era entries to be checked, saw ${checked}`);
});

/**
 * One chart's `rows` jsonb, and ONLY that chart's.
 *
 * Bounded by the closing `]$json$` of the block, not by the next column name:
 * the first draft ended the slice at "source_url", which appears only in the
 * INSERT's column list, so indexOf returned -1 and the slice ran to the end of
 * the file — making the New Era slice contain Stetson's numbers. The
 * disagreement assertion caught it, which is the reason to assert a NEGATIVE
 * ("these must not be reconciled") alongside the two positives.
 */
function chartRows(sql: string, brandTuple: string, garment: string): string {
  const from = sql.indexOf(garment, sql.indexOf(brandTuple));
  assert(from > 0, `chart not found: ${brandTuple} / ${garment}`);
  const end = sql.indexOf("]$json$", from);
  assert(end > from, `chart rows not terminated: ${garment}`);
  return sql.slice(from, end);
}
