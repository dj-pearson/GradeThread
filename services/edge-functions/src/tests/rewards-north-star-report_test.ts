import { assert, assertEquals } from "@std/assert";
import {
  type ClassifiedCohortMember,
  RETENTION_COMPARISON_CAVEAT,
  rewardsNorthStarReport,
} from "../lib/rewards-north-star-report.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-08-09T00:00:00.000Z");

/** A member who signed up `daysAgo` and was active on the given day offsets. */
function member(
  id: string,
  daysAgo: number,
  activeDayOffsets: number[],
  gamified: boolean,
): ClassifiedCohortMember {
  const signup = NOW - daysAgo * DAY;
  return {
    userId: id,
    signedUpAt: new Date(signup).toISOString(),
    activeAt: activeDayOffsets.map((d) => new Date(signup + d * DAY).toISOString()),
    gamified,
  };
}

const EMPTY_K = { sharers: 0, shares: 0, conversions: 0 };

function report(cohort: ClassifiedCohortMember[]) {
  return rewardsNorthStarReport({
    cohort,
    grades: 0,
    gradingUsers: 0,
    kFactor: EMPTY_K,
    grants: [],
    nowMs: NOW,
  });
}

Deno.test("the two arms and the headline use the SAME arithmetic", () => {
  // The split is a filter on the input, not a second implementation — so an arm
  // can never drift from the headline. Assert the parts reconcile.
  const cohort = [
    member("a", 40, [22], true),
    member("b", 40, [], true),
    member("c", 40, [25], false),
    member("d", 40, [], false),
  ];
  const r = report(cohort);
  assertEquals(r.retention.eligible, 4);
  assertEquals(r.retention.retained, 2);
  assertEquals(
    r.retentionComparison.gamified.eligible + r.retentionComparison.notGamified.eligible,
    r.retention.eligible,
  );
  assertEquals(
    r.retentionComparison.gamified.retained + r.retentionComparison.notGamified.retained,
    r.retention.retained,
  );
});

Deno.test("the gap is reported in percentage points", () => {
  const cohort = [
    member("g1", 40, [22], true),
    member("g2", 40, [23], true),
    member("n1", 40, [24], false),
    member("n2", 40, [], false),
  ];
  const r = report(cohort);
  assertEquals(r.retentionComparison.gamified.rate, 1);
  assertEquals(r.retentionComparison.notGamified.rate, 0.5);
  assertEquals(r.retentionComparison.gapPp, 50);
});

Deno.test("⚠ the gap is null, NEVER 0, when an arm has nobody eligible", () => {
  // "No gap" and "nothing to compare" are opposite claims. A 0 on a dashboard
  // reads as the former and would be quoted as evidence gamification does not
  // work, from a comparison that never happened.
  const onlyGamified = report([member("g", 40, [22], true)]);
  assertEquals(onlyGamified.retentionComparison.notGamified.eligible, 0);
  assertEquals(onlyGamified.retentionComparison.notGamified.rate, null);
  assertEquals(onlyGamified.retentionComparison.gapPp, null);

  // And with nobody aged in at all, both arms are null.
  const allImmature = report([member("x", 5, [], true), member("y", 5, [], false)]);
  assertEquals(allImmature.retention.eligible, 0);
  assertEquals(allImmature.retentionComparison.gapPp, null);
});

Deno.test("⚠ the self-selection caveat travels IN the payload, not just in a comment", () => {
  // If this only lived in a code comment, the admin surface would render a
  // clean two-bar chart and every reader would take it causally. Shipping it as
  // a required field means the UI has to actively discard it to hide it.
  const r = report([member("a", 40, [22], true)]);
  assertEquals(r.retentionComparison.causal, false);
  assertEquals(r.retentionComparison.caveat, RETENTION_COMPARISON_CAVEAT);
  assert(
    r.retentionComparison.caveat.length > 40,
    "the caveat must actually explain itself, not be a token",
  );
  assert(
    /self-selected/i.test(r.retentionComparison.caveat),
    "the caveat must name the problem it is warning about",
  );
});

Deno.test("an immature member is excluded from both arms, not counted as churned", () => {
  // The decision rewards-north-star.ts exists for, re-asserted through the
  // split: a filter must not turn "has not reached week 4" into "did not come
  // back".
  const r = report([
    member("mature", 40, [], true),
    member("fresh", 9, [], true),
  ]);
  assertEquals(r.retentionComparison.gamified.eligible, 1);
  assertEquals(r.retentionComparison.gamified.undecided, 1);
  assertEquals(r.retentionComparison.gamified.rate, 0);
});

