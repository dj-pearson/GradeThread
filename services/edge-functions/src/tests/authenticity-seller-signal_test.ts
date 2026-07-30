// US-2148: per-seller authenticity aggregation + batch detection. Pure logic.

import { assert, assertEquals } from "@std/assert";
import {
  CLUSTER_THRESHOLD,
  CLUSTER_WINDOW_DAYS,
  correlatedBatchHold,
  peakClusterSize,
  summarizeSellerAuthenticity,
  type SellerAuthenticityRecord,
} from "../lib/authenticity-seller-signal.ts";

const day = (n: number) => new Date(Date.UTC(2026, 0, n)).toISOString();

const rec = (
  seller: string,
  d: number,
  model: string | null,
  reviewer: string | null,
): SellerAuthenticityRecord => ({
  seller_id: seller,
  occurred_at: day(d),
  model_verdict: model,
  reviewer_verdict: reviewer,
});

Deno.test("confirmed counterfeits and model flags are counted separately", () => {
  // The distinction is the point: a model verdict is indicative (the pass is not
  // gated), a human verdict is load-bearing.
  const [s] = summarizeSellerAuthenticity([
    rec("s1", 1, "red_flags", null),
    rec("s1", 2, "red_flags", "counterfeit"),
    rec("s1", 3, "red_flags", "authentic"),
  ]);
  assertEquals(s.assessed, 3);
  assertEquals(s.model_flagged, 3);
  assertEquals(s.confirmed_counterfeit, 1);
  // A human clearing a flagged item is evidence the flag was a false alarm, and
  // is tracked so a seller is not judged purely on model output.
  assertEquals(s.confirmed_authentic, 1);
});

Deno.test("a batch clusters; the same count spread out does not", () => {
  const burst = summarizeSellerAuthenticity([
    rec("s1", 1, "red_flags", "counterfeit"),
    rec("s1", 3, "red_flags", "counterfeit"),
    rec("s1", 5, "red_flags", "counterfeit"),
  ])[0];
  assertEquals(burst.peak_cluster, 3);
  assert(burst.clustered, "three confirmed fakes in five days is one consignment");

  const spread = summarizeSellerAuthenticity([
    rec("s2", 1, "red_flags", "counterfeit"),
    rec("s2", 100, "red_flags", "counterfeit"),
    rec("s2", 200, "red_flags", "counterfeit"),
  ])[0];
  assertEquals(spread.confirmed_counterfeit, 3, "same total…");
  assertEquals(spread.peak_cluster, 1, "…but no batch signature");
  assertEquals(spread.clustered, false);
});

Deno.test("only CONFIRMED counterfeits feed the cluster, never model verdicts", () => {
  // Otherwise an ungated model could manufacture a batch signature on its own.
  const [s] = summarizeSellerAuthenticity([
    rec("s1", 1, "red_flags", null),
    rec("s1", 2, "red_flags", null),
    rec("s1", 3, "red_flags", null),
  ]);
  assertEquals(s.model_flagged, 3);
  assertEquals(s.peak_cluster, 0);
  assertEquals(s.clustered, false);
});

Deno.test("sellers are kept separate", () => {
  const out = summarizeSellerAuthenticity([
    rec("s1", 1, "red_flags", "counterfeit"),
    rec("s2", 1, "red_flags", "counterfeit"),
  ]);
  assertEquals(out.length, 2);
  assertEquals(out.every((s) => s.confirmed_counterfeit === 1), true);
});

Deno.test("clustered sellers sort ahead of higher-volume unclustered ones", () => {
  const out = summarizeSellerAuthenticity([
    // Higher total, spread over a year — a bad run, not a batch.
    rec("spread", 1, null, "counterfeit"),
    rec("spread", 90, null, "counterfeit"),
    rec("spread", 180, null, "counterfeit"),
    rec("spread", 270, null, "counterfeit"),
    // Lower total, same week — the shape that breaks the claims budget.
    rec("burst", 1, null, "counterfeit"),
    rec("burst", 2, null, "counterfeit"),
    rec("burst", 3, null, "counterfeit"),
  ]);
  assertEquals(out[0].seller_id, "burst");
});

Deno.test("last_confirmed_at is the most recent confirmation, null when none", () => {
  const [s] = summarizeSellerAuthenticity([
    rec("s1", 5, null, "counterfeit"),
    rec("s1", 1, null, "counterfeit"),
  ]);
  assertEquals(s.last_confirmed_at, day(5));

  const [clean] = summarizeSellerAuthenticity([rec("s2", 1, "likely_authentic", null)]);
  assertEquals(clean.last_confirmed_at, null);
});

// ── AC5: the guarantee's correlated-batch hold ──────────────────────────────
//
// The ADR's flaw #2 is that the claims budget's breaker "trips AFTER the batch
// has already drawn down". These assert the leading indicator that moves the
// protection ahead of the drawdown.

const NOW = Date.UTC(2026, 5, 1);
const agoDays = (n: number) => NOW - n * 86_400_000;

Deno.test("hold: a live batch holds, the same count long past does not", () => {
  const live = Array.from({ length: CLUSTER_THRESHOLD }, (_, i) => agoDays(i * 2));
  assertEquals(correlatedBatchHold(live, NOW).held, true);

  // Identical count, but the batch is over — the budget is no longer at risk
  // from it, and holding here would just delay unrelated buyers forever.
  const old = live.map((t) => t - (CLUSTER_WINDOW_DAYS + 5) * 86_400_000);
  const past = correlatedBatchHold(old, NOW);
  assertEquals(past.confirmedInWindow, 0);
  assertEquals(past.held, false);
});

Deno.test("hold: one under the threshold does not hold", () => {
  const near = Array.from({ length: CLUSTER_THRESHOLD - 1 }, (_, i) => agoDays(i));
  const r = correlatedBatchHold(near, NOW);
  assertEquals(r.confirmedInWindow, CLUSTER_THRESHOLD - 1);
  assertEquals(r.held, false, "the console's cluster definition is the hold's definition");
});

Deno.test("hold: a clean seller never holds", () => {
  assertEquals(correlatedBatchHold([], NOW), { held: false, confirmedInWindow: 0 });
});

Deno.test("hold: the window boundary is inclusive, and skew does not drop a report", () => {
  // Exactly on the edge counts — an off-by-one here silently shrinks the window.
  assertEquals(correlatedBatchHold([agoDays(CLUSTER_WINDOW_DAYS)], NOW).confirmedInWindow, 1);
  assertEquals(correlatedBatchHold([agoDays(CLUSTER_WINDOW_DAYS) - 1], NOW).confirmedInWindow, 0);
  // A row stamped a moment ahead of our clock is part of the live batch.
  assertEquals(correlatedBatchHold([NOW + 1000], NOW).confirmedInWindow, 1);
});

Deno.test("hold: an unparseable timestamp is skipped, not counted", () => {
  // Date.parse of junk is NaN; counting it would fabricate a batch member.
  const times = [agoDays(1), Number.NaN, agoDays(2)];
  assertEquals(correlatedBatchHold(times, NOW).confirmedInWindow, 2);
});

Deno.test("peakClusterSize slides rather than bucketing", () => {
  const t = (d: number) => Date.UTC(2026, 0, d);
  // A fixed calendar bucket would split this pair across a month boundary and
  // miss the batch; a sliding window catches it.
  assertEquals(peakClusterSize([t(30), t(32)], 30 * 86_400_000), 2);
  assertEquals(peakClusterSize([], 30 * 86_400_000), 0);
  assert(CLUSTER_THRESHOLD > 1);
});
