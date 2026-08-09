// US-1915 AC1: the north-star metric definitions.
//
// These are ratios, and the arithmetic is trivial. What these cases actually pin
// are the DEFINITIONS — the decisions that make a number mean the wrong thing
// without ever looking broken:
//
//   * an immature cohort is EXCLUDED, not counted as churned;
//   * an empty denominator yields null, never 0 and never Infinity;
//   * "active" means users who DID the thing, not users who exist;
//   * K is per SHARER, not per user;
//   * only COMMITTED spend counts as cost.
//
// Pure module: no env, no DB, no import side effects.
import { assertEquals } from "@std/assert";

import {
  COMMITTED_GRANT_STATUSES,
  costPerRetainedUser,
  gradesPerActiveUser,
  shareKFactor,
  weekFourRetention,
} from "../lib/rewards-north-star.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

// ─── Week-4 retention ───────────────────────────────────────────────────────

Deno.test("US-1915: activity inside days 21-27 counts as retained", () => {
  const r = weekFourRetention(
    [{ userId: "u1", signedUpAt: iso(T0), activeAt: [iso(T0 + 22 * DAY)] }],
    T0 + 40 * DAY,
  );
  assertEquals(r, { eligible: 1, retained: 1, rate: 1, undecided: 0 });
});

Deno.test("US-1915: activity BEFORE week 4 does not count — this measures coming back", () => {
  // A user who used it hard for three days and never returned is the exact
  // shape retention is supposed to catch.
  const r = weekFourRetention(
    [{
      userId: "u1",
      signedUpAt: iso(T0),
      activeAt: [iso(T0), iso(T0 + DAY), iso(T0 + 3 * DAY), iso(T0 + 20 * DAY)],
    }],
    T0 + 40 * DAY,
  );
  assertEquals(r.eligible, 1);
  assertEquals(r.retained, 0);
  assertEquals(r.rate, 0);
});

Deno.test("US-1915: day 28 is OUTSIDE the window — the boundary is exclusive", () => {
  const r = weekFourRetention(
    [{ userId: "u1", signedUpAt: iso(T0), activeAt: [iso(T0 + 28 * DAY)] }],
    T0 + 40 * DAY,
  );
  assertEquals(r.retained, 0, "day 28 belongs to week 5");
  const onLastMs = weekFourRetention(
    [{ userId: "u1", signedUpAt: iso(T0), activeAt: [iso(T0 + 28 * DAY - 1)] }],
    T0 + 40 * DAY,
  );
  assertEquals(onLastMs.retained, 1, "the final millisecond of day 27 still counts");
});

Deno.test("US-1915: ⚠ an immature cohort member is UNDECIDED, not churned", () => {
  // THE CASE THIS FILE EXISTS FOR. A user who signed up nine days ago has not
  // failed week-4 retention — they have not reached it. Counting them in the
  // denominator understates retention, and understates it WORST when growth is
  // fastest, so the metric appears to fall while the product improves.
  const r = weekFourRetention(
    [
      { userId: "old", signedUpAt: iso(T0), activeAt: [iso(T0 + 22 * DAY)] },
      { userId: "new", signedUpAt: iso(T0 + 31 * DAY), activeAt: [] },
    ],
    T0 + 40 * DAY,
  );
  assertEquals(r.eligible, 1, "only the aged-in member is judged");
  assertEquals(r.retained, 1);
  assertEquals(r.rate, 1, "NOT 0.5 — the young account is not a churned account");
  assertEquals(r.undecided, 1, "and the exclusion is reported, not silent");
});

Deno.test("US-1915: a cohort with nobody aged in yields null, not zero", () => {
  const r = weekFourRetention(
    [{ userId: "new", signedUpAt: iso(T0 + 39 * DAY), activeAt: [] }],
    T0 + 40 * DAY,
  );
  assertEquals(r.eligible, 0);
  assertEquals(r.rate, null, "'no data yet' and '0% retention' are opposite claims");
  assertEquals(r.undecided, 1);
});

