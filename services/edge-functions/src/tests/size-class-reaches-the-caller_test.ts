import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { SIZING_CHARTS } from "../lib/sizing-charts.ts";
import { detectSizeClass } from "../lib/size-systems.ts";

// US-3406: size_class is a column nothing read, and the not-reading was visible
// from outside the process.
//
// `flipdesk-size-bands.ts:168` answers `chart.sizeClass ?? detectSizeClass(chart)`.
// On the DB path `chart.sizeClass` was ALWAYS undefined, because
// brand-knowledge.ts's select did not ask for the column, so the route
// re-derived the class from the garment string while a stored value sat in the
// row. On the in-code fallback path the declared value was used. Two paths, two
// answers for the same chart, and the live one was the wrong one.
//
// Half of that is fixed: the select and chartFromRow now carry it, so a row
// holding a value reaches the caller.
//
// The other half is a DATA problem and it is owner-gated. This file measures it
// rather than describing it, because the description is what let it sit for
// seven weeks.

/**
 * Charts whose DECLARED class the derivation disagrees with.
 *
 * Measured 2026-09-18 over all of SIZING_CHARTS: 7 charts declare a sizeClass
 * and `detectSizeClass` returns a different answer for exactly these 2.
 *
 * WHY THIS MATTERS RATHER THAN BEING A CURIOSITY: `chartSystemRow` in
 * scripts/gen-size-systems-migration.mjs reads `detectSizeClass(chart)` and
 * never `chart.sizeClass`, so 00499 wrote the DERIVED value. For these two the
 * derived value is "standard", which means the seeded row says a plus chart and
 * a big-and-tall chart are ordinary. Selecting the column, as this story now
 * does, cannot fix that: the stored value is wrong, not missing.
 *
 * Shrink-only. Fixing CLASS_PATTERNS makes an entry stop disagreeing and this
 * fails, which is the point -- the fix cannot land without also landing the
 * migration that corrects the rows, because 00499 is immutable and
 * sizing-chart-parity_test.ts re-derives it from the generator.
 */
const DECLARED_BUT_DERIVED_STANDARD: Record<string, string> = {
  "Tommy Hilfiger|Women|Curve, tops & bottoms (body inches)": "plus",
  "Brooks Brothers|Men|Bottoms, big (body inches)": "big_and_tall",
};

const keyOf = (c: { brand: string; department: string; garment: string }) =>
  `${c.brand}|${c.department}|${c.garment}`;

Deno.test("US-3406: the corpus still declares a sizeClass somewhere", () => {
  // Fail closed. If SIZING_CHARTS stopped carrying the field, every assertion
  // below would pass over an empty set and report a clean corpus.
  const declaring = SIZING_CHARTS.filter((c) => c.sizeClass);
  assert(
    declaring.length >= 7,
    `expected at least 7 charts declaring sizeClass, saw ${declaring.length}`,
  );
});

Deno.test("US-3406: exactly the known two charts derive a class they do not declare", () => {
  const disagreeing = SIZING_CHARTS.filter(
    (c) => c.sizeClass && detectSizeClass(c) !== c.sizeClass,
  );
  assertEquals(
    disagreeing.map(keyOf).sort(),
    Object.keys(DECLARED_BUT_DERIVED_STANDARD).sort(),
    "The set of charts whose declared class the derivation disagrees with has " +
      "changed. If CLASS_PATTERNS was widened, the seeded rows in 00499 are now " +
      "stale for that chart and need a new migration plus an owner apply -- " +
      "00499 is immutable and must never re-run (PENDING_MIGRATIONS.md). If a " +
      "chart's declaration changed, update this list.",
  );
});

Deno.test("US-3406: each one derives 'standard', which is the harmful direction", () => {
  // Not just "different". Deriving plus for a standard chart would over-warn;
  // deriving standard for a plus chart means the seller gets a standard run's
  // measurements with no warning at all, which is the case a plus-size seller
  // meets as their own correct listing being flagged.
  for (const [key, declared] of Object.entries(DECLARED_BUT_DERIVED_STANDARD)) {
    const chart = SIZING_CHARTS.find((c) => keyOf(c) === key);
    assert(chart, `${key} is no longer in the corpus; update this list`);
    assertEquals(chart.sizeClass, declared, `${key} declares something else now`);
    assertEquals(
      detectSizeClass(chart),
      "standard",
      `${key} no longer derives "standard" -- if CLASS_PATTERNS was fixed, the ` +
        `00499 rows are stale and need the migration described above`,
    );
  }
});

Deno.test("US-3406: the DB read asks for the column, and NULL stays undefined", () => {
  // A source pin, because the defect was an omission from a select list and an
  // omission is exactly what a behavioural test cannot see: the route answered
  // plausibly the whole time.
  const src = Deno.readTextFileSync(
    new URL("../lib/brand-knowledge.ts", import.meta.url),
  );
  assert(
    /\.select\(\s*\n?\s*"[^"]*\bsize_class\b[^"]*"/.test(src),
    "brand-knowledge.ts's brand_size_charts select must ask for size_class, or " +
      "the column is unreachable on the live path however well it is populated",
  );
  assert(
    src.includes("sizeClass: r.size_class ?? undefined"),
    "NULL must stay undefined rather than becoming \"standard\": undefined " +
      "means unclassified and lets the caller's detectSizeClass fallback run, " +
      "while \"standard\" asserts a classification the row does not make",
  );
});
