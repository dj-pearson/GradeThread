// US-2842: the spike's arithmetic, tested without the spike.
//
// The run itself needs production credentials and about a hundred real AI
// calls. Every number it prints is computed here, so when it runs the only
// untested thing is the data.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  type BudgetRow,
  buildCandidates,
  type CalibrationRead,
  costPerRead,
  explainNoCandidates,
  gradeBand,
  isFetchableUrl,
  MAX_PHOTOS_PER_READ,
  summarizeCalibration,
} from "../lib/comp-read-calibration.ts";

function read(over: Partial<CalibrationRead> = {}): CalibrationRead {
  return {
    ref: "aaaaaa",
    certifiedScore: 8,
    readScore: 8,
    readConfidence: 0.8,
    imagesAnalyzed: 4,
    ...over,
  };
}

Deno.test("a perfect reader reports zero error", () => {
  const s = summarizeCalibration([
    read({ certifiedScore: 8, readScore: 8 }),
    read({ certifiedScore: 5, readScore: 5 }),
  ]);
  assertEquals(s.meanSignedError, 0);
  assertEquals(s.meanAbsoluteError, 0);
  assertEquals(s.withinHalfPoint, 1);
});

Deno.test("signed error keeps its sign, so bias is visible", () => {
  // Reads run HIGH by half a point on both. A bias is correctable with an
  // offset; noise is not. Averaging the absolutes would have hidden it.
  const s = summarizeCalibration([
    read({ certifiedScore: 8, readScore: 8.5 }),
    read({ certifiedScore: 5, readScore: 5.5 }),
  ]);
  assertEquals(s.meanSignedError, 0.5);
  assertEquals(s.meanAbsoluteError, 0.5);
});

Deno.test("bias and noise are told apart", () => {
  // One high, one low, same magnitude: no bias at all, and half a point of noise.
  const s = summarizeCalibration([
    read({ certifiedScore: 8, readScore: 8.5 }),
    read({ certifiedScore: 5, readScore: 4.5 }),
  ]);
  assertEquals(s.meanSignedError, 0);
  assertEquals(s.meanAbsoluteError, 0.5);
});

Deno.test("a failed read is counted, never quietly dropped", () => {
  // The failure mode this exists to catch: a reader that answers confidently on
  // the easy half and refuses the rest posts a beautiful error and is useless.
  const s = summarizeCalibration([
    read({ certifiedScore: 8, readScore: 8 }),
    read({ certifiedScore: 4, readScore: null, error: "no score" }),
  ]);
  assertEquals(s.attempted, 2);
  assertEquals(s.scored, 1);
  assertEquals(s.failed, 1);
  // The mean is over the reads that produced a score, and `scored` is printed
  // next to it so the denominator is never a guess.
  assertEquals(s.meanAbsoluteError, 0);
});

Deno.test("every read failing gives nulls, not zeros", () => {
  const s = summarizeCalibration([read({ readScore: null }), read({ readScore: null })]);
  assertEquals(s.scored, 0);
  assertEquals(s.meanAbsoluteError, null);
  assertEquals(s.withinHalfPoint, null);
  assertEquals(s.worstAbsoluteError, null);
});

Deno.test("test-retest measures the reader against itself", () => {
  const s = summarizeCalibration([
    read({ readScore: 8, retestScore: 8.5 }),
    read({ readScore: 6, retestScore: 6 }),
    // A pair needs BOTH scores; a failed retest is not a zero delta.
    read({ readScore: 7, retestScore: null }),
  ]);
  assertEquals(s.retestPairs, 2);
  assertEquals(s.meanTestRetestDelta, 0.25);
  assertEquals(s.maxTestRetestDelta, 0.5);
});