Deno.test("US-1915: an unparseable signup is undecided, not a churn signal", () => {
  const r = weekFourRetention(
    [{ userId: "bad", signedUpAt: "not a date", activeAt: [] }],
    T0 + 40 * DAY,
  );
  assertEquals(r.undecided, 1);
  assertEquals(r.eligible, 0, "a data problem must not be counted as behaviour");
});

// ─── Grades per active user ─────────────────────────────────────────────────

Deno.test("US-1915: grades per ACTIVE user, and empty is null", () => {
  assertEquals(gradesPerActiveUser(30, 10).perUser, 3);
  assertEquals(
    gradesPerActiveUser(0, 0).perUser,
    null,
    "nobody graded is not 'zero grades each'",
  );
  // Defensive: a negative or fractional count from a bad query never produces a
  // nonsense ratio.
  assertEquals(gradesPerActiveUser(-5, 10).grades, 0);
  assertEquals(gradesPerActiveUser(10.7, 3.9).perUser, 10 / 3);
});

// ─── K-factor ───────────────────────────────────────────────────────────────

Deno.test("US-1915: K is conversions per SHARER, with both components exposed", () => {
  const k = shareKFactor({ sharers: 10, shares: 40, conversions: 5 });
  assertEquals(k.sharesPerSharer, 4, "how loudly a sharer shares");
  assertEquals(k.conversionRate, 0.125, "how well a share converts");
  assertEquals(k.k, 0.5, "and K reduces to conversions / sharers");
});

Deno.test("US-1915: the same K can come from opposite products", () => {
  // Why both components are returned rather than just K: the fix differs. Many
  // weak shares needs a better asset; few strong shares needs a better prompt.
  const loud = shareKFactor({ sharers: 10, shares: 100, conversions: 10 });
  const quiet = shareKFactor({ sharers: 10, shares: 10, conversions: 10 });
  assertEquals(loud.k, 1);
  assertEquals(quiet.k, 1);
  assertEquals(loud.conversionRate, 0.1);
  assertEquals(quiet.conversionRate, 1, "same K, ten times the conversion rate");
});

Deno.test("US-1915: no sharers yields null K, not zero", () => {
  const k = shareKFactor({ sharers: 0, shares: 0, conversions: 0 });
  assertEquals(k.k, null);
  assertEquals(k.sharesPerSharer, null);
  assertEquals(k.conversionRate, null);
});

// ─── Cost per retained user ─────────────────────────────────────────────────

Deno.test("US-1915: ⚠ only COMMITTED spend counts as cost", () => {
  // An expired or reversed grant is a line in a table, not money. Counting it
  // inflates the cost of retention and would argue for killing a mechanic that
  // is in fact cheap.
  const r = costPerRetainedUser(
    [
      { userId: "a", costUsd: 10, status: "granted" },
      { userId: "b", costUsd: 5, status: "consumed" },
      { userId: "c", costUsd: 99, status: "expired" },
      { userId: "d", costUsd: 99, status: "reversed" },
    ],
    3,
  );
  assertEquals(r.costUsd, 15, "the two uncommitted grants are not money");
  assertEquals(r.uncommittedGrants, 2, "and the exclusion is reported");
  assertEquals(r.perRetainedUsd, 5);
});

Deno.test("US-1915: the committed-status list is the one the code uses", () => {
  // Pinned so a status added to the table without a decision here cannot
  // silently start counting as spend — or silently stop.
  assertEquals([...COMMITTED_GRANT_STATUSES].sort(), ["consumed", "granted"]);
});

Deno.test("US-1915: cost with nobody retained is null, never a division blowup", () => {
  const r = costPerRetainedUser([{ userId: "a", costUsd: 10, status: "granted" }], 0);
  assertEquals(r.costUsd, 10);
  assertEquals(r.perRetainedUsd, null, "not Infinity, which renders as nothing useful");
});

Deno.test("US-1915: money is rounded to cents, not float noise", () => {
  const r = costPerRetainedUser(
    [
      { userId: "a", costUsd: 0.1, status: "granted" },
      { userId: "b", costUsd: 0.2, status: "granted" },
    ],
    2,
  );
  assertEquals(r.costUsd, 0.3, "0.1 + 0.2 must not surface as 0.30000000000000004");
  assertEquals(r.perRetainedUsd, 0.15);
});
