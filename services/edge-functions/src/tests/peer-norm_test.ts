// US-1536 chunk 1: peer-norm statistics core — pure unit tests (no DB/AI).
import { assertEquals } from "@std/assert";
import {
  composeConfidenceCap,
  computePeerQuartiles,
  DEFAULT_PEER_NORM_CONFIG,
  defectCountBucket,
  evaluatePeerNorm,
  maxSeverityBucket,
  PEER_NORM_CONFIDENCE_CAP,
  type PeerDistribution,
  peerProfileCell,
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

Deno.test("defectCountBucket: low-cardinality buckets", () => {
  assertEquals(defectCountBucket(0), "0");
  assertEquals(defectCountBucket(-1), "0");
  assertEquals(defectCountBucket(1), "1");
  assertEquals(defectCountBucket(2), "2-3");
  assertEquals(defectCountBucket(3), "2-3");
  assertEquals(defectCountBucket(4), "4+");
  assertEquals(defectCountBucket(50), "4+");
});

Deno.test("maxSeverityBucket: highest present, ignores unknowns, none when empty", () => {
  assertEquals(maxSeverityBucket([]), "none");
  assertEquals(maxSeverityBucket(["minor", "moderate"]), "moderate");
  assertEquals(maxSeverityBucket(["minor", "major", "moderate"]), "major");
  assertEquals(maxSeverityBucket(["minor", "bogus"]), "minor");
  assertEquals(maxSeverityBucket(["unknown"]), "none");
});

Deno.test("peerProfileCell: composes category/brand + defect profile", () => {
  assertEquals(
    peerProfileCell({
      garmentCategory: "jacket",
      brand: "  Nike ",
      defectSeverities: ["minor", "major"],
    }),
    { garmentCategory: "jacket", brand: "Nike", defectCountBucket: "2-3", maxSeverity: "major" },
  );
  // blank brand → category-only cell; no defects → clean profile
  assertEquals(
    peerProfileCell({ garmentCategory: "tee", brand: "  ", defectSeverities: [] }),
    { garmentCategory: "tee", brand: null, defectCountBucket: "0", maxSeverity: "none" },
  );
});

// ── US-1536 final chunk: pure peer selection (brand refinement + cell filter) ─

const { selectPeerGrades } = await import("../lib/peer-norm.ts");

function cand(finalGrade: number, brand: string | null, severities: string[]) {
  return { finalGrade, brand, severities };
}

Deno.test("US-1536: selectPeerGrades filters to the defect-profile cell", () => {
  const cell = peerProfileCell({
    garmentCategory: "jacket",
    brand: null,
    defectSeverities: ["minor", "moderate"], // bucket 2-3, max moderate
  });
  const grades = selectPeerGrades(
    [
      cand(7.0, null, ["minor", "minor"]), // 2-3 + minor max → different cell
      cand(6.5, null, ["moderate", "minor"]), // matches
      cand(6.0, null, ["moderate", "minor", "minor"]), // matches (2-3, moderate)
      cand(9.0, null, []), // clean item → different cell
      cand(3.0, null, ["major", "major", "major", "major"]), // 4+ major → different
    ],
    cell,
    10,
  );
  assertEquals(grades.sort(), [6.0, 6.5]);
});

Deno.test("US-1536: brand refinement applies only at/above the sample floor", () => {
  const cell = peerProfileCell({
    garmentCategory: "jeans",
    brand: "Levi's",
    defectSeverities: ["minor"],
  });
  const brandPeers = Array.from({ length: 10 }, () => cand(6.0, "Levi's", ["minor"]));
  const otherPeers = Array.from({ length: 20 }, () => cand(9.0, "Wrangler", ["minor"]));

  // 10 brand samples clear the floor → brand-only cohort.
  const refined = selectPeerGrades([...brandPeers, ...otherPeers], cell, 10);
  assertEquals(refined.length, 10);
  assertEquals(refined.every((g) => g === 6.0), true);

  // Below the floor → the whole category cohort is used instead.
  const sparse = selectPeerGrades([...brandPeers.slice(0, 4), ...otherPeers], cell, 10);
  assertEquals(sparse.length, 24);
});

Deno.test("US-1536: brand matching is case/whitespace-insensitive", () => {
  const cell = peerProfileCell({
    garmentCategory: "jeans",
    brand: "levi's",
    defectSeverities: [],
  });
  const grades = selectPeerGrades(
    Array.from({ length: 10 }, () => cand(8.0, "  LEVI'S ", [])),
    cell,
    10,
  );
  assertEquals(grades.length, 10);
});
