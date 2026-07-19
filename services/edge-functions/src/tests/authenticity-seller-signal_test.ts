// US-2148: per-seller authenticity aggregation + batch detection. Pure logic.

import { assert, assertEquals } from "@std/assert";
import {
  CLUSTER_THRESHOLD,
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

Deno.test("peakClusterSize slides rather than bucketing", () => {
  const t = (d: number) => Date.UTC(2026, 0, d);
  // A fixed calendar bucket would split this pair across a month boundary and
  // miss the batch; a sliding window catches it.
  assertEquals(peakClusterSize([t(30), t(32)], 30 * 86_400_000), 2);
  assertEquals(peakClusterSize([], 30 * 86_400_000), 0);
  assert(CLUSTER_THRESHOLD > 1);
});
