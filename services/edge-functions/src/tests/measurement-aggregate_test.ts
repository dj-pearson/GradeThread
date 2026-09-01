// US-3036: the floors, and the outlier rule that runs before them.
//
// Everything in this file is about one question: which numbers is the site
// allowed to print? Getting it wrong in either direction is expensive and only
// one direction is visible.
//
//   Too permissive publishes a median backed by one person's closet, or one
//   dragged by a typo. Nothing downstream catches either.
//   Too strict publishes nothing, which looks exactly like having no data.
//
//   deno test --allow-env --allow-read --allow-net src/tests/measurement-aggregate_test.ts

import { assert, assertEquals } from "@std/assert";

const {
  aggregateCohort,
  aggregateAll,
  cohortKeyString,
  cohortsToRetire,
  dropOutliers,
  outlierFence,
  quantileSorted,
  MIN_MEASUREMENT_SAMPLE,
  MIN_MEASUREMENT_CONTRIBUTORS,
} = await import("../lib/measurement-aggregate.ts");

const KEY = {
  brand_key: "levis",
  style_key: "550",
  department: "Men",
  measurement_group: "bottom",
  size_label: "34X32",
  field_key: "waist",
};

/** n observations of `inches`, one per distinct contributor. */
function fromSellers(...pairs: [number, string][]) {
  return pairs.map(([inches, user_id]) => ({ inches, user_id }));
}

// ── The two floors ──────────────────────────────────────────────────────────

Deno.test("US-3036: both floors must clear for a cohort to be sufficient", () => {
  // Five garments, three sellers: the minimum that publishes.
  const ok = aggregateCohort(
    KEY,
    fromSellers([17, "a"], [17.5, "b"], [17.25, "c"], [17, "a"], [17.5, "b"]),
  );
  assertEquals(ok.sample_count, 5);
  assertEquals(ok.contributor_count, 3);
  assertEquals(ok.sufficient, true);
});

Deno.test("US-3036: five garments from ONE seller does NOT publish", () => {
  // The privacy floor is independent of the quality floor, and this is the
  // case that proves it: perfect measuring, plenty of samples, still not a
  // fact about the garment. It is a fact about one person's inventory.
  const stats = aggregateCohort(
    KEY,
    fromSellers([17, "a"], [17, "a"], [17.5, "a"], [17.5, "a"], [17.25, "a"]),
  );
  assertEquals(stats.sample_count, 5);
  assertEquals(stats.contributor_count, 1);
  assertEquals(stats.sufficient, false);
});

Deno.test("US-3036: four garments from four sellers does NOT publish", () => {
  const stats = aggregateCohort(
    KEY,
    fromSellers([17, "a"], [17.5, "b"], [17.25, "c"], [17.4, "d"]),
  );
  assertEquals(stats.contributor_count, 4);
  assertEquals(stats.sample_count, 4);
  assertEquals(stats.sufficient, false);
});

Deno.test("US-3036: contributor_count counts DISTINCT sellers, not rows", () => {
  const stats = aggregateCohort(
    KEY,
    fromSellers([17, "a"], [17, "a"], [17, "a"], [17, "b"], [17, "b"], [17, "c"]),
  );
  assertEquals(stats.sample_count, 6);
  assertEquals(stats.contributor_count, 3);
});

Deno.test("US-3036: the floors are the documented numbers", () => {
  // Pinned so a change is a deliberate edit to a test, not a silent tweak.
  // Five and three, not the condition index's eight — flat measurements vary by
  // a fraction of an inch where prices do not.
  assertEquals(MIN_MEASUREMENT_SAMPLE, 5);
  assertEquals(MIN_MEASUREMENT_CONTRIBUTORS, 3);
});

// ── Outliers, dropped before the quantiles ──────────────────────────────────

Deno.test("US-3036: one fat-fingered value does not move the published median", () => {
  const withTypo = aggregateCohort(
    KEY,
    fromSellers([17, "a"], [17.25, "b"], [17.5, "c"], [17.25, "d"], [220, "e"]),
  );
  const without = aggregateCohort(
    KEY,
    fromSellers([17, "a"], [17.25, "b"], [17.5, "c"], [17.25, "d"]),
  );
  assertEquals(withTypo.median, without.median);
  // And the typo's contributor does not count toward the privacy floor either,
  // because the observation it came from is gone.
  assertEquals(withTypo.sample_count, 4);
  assertEquals(withTypo.contributor_count, 4);
});

Deno.test("US-3036: the drop happens BEFORE the quartiles, not after", () => {
  // The median survives an outlier on its own; the quartiles do not. If the
  // fence ran after, p75 would be dragged toward the typo and the BAND printed
  // on the page would be wrong while the median looked fine.
  const stats = aggregateCohort(
    KEY,
    fromSellers([17, "a"], [17, "b"], [17.5, "c"], [17.5, "d"], [90, "e"]),
  );
  assert(stats.p75 !== null && stats.p75 < 18, `p75 dragged by the outlier: ${stats.p75}`);
});

Deno.test("US-3036: below four values nothing is dropped", () => {
  // An outlier rule that fires on a cohort of two is a rule that deletes
  // disagreement. There is no meaningful quartile to build a fence from.
  assertEquals(outlierFence([17, 90]), null);
  assertEquals(outlierFence([17, 17, 90]), null);
  assertEquals(dropOutliers([17, 90]), [17, 90]);
});

