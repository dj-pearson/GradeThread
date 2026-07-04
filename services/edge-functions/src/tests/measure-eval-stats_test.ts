// US-1580: the accuracy stats + release gate — the math that decides whether
// "accurate" is a word we're allowed to use. Plus the telemetry-endpoint
// source contracts (deltas only, never photo content).
//
//   deno test --allow-env --allow-read src/tests/measure-eval-stats_test.ts

import { assert, assertEquals } from "@std/assert";
import {
  GATE_P50_IN,
  GATE_P95_IN,
  percentile,
  releaseGate,
  summarize,
  type EvalCase,
} from "../lib/measure-eval-stats.ts";

function mk(
  key: string,
  truth: number,
  pred: number | null,
  cls = "top",
): EvalCase {
  return {
    garmentId: `g-${key}-${truth}`,
    garmentClass: cls,
    measurementKey: key,
    truthInches: truth,
    predictedInches: pred,
  };
}

Deno.test("percentile interpolates", () => {
  assertEquals(percentile([1, 2, 3, 4], 0.5), 2.5);
  assertEquals(percentile([5], 0.95), 5);
  assertEquals(percentile([0, 10], 0.25), 2.5);
});

Deno.test("summarize groups by class+key, reports bias and misses", () => {
  const stats = summarize([
    mk("chest", 22, 22.25),
    mk("chest", 20, 20.25),
    mk("chest", 24, null), // miss
    mk("length", 28, 27.5, "bottom"),
  ]);
  assertEquals(stats.length, 2);
  const chest = stats.find((s) => s.measurementKey === "chest")!;
  assertEquals(chest.n, 3);
  assertEquals(chest.misses, 1);
  assert(Math.abs(chest.meanSigned - 0.25) < 1e-9, "reads long by 0.25");
  assertEquals(chest.p50, 0.25);
});

Deno.test("release gate passes only within p50<=0.25 AND p95<=0.5 with zero misses", () => {
  const good = Array.from({ length: 40 }, (_, i) =>
    mk(`k${i}`, 20, 20 + (i % 2 === 0 ? 0.1 : -0.2)));
  const g1 = releaseGate(good);
  assert(g1.pass, g1.reasons.join(","));
  assert(g1.p50 <= GATE_P50_IN && g1.p95 <= GATE_P95_IN);

  // A single 1-inch outlier in 40 survives p95 (that's what p95 means)…
  const oneOutlier = [...good.slice(0, 39), mk("bad", 20, 21)];
  assert(releaseGate(oneOutlier).pass, "p95 tolerates <5% outliers by design");
  // …but 3 of 40 (7.5%) blow it.
  const outliers = [
    ...good.slice(0, 37),
    mk("bad1", 20, 21),
    mk("bad2", 20, 21),
    mk("bad3", 20, 21),
  ];
  const g2 = releaseGate(outliers);
  assert(!g2.pass);
  assert(g2.reasons.some((r) => r.includes("p95")));

  // A miss fails the gate even when the measured errors are tiny.
  const withMiss = [...good.slice(0, 39), mk("gone", 20, null)];
  const g3 = releaseGate(withMiss);
  assert(!g3.pass);
  assert(g3.reasons.some((r) => r.includes("missed")));

  // Empty set never passes.
  assert(!releaseGate([]).pass);
});

// ── Telemetry endpoint source contracts ─────────────────────────────

const routeSrc = await Deno.readTextFile(
  new URL("../routes/flipdesk-measure.ts", import.meta.url),
);

Deno.test("US-1580: correction telemetry stores deltas only, owner-stamped, never billed", () => {
  const start = routeSrc.indexOf('post("/correction"');
  assert(start > 0);
  const block = routeSrc.slice(start);
  assert(block.includes("owner_user_id: ownerId"));
  assert(block.includes("delta_inches"));
  // No photo/storage content flows into telemetry.
  assert(!block.includes("storage_path"));
  assert(!block.includes("downloadItemPhoto"));
  // And no metering: telemetry is free.
  assert(!block.includes("withAiAction"));
  // Plausibility bounds reject garbage.
  assert(block.includes("v > 0 && v < 200"));
});

Deno.test("US-1580: eval script enforces the gate exit code", async () => {
  const evalSrc = await Deno.readTextFile(
    new URL("../../scripts/measure-eval.ts", import.meta.url),
  );
  assert(evalSrc.includes("releaseGate(cases)"));
  assert(evalSrc.includes("Deno.exit(gate.pass ? 0 : 1)"));
  assert(evalSrc.includes("estimated from photo"), "keeps the honest-copy reminder");
});
