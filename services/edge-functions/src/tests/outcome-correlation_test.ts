// US-2280: grade vs realized price. Pure logic, so all of it is testable.
//
// The failure this module has to avoid is not a wrong number — it is a
// confident number over a thin sample, because that is the one that ends up in
// a deck and then in a public report.

import { assert, assertAlmostEquals, assertEquals, assertStringIncludes } from "@std/assert";

const {
  MIN_CORRELATION_SAMPLE,
  correlateOutcomes,
  rankAverage,
  spearman,
} = await import("../lib/outcome-correlation.ts");

type Row = Parameters<typeof correlateOutcomes>[0][number];

function row(over: Partial<Row> = {}): Row {
  return {
    grade: 8,
    salePriceCents: 5000,
    compMedianCents: 5000,
    category: "tops",
    returned: false,
    disputed: false,
    ...over,
  };
}

/** n rows whose realization rises with the grade — a clean positive signal. */
function risingSample(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => {
    const grade = 4 + (i % 7); // 4..10
    return row({
      grade,
      compMedianCents: 5000,
      // realization 0.8 at grade 4 up to 1.4 at grade 10
      salePriceCents: Math.round(5000 * (0.8 + (grade - 4) * 0.1)),
    });
  });
}

// ── Ranking ─────────────────────────────────────────────────────────────────

Deno.test("US-2280: tied values share the AVERAGE rank", () => {
  // Grades tie constantly — 0.1 steps over a 9-point range across thousands of
  // sales. With arbitrary distinct ranks the coefficient would depend on sort
  // order rather than on the data.
  assertEquals(rankAverage([10, 20, 30]), [1, 2, 3]);
  assertEquals(rankAverage([10, 10, 30]), [1.5, 1.5, 3]);
  assertEquals(rankAverage([5, 5, 5, 5]), [2.5, 2.5, 2.5, 2.5]);
  // Order of appearance must not change anyone's rank.
  assertEquals(rankAverage([30, 10, 10]), [3, 1.5, 1.5]);
});

// ── Correlation ─────────────────────────────────────────────────────────────