Deno.test("US-3036: an all-identical cohort keeps every value", () => {
  // IQR is zero, so a naive fence would be a single point and would drop
  // nothing OR everything depending on the comparison. Neither is wanted.
  assertEquals(outlierFence([17, 17, 17, 17, 17]), null);
  assertEquals(dropOutliers([17, 17, 17, 17, 17]).length, 5);
});

Deno.test("US-3036: quantiles interpolate and are stable at the ends", () => {
  const s = [1, 2, 3, 4, 5];
  assertEquals(quantileSorted(s, 0), 1);
  assertEquals(quantileSorted(s, 0.5), 3);
  assertEquals(quantileSorted(s, 1), 5);
  assertEquals(quantileSorted([1, 2], 0.5), 1.5);
  assertEquals(quantileSorted([7], 0.25), 7);
  assert(Number.isNaN(quantileSorted([], 0.5)));
});

// ── Counts describe the numbers actually used ───────────────────────────────

Deno.test("US-3036: sample_count is the POST-drop count, not the raw one", () => {
  // Printing "median of 5 measured pairs" beside a median computed from 4 is a
  // small lie in the one place the page asks the reader to trust it.
  const stats = aggregateCohort(
    KEY,
    fromSellers([17, "a"], [17.25, "b"], [17.5, "c"], [17.25, "d"], [500, "e"]),
  );
  assertEquals(stats.sample_count, 4);
});

Deno.test("US-3036: a cohort with no usable values reports zero, not null keys", () => {
  const stats = aggregateCohort(KEY, [{ inches: Number.NaN, user_id: "a" }]);
  assertEquals(stats.sample_count, 0);
  assertEquals(stats.contributor_count, 0);
  assertEquals(stats.median, null);
  assertEquals(stats.sufficient, false);
  assertEquals(stats.brand_key, "levis");
});

// ── Grouping ────────────────────────────────────────────────────────────────

Deno.test("US-3036: observations group by the full six-part key", () => {
  const rows = [
    { ...KEY, inches: 17, user_id: "a" },
    { ...KEY, inches: 17.5, user_id: "b" },
    // Same everything but the size: a different garment, a different cohort.
    { ...KEY, size_label: "36X32", inches: 19, user_id: "a" },
    // Same everything but the field.
    { ...KEY, field_key: "inseam", inches: 32, user_id: "a" },
    // Same everything but the style: the brand-level rollup is its own cohort.
    { ...KEY, style_key: "", inches: 17.2, user_id: "c" },
  ];
  const out = aggregateAll(rows);
  assertEquals(out.length, 4);
  const waist34 = out.find((s) =>
    s.size_label === "34X32" && s.field_key === "waist" && s.style_key === "550"
  );
  assert(waist34);
  assertEquals(waist34.sample_count, 2);
});

Deno.test("US-3036: the key string cannot collide across fields", () => {
  const a = cohortKeyString({ ...KEY, style_key: "550", department: "Men" });
  const b = cohortKeyString({ ...KEY, style_key: "550 Men", department: "" });
  assert(a !== b, "a separator that lets two keys collide would merge cohorts");
});

Deno.test("US-3036: insufficient cohorts are RETURNED, not skipped", () => {
  // The read path filters; the write path never hides. A job that dropped thin
  // cohorts would make "no coverage" and "coverage we refuse to publish" look
  // identical, and the US-3037 gate cannot answer its question from that.
  const out = aggregateAll([{ ...KEY, inches: 17, user_id: "a" }]);
  assertEquals(out.length, 1);
  assertEquals(out[0]!.sufficient, false);
  assertEquals(out[0]!.sample_count, 1);
});

// ── Retirement: a published number must stop being published ────────────────
//
// This was a real bug, and it was found by deleting every observation against a
// live database rather than by any test here. The job returned early when there
// was nothing to aggregate, which skipped the retirement pass, so a cohort
// whose contributors had ALL opted out kept sufficient=true and the page kept
// printing a median backed by nothing. "Nothing to write" and "nothing to
// retire" are different questions and only one was being asked.

Deno.test("US-3036: an EMPTY aggregate retires everything currently published", () => {
  // The case the old early return skipped, and the one that matters most: an
  // empty result means every observation is gone, so every published number is
  // now backed by nothing.
  const published = [{ ...KEY, id: "row-1" }, { ...KEY, field_key: "inseam", id: "row-2" }];
  const stale = cohortsToRetire([], published);
  assertEquals(stale.map((s) => s.id), ["row-1", "row-2"]);
});

Deno.test("US-3036: a cohort that still has observations is NOT retired", () => {
  const published = [{ ...KEY, id: "row-1" }, { ...KEY, field_key: "inseam", id: "row-2" }];
  const stale = cohortsToRetire([KEY], published);
  assertEquals(stale.map((s) => s.id), ["row-2"]);
});

Deno.test("US-3036: nothing published means nothing to retire", () => {
  assertEquals(cohortsToRetire([KEY], []), []);
  assertEquals(cohortsToRetire([], []), []);
});