Deno.test("bands split the scale, because a mean hides the shape", () => {
  const s = summarizeCalibration([
    read({ certifiedScore: 9, readScore: 9 }),
    read({ certifiedScore: 4, readScore: 6 }),
  ]);
  // Tight at the top, two points out at the bottom. The overall mean absolute
  // error is 1.0, which reads as survivable and is not.
  assertEquals(s.meanAbsoluteError, 1);
  const low = s.byBand.find((b) => b.band.startsWith("1.0-5.4"))!;
  assertEquals(low.meanAbsoluteError, 2);
  const high = s.byBand.find((b) => b.band.startsWith("8.5-9.4"))!;
  assertEquals(high.meanAbsoluteError, 0);
});

Deno.test("bands are assigned at their boundaries", () => {
  assertEquals(gradeBand(10), "9.5-10 new");
  assertEquals(gradeBand(9.5), "9.5-10 new");
  assertEquals(gradeBand(9.4), "8.5-9.4 excellent");
  assertEquals(gradeBand(8.5), "8.5-9.4 excellent");
  assertEquals(gradeBand(7), "7.0-8.4 very good");
  assertEquals(gradeBand(5.5), "5.5-6.9 good");
  assertEquals(gradeBand(5.4), "1.0-5.4 fair or poor");
  assertEquals(gradeBand(1), "1.0-5.4 fair or poor");
});

Deno.test("the agreement bands are inclusive at the edge", () => {
  const s = summarizeCalibration([
    read({ certifiedScore: 8, readScore: 8.5 }),
    read({ certifiedScore: 8, readScore: 9 }),
  ]);
  // Exactly 0.5 counts as within 0.5; exactly 1.0 counts as within 1.0.
  assertEquals(s.withinHalfPoint, 0.5);
  assertEquals(s.withinOnePoint, 1);
});

// -- cost ------------------------------------------------------------

const budget = (spend: number): BudgetRow[] => [
  { feature: "grading", period: "day", spendUsd: spend },
  { feature: "autolister", period: "day", spendUsd: 99 },
];

Deno.test("dollars per read is the budget delta over the calls made", () => {
  const c = costPerRead(budget(1.0), budget(3.0), 40);
  assertEquals(c.spentUsd, 2);
  assertEquals(c.dollarsPerRead, 0.05);
  // The caveat is part of the answer: this cannot know what else was grading.
  assert(c.caveat && c.caveat.includes("over-states"));
});

Deno.test("no matching budget means no number, and says why", () => {
  const c = costPerRead([], [], 40);
  assertEquals(c.dollarsPerRead, null);
  assert(c.caveat && c.caveat.includes("no spend counter"), c.caveat ?? "");
});

Deno.test("a period rollover is caught rather than reported as negative cost", () => {
  const c = costPerRead(budget(5.0), budget(0.2), 40);
  assertEquals(c.dollarsPerRead, null);
  assert(c.caveat && c.caveat.includes("rolled over"), c.caveat ?? "");
});

Deno.test("zero reads divides by nothing", () => {
  const c = costPerRead(budget(1), budget(1), 0);
  assertEquals(c.dollarsPerRead, null);
  assert(c.caveat && c.caveat.includes("nothing to divide by"), c.caveat ?? "");
});

// -- candidate selection ---------------------------------------------

const REPORTS = [
  { id: "r1", submission_id: "s1", overall_score: 8.5 },
  { id: "r2", submission_id: "s2", overall_score: "6.0" },
];
const LINKS = [
  { inventory_item_id: "i1", submission_id: "s1" },
  { inventory_item_id: "i2", submission_id: "s2" },
];
const ITEMS = [
  { id: "i1", brand: "Patagonia", title: "Better Sweater" },
  { id: "i2", brand: null, title: null },
];
const PHOTOS = [
  { inventory_item_id: "i1", photo_url: "https://cdn.test/a.jpg" },
  { inventory_item_id: "i1", photo_url: "https://cdn.test/b.jpg" },
  { inventory_item_id: "i2", photo_url: "https://cdn.test/c.jpg" },
];
const ref = (id: string) => `ref-${id}`;