Deno.test("US-2280: a perfect monotonic relationship is +1, and a reversed one is -1", () => {
  assertEquals(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assertEquals(spearman([1, 2, 3, 4], [40, 30, 20, 10]), -1);
});

Deno.test("US-2280: rank-based, so one runaway sale cannot swing the answer", () => {
  // The reason this is Spearman and not Pearson. Same ranks, one item that sold
  // for fifty times its comp: the rank coefficient is unmoved.
  const xs = [1, 2, 3, 4, 5];
  assertEquals(spearman(xs, [1, 2, 3, 4, 5]), 1);
  assertEquals(spearman(xs, [1, 2, 3, 4, 5000]), 1);
});

Deno.test("US-2280: no variance returns null, not zero", () => {
  // A run of identical grades has no rank order to correlate. Reporting 0 would
  // read as "no relationship" when the truth is "no question was asked".
  assertEquals(spearman([7, 7, 7, 7], [1, 2, 3, 4]), null);
  assertEquals(spearman([1, 2, 3, 4], [9, 9, 9, 9]), null);
  assertEquals(spearman([1], [1]), null, "one point is not a correlation");
});

// ── The report ──────────────────────────────────────────────────────────────

Deno.test("US-2280: below the minimum sample NO coefficient is reported", () => {
  // The load-bearing refusal. A coefficient over 12 sales is noise wearing a
  // number's clothes, and it is the shape that ends up in a deck.
  const r = correlateOutcomes(risingSample(MIN_CORRELATION_SAMPLE - 1));
  assertEquals(r.spearman, null);
  assertStringIncludes(r.insufficientReason, `below the ${MIN_CORRELATION_SAMPLE}`);
  // And the summary must not characterise the absence as a finding.
  assertStringIncludes(r.summary, "No coefficient reported");
  assert(
    !/no correlation|uncorrelated|weak|strong/i.test(r.summary),
    `a thin sample must not be described as a result: ${r.summary}`,
  );
});

Deno.test("US-2280: at the minimum sample it reports, and the sign is right", () => {
  const r = correlateOutcomes(risingSample(MIN_CORRELATION_SAMPLE));
  assert(r.spearman !== null, "at the threshold a coefficient is reported");
  assert(r.spearman > 0.9, `expected a strong positive, got ${r.spearman}`);
  assertEquals(r.insufficientReason, "");
  assertStringIncludes(r.summary, "Spearman +");
});

Deno.test("US-2280: rows with no comp are excluded from the coefficient, NOT from return rates", () => {
  // Dropping them entirely would make the return rate a statistic about items
  // that happened to have been repriced, which is a different population.
  const rows = [
    ...risingSample(MIN_CORRELATION_SAMPLE),
    row({ grade: 8, compMedianCents: null, returned: true }),
    row({ grade: 8, compMedianCents: null, disputed: true }),
  ];
  const r = correlateOutcomes(rows);
  assertEquals(r.rows, MIN_CORRELATION_SAMPLE + 2);
  assertEquals(r.usablePairs, MIN_CORRELATION_SAMPLE, "the two comp-less rows are not pairs");
  const band8 = r.bands.find((b) => b.band === 8);
  assert(band8, "grade band 8 missing");
  assert(band8.sales > band8.withComp, "the comp-less rows must still be counted as sales");
  assert(band8.returnRate > 0, "a comp-less return must still raise the return rate");
  assert(band8.disputeRate > 0, "a comp-less dispute must still raise the dispute rate");
});

Deno.test("US-2280: a zero or negative comp cannot become a division", () => {
  // A comp of 0 would make realization Infinity and poison the whole ranking.
  const rows = [
    ...risingSample(MIN_CORRELATION_SAMPLE),
    row({ compMedianCents: 0 }),
    row({ compMedianCents: -100 }),
  ];
  const r = correlateOutcomes(rows);
  assertEquals(r.usablePairs, MIN_CORRELATION_SAMPLE);
  assert(r.spearman !== null && Number.isFinite(r.spearman));
});

Deno.test("US-2280: bands are whole grade points, which is exactly where the tiers fall", () => {
  // 9.x is NWOT and 10 is NWT, so flooring groups by tier without copying the
  // tier table into a second place.
  const r = correlateOutcomes([
    row({ grade: 9.9 }),
    row({ grade: 9.0 }),
    row({ grade: 10 }),
    row({ grade: 6.5 }),
  ]);
  assertEquals(r.bands.map((b) => b.band), [6, 9, 10]);
  assertEquals(r.bands.find((b) => b.band === 9)?.sales, 2);
  assertEquals(r.bands.find((b) => b.band === 10)?.sales, 1);
});

Deno.test("US-2280: the median realization is a median, not a mean", () => {
  // Four sales at comp and one at ten times comp: the median stays at 1.
  const rows = [
    row({ grade: 7, salePriceCents: 5000, compMedianCents: 5000 }),
    row({ grade: 7, salePriceCents: 5000, compMedianCents: 5000 }),
    row({ grade: 7, salePriceCents: 5000, compMedianCents: 5000 }),
    row({ grade: 7, salePriceCents: 5000, compMedianCents: 5000 }),
    row({ grade: 7, salePriceCents: 50000, compMedianCents: 5000 }),
  ];
  const band = correlateOutcomes(rows).bands[0];
  assertAlmostEquals(band.medianRealization ?? 0, 1, 1e-9);
});

Deno.test("US-2280: an empty input reports nothing rather than dividing by zero", () => {
  const r = correlateOutcomes([]);
  assertEquals(r.rows, 0);
  assertEquals(r.usablePairs, 0);
  assertEquals(r.spearman, null);
  assertEquals(r.bands, []);
  assertStringIncludes(r.summary, "No coefficient reported");
});

Deno.test("US-2280 PRIVACY: an OutcomeRow has no way to carry a seller", () => {
  // AC4 by construction. The report is internal calibration input; a per-seller
  // identifier in the aggregate is a disclosure risk dressed as a statistic. The
  // guard is on the TYPE, so this is a source scan: a future field named
  // user_id/seller/email on the row would compile fine and leak quietly.
  const src = Deno.readTextFileSync("src/lib/outcome-correlation.ts");
  const block = src.match(/export interface OutcomeRow \{[\s\S]*?\n\}/)?.[0] ?? "";
  assert(block, "OutcomeRow interface not found");
  // Strip comments FIRST. The doc comment on `category` says "never a free-text
  // title", and scanning it would fail this guard on the sentence promising the
  // very thing it checks — the mirror image of the usual trap, where a comment
  // SATISFIES a guard the code no longer meets.
  const iface = block.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  for (const banned of [/user_?id/i, /seller/i, /email/i, /\bitem_?id/i, /listing_?id/i, /title/i]) {
    assert(
      !banned.test(iface),
      `OutcomeRow gained an identifying field (${banned}). The whole point is ` +
        "that a caller holding a seller's row has nothing valid to pass that " +
        "would carry the seller into the aggregate.",
    );
  }
});
