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
 * Charts whose DECLARED class the derivation disagrees with. EMPTY, and the
 * two entries it used to hold are the subject of 00809.
 *
 * ⚠ FIXED 2026-09-20 (US-3406), AND ONE SENTENCE OF THE OLD NOTE WAS WRONG.
 * It said "the stored value is wrong, not missing". Read off the table: both
 * rows carried size_class NULL, not 'standard'. `chartSystemRow` in
 * scripts/gen-size-systems-migration.mjs returns null when the system is
 * unreadable AND the class derives "standard", so 00499 emitted no row for
 * either chart at all and the column was never written. The harm is the same
 * either way, because `?? detectSizeClass(chart)` answered "standard" for both,
 * but a missing value and a wrong value are repaired by different SQL and only
 * one of them is visible in a count.
 *
 * CLASS_PATTERNS now reads "curve" as plus and a bare "big" as big_and_tall,
 * 00499 is regenerated to match (two rows added, nothing else moved), and
 * 00809 is the UPDATE for the live rows. That is the three-part commit this
 * list existed to force.
 *
 * Shrink-only, and it stays: a NEW disagreement means CLASS_PATTERNS moved
 * without its migration, which is the same failure one number later.
 */
const DECLARED_BUT_DERIVED_STANDARD: Record<string, string> = {};

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

Deno.test("US-3406: the two charts 00809 repairs now derive what they declare", () => {
  // The positive form of what this file used to assert. An empty
  // DECLARED_BUT_DERIVED_STANDARD proves nothing on its own -- it is satisfied
  // by a corpus with no declarations at all -- so name the two and check them.
  const REPAIRED: Record<string, string> = {
    "Tommy Hilfiger|Women|Curve, tops & bottoms (body inches)": "plus",
    "Brooks Brothers|Men|Bottoms, big (body inches)": "big_and_tall",
  };
  for (const [key, declared] of Object.entries(REPAIRED)) {
    const chart = SIZING_CHARTS.find((c) => keyOf(c) === key);
    assert(chart, `${key} is no longer in the corpus; update this list`);
    assertEquals(chart.sizeClass, declared, `${key} declares something else now`);
    assertEquals(
      detectSizeClass(chart),
      declared,
      `${key} derives something other than its declaration again -- ` +
        `CLASS_PATTERNS narrowed, and 00499 plus 00809 now describe a class ` +
        `the code no longer derives`,
    );
  }
});

Deno.test("US-3406: the bare /big/ pattern matches only the charts it was widened for", () => {
  // The loose one. "Bottoms, big" has to read as big_and_tall, and the price is
  // a pattern that would also claim a "Big Kids" chart. Measured over the whole
  // corpus when it was widened: the only garments containing the word are the
  // two "big & tall" charts and Brooks Brothers' "Bottoms, big". If a brand
  // ever ships one that is not, this fails rather than mislabelling it.
  const withBig = SIZING_CHARTS.filter((c) => /\bbig\b/i.test(c.garment));
  assertEquals(
    withBig.map(keyOf).sort(),
    [
      "Brooks Brothers|Men|Bottoms, big (body inches)",
      "Johnnie-O|Men|Bottoms, big & tall (42R-56R)",
      "Marmot|Men|Bottoms, big & tall (1XT-4XT)",
    ],
    "a new chart's garment scope contains the word \"big\" — confirm it really " +
      "is the big-and-tall dimension, because CLASS_PATTERNS will class it so",
  );
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
