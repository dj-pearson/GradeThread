// US-1536 chunk 1: peer-norm statistics core — pure unit tests (no DB/AI).
import { assertEquals } from "@std/assert";
import {
  composeConfidenceCap,
  computePeerQuartiles,
  DEFAULT_PEER_NORM_CONFIG,
  evaluatePeerNorm,
  PEER_NORM_CONFIDENCE_CAP,
  type PeerDistribution,
} from "../lib/peer-norm.ts";

Deno.test("computePeerQuartiles: known distribution", () => {
  // 1..9 → median 5, p25 3, p75 7 (linear interpolation on 9 points)
  const d = computePeerQuartiles([9, 1, 5, 3, 7, 2, 8, 4, 6])!;
  assertEquals(d.sampleSize, 9);
  assertEquals(d.median, 5);
  assertEquals(d.p25, 3);
  assertEquals(d.p75, 7);
});

Deno.test("computePeerQuartiles: empty → null, single value → that value", () => {
  assertEquals(computePeerQuartiles([]), null);
  const one = computePeerQuartiles([6.5])!;
  assertEquals(one, { sampleSize: 1, median: 6.5, p25: 6.5, p75: 6.5 });
});

const PEER: PeerDistribution = { sampleSize: 23, median: 6.5, p25: 6.0, p75: 7.0 };

Deno.test("evaluatePeerNorm: grade inside IQR+margin is not flagged", () => {
  // range with default margin 1.0 → [5.0, 8.0]
  assertEquals(evaluatePeerNorm(6.5, PEER).flagged, false);
  assertEquals(evaluatePeerNorm(5.0, PEER).flagged, false);
  assertEquals(evaluatePeerNorm(8.0, PEER).flagged, false);
});

Deno.test("evaluatePeerNorm: a 9.0 vs median-6.5 peers is flagged + capped", () => {
  const r = evaluatePeerNorm(9.0, PEER);
  assertEquals(r.flagged, true);
  assertEquals(r.confidenceCap, PEER_NORM_CONFIDENCE_CAP);
  assertEquals(r.reason?.includes("above"), true);
  assertEquals(r.reason?.includes("n=23"), true);
  assertEquals(r.reason?.includes("median 6.5"), true);
});

Deno.test("evaluatePeerNorm: a grade below the range is flagged 'below'", () => {
  const r = evaluatePeerNorm(3.0, PEER);
  assertEquals(r.flagged, true);
  assertEquals(r.reason?.includes("below"), true);
});

Deno.test("evaluatePeerNorm: thin sample (n<10) is a no-op", () => {
  const thin: PeerDistribution = { sampleSize: 9, median: 6.5, p25: 6, p75: 7 };
  assertEquals(evaluatePeerNorm(10, thin).flagged, false);
  assertEquals(evaluatePeerNorm(10, null).flagged, false);
});

Deno.test("evaluatePeerNorm: disabled config is a no-op", () => {
  const r = evaluatePeerNorm(10, PEER, { ...DEFAULT_PEER_NORM_CONFIG, enabled: false });
  assertEquals(r.flagged, false);
});

Deno.test("evaluatePeerNorm: margin widens the tolerated band", () => {
  const cfg = { ...DEFAULT_PEER_NORM_CONFIG, iqrMarginPoints: 2.5 };
  // upper becomes 7.0 + 2.5 = 9.5, so 9.0 is now tolerated
  assertEquals(evaluatePeerNorm(9.0, PEER, cfg).flagged, false);
});

Deno.test("composeConfidenceCap: lower value wins; null cap is a passthrough", () => {
  assertEquals(composeConfidenceCap(0.9, PEER_NORM_CONFIDENCE_CAP), 0.7);
  assertEquals(composeConfidenceCap(0.6, PEER_NORM_CONFIDENCE_CAP), 0.6);
  assertEquals(composeConfidenceCap(0.9, null), 0.9);
});