Deno.test("a garment needs a report, a link and a photo, all three", () => {
  const out = buildCandidates(REPORTS, LINKS, ITEMS, PHOTOS, 10, ref);
  assertEquals(out.length, 2);
  assertEquals(out[0].ref, "ref-r1");
  assertEquals(out[0].certifiedScore, 8.5);
  assertEquals(out[0].brand, "Patagonia");
  assertEquals(out[0].photoUrls.length, 2);
  // PostgREST hands numerics back as strings often enough to matter.
  assertEquals(out[1].certifiedScore, 6);
});

Deno.test("a report with no FlipDesk link is skipped, not read", () => {
  const out = buildCandidates(REPORTS, [LINKS[0]], ITEMS, PHOTOS, 10, ref);
  assertEquals(out.map((c) => c.ref), ["ref-r1"]);
});

Deno.test("a linked item with no photo is skipped", () => {
  const out = buildCandidates(REPORTS, LINKS, ITEMS, [PHOTOS[0]], 10, ref);
  assertEquals(out.map((c) => c.ref), ["ref-r1"]);
});

Deno.test("only fetchable photo urls count", () => {
  assertEquals(isFetchableUrl("https://cdn.test/a.jpg"), true);
  assertEquals(isFetchableUrl("http://cdn.test/a.jpg"), true);
  // The endpoint FETCHES these. A storage path is not a URL, and letting one
  // through would show up as the reader refusing a garment.
  assertEquals(isFetchableUrl("user-id/item/front.jpg"), false);
  assertEquals(isFetchableUrl("data:image/jpeg;base64,AAAA"), false);
  assertEquals(isFetchableUrl(null), false);
  const out = buildCandidates(
    [REPORTS[0]],
    [LINKS[0]],
    ITEMS,
    [{ inventory_item_id: "i1", photo_url: "user-id/item/front.jpg" }],
    10,
    ref,
  );
  assertEquals(out.length, 0);
});

Deno.test("photos per read are capped", () => {
  const many = Array.from({ length: MAX_PHOTOS_PER_READ + 4 }, (_, i) => ({
    inventory_item_id: "i1",
    photo_url: `https://cdn.test/${i}.jpg`,
  }));
  const out = buildCandidates([REPORTS[0]], [LINKS[0]], ITEMS, many, 10, ref);
  assertEquals(out[0].photoUrls.length, MAX_PHOTOS_PER_READ);
});

Deno.test("the limit is a hard cap on AI spend, so it is respected exactly", () => {
  const out = buildCandidates(REPORTS, LINKS, ITEMS, PHOTOS, 1, ref);
  assertEquals(out.length, 1);
});

Deno.test("an unparseable score is skipped rather than read as NaN", () => {
  const out = buildCandidates(
    [{ id: "r9", submission_id: "s1", overall_score: "not a number" }],
    [LINKS[0]],
    ITEMS,
    PHOTOS,
    10,
    ref,
  );
  assertEquals(out.length, 0);
});

Deno.test("an empty result says WHICH requirement failed", () => {
  // "No candidates" reads as "we have no graded garments" and is almost never
  // what actually happened.
  assert(explainNoCandidates([], [], []).includes("No certified grade reports"));
  assert(
    explainNoCandidates([{ id: "r1", submission_id: null, overall_score: 8 }], [], [])
      .includes("none carries a submission_id"),
  );
  assert(explainNoCandidates(REPORTS, [], []).includes("graded outside FlipDesk"));
  assert(
    explainNoCandidates(REPORTS, LINKS, [
      { inventory_item_id: "i1", photo_url: "user-id/a.jpg" },
    ]).includes("http(s) listing photo"),
  );
  assert(
    explainNoCandidates(REPORTS, [{ inventory_item_id: "zz", submission_id: "s1" }], PHOTOS)
      .includes("different items"),
  );
});