Deno.test("cost per retained user divides by the HEADLINE retained count", () => {
  // Not by the gamified arm. Tangible-grant spend is not attributable to one
  // arm — a grant can land on anyone — so dividing it by a subset would
  // overstate cost per retained user by whatever the split happens to be.
  const cohort = [
    member("a", 40, [22], true),
    member("b", 40, [23], false),
  ];
  const r = rewardsNorthStarReport({
    cohort,
    grades: 10,
    gradingUsers: 4,
    kFactor: EMPTY_K,
    grants: [
      { userId: "a", costUsd: 6, status: "granted" },
      { userId: "b", costUsd: 4, status: "consumed" },
      { userId: "c", costUsd: 99, status: "expired" },
    ],
    nowMs: NOW,
  });
  assertEquals(r.retention.retained, 2);
  assertEquals(r.costPerRetained.costUsd, 10);
  assertEquals(r.costPerRetained.perRetainedUsd, 5);
  // The expired grant is not money and must not be counted.
  assertEquals(r.costPerRetained.uncommittedGrants, 1);
  assertEquals(r.gradesPerUser.perUser, 2.5);
});

Deno.test("an empty cohort produces nulls everywhere, no NaN and no zeros", () => {
  const r = report([]);
  assertEquals(r.retention.rate, null);
  assertEquals(r.retentionComparison.gapPp, null);
  assertEquals(r.gradesPerUser.perUser, null);
  assert(r.kFactor.available);
  if (r.kFactor.available) assertEquals(r.kFactor.k, null);
  assertEquals(r.costPerRetained.perRetainedUsd, null);
});

Deno.test("⚠ K is reported as UNAVAILABLE, not as zero, when the share half is unknown", () => {
  // A DB-only caller cannot see shares — a share never reaches a server. The
  // temptation is to pass {sharers: 0, shares: 0, conversions: n}, which makes
  // k come out null and LOOKS honest. It is not: sharers:0 asserts nobody
  // shared, sitting next to a conversion count that says otherwise. An explicit
  // "not measured here" is the only reading a dashboard cannot get wrong.
  const r = rewardsNorthStarReport({
    cohort: [],
    grades: 0,
    gradingUsers: 0,
    kFactor: null,
    grants: [],
    nowMs: NOW,
  });
  assertEquals(r.kFactor.available, false);
  assert(!r.kFactor.available && r.kFactor.reason.length > 40);
  assert(
    !r.kFactor.available && /posthog/i.test(r.kFactor.reason),
    "the reason must say WHERE the missing half lives, or it is not actionable",
  );
});

Deno.test("K is computed when the caller can supply both halves", () => {
  const r = rewardsNorthStarReport({
    cohort: [],
    grades: 0,
    gradingUsers: 0,
    kFactor: { sharers: 10, shares: 30, conversions: 6 },
    grants: [],
    nowMs: NOW,
  });
  assert(r.kFactor.available);
  if (r.kFactor.available) {
    assertEquals(r.kFactor.sharesPerSharer, 3);
    assertEquals(r.kFactor.conversionRate, 0.2);
    assertEquals(r.kFactor.k, 0.6);
  }
});

Deno.test("⚠ the report carries NO user ids — an aggregate must not become an export", () => {
  // The inputs are intensely per-user: who signed up, when they came back, who
  // was granted what and for how much. The OUTPUT is counts. Nothing downstream
  // would flag an admin analytics endpoint that quietly echoed the ids it read,
  // and this is the only place that difference is checkable cheaply.
  const r = rewardsNorthStarReport({
    cohort: [
      member("11111111-1111-1111-1111-111111111111", 40, [22], true),
      member("22222222-2222-2222-2222-222222222222", 40, [], false),
    ],
    grades: 3,
    gradingUsers: 2,
    kFactor: null,
    grants: [
      { userId: "11111111-1111-1111-1111-111111111111", costUsd: 5, status: "granted" },
    ],
    nowMs: NOW,
  });

  const serialized = JSON.stringify(r);
  assert(
    !/1111-1111/.test(serialized),
    `a cohort member's id leaked into the report: ${serialized}`,
  );
  assert(
    !/2222-2222/.test(serialized),
    "a cohort member's id leaked into the report",
  );
  // And no uuid-shaped string of any kind, so a future field cannot slip one in.
  assert(
    !/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(serialized),
    `the report contains a uuid-shaped value: ${serialized}`,
  );
});
