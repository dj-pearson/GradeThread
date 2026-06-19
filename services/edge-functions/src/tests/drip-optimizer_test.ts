import { assert, assertEquals } from "@std/assert";
import {
  applyOptimizationToGraph,
  DEFAULT_OPTIMIZER_CONFIG,
  optimizeGraph,
  optimizeStep,
  selectWinner,
  type VariantStats,
} from "../lib/drip-optimizer.ts";
import type { DripGraph } from "../lib/drip-graph.ts";

// US-944: the per-step A/B optimizer is pure — no supabase/env — so it tests
// directly (mirrors drip-graph_test.ts).

function vs(variantId: string, over: Partial<VariantStats> = {}): VariantStats {
  return { variantId, sent: 0, opened: 0, clicked: 0, converted: 0, unsubscribed: 0, ...over };
}

function byId(...stats: VariantStats[]): Record<string, VariantStats> {
  return Object.fromEntries(stats.map((s) => [s.variantId, s]));
}

Deno.test("selectWinner needs the minimum sample (no spurious small-cohort winner)", () => {
  // B converts 100% but on only 3 sends — below threshold ⇒ no winner.
  const stats = [vs("A", { sent: 200, converted: 20 }), vs("B", { sent: 3, converted: 3 })];
  assertEquals(selectWinner(stats), "A");
  // With BOTH below threshold there is no trusted winner at all.
  const tiny = [vs("A", { sent: 5, converted: 1 }), vs("B", { sent: 3, converted: 3 })];
  assertEquals(selectWinner(tiny), null);
});

Deno.test("selectWinner optimizes for conversion, with click as the secondary signal", () => {
  // A has more clicks but B converts better → B wins (conversion is the goal).
  const stats = [
    vs("A", { sent: 100, clicked: 80, converted: 5 }),
    vs("B", { sent: 100, clicked: 40, converted: 12 }),
  ];
  assertEquals(selectWinner(stats), "B");
  // Tie on conversion → click breaks it.
  const tie = [
    vs("A", { sent: 100, clicked: 20, converted: 10 }),
    vs("B", { sent: 100, clicked: 55, converted: 10 }),
  ];
  assertEquals(selectWinner(tie), "B");
});

Deno.test("optimizeStep: higher-converting variant becomes the default with an exploration floor", () => {
  const opt = optimizeStep(
    ["A", "B"],
    byId(
      vs("A", { sent: 500, opened: 250, clicked: 120, converted: 60 }), // 12% conv
      vs("B", { sent: 500, opened: 240, clicked: 110, converted: 20 }), // 4% conv
    ),
  );
  assertEquals(opt.winnerId, "A");
  assert(opt.hasEnoughData);
  // Winner becomes the dominant default…
  assert(opt.recommendedWeights.A > opt.recommendedWeights.B);
  assert(opt.recommendedWeights.A >= 80);
  // …but the loser keeps a non-zero exploration trickle (floor).
  assert(opt.recommendedWeights.B > 0);
  // Weights are a clean distribution.
  assertEquals(opt.recommendedWeights.A + opt.recommendedWeights.B, 100);
});

Deno.test("optimizeStep retires a high-unsub variant (weight → 0)", () => {
  const opt = optimizeStep(
    ["A", "B"],
    byId(
      vs("A", { sent: 400, converted: 30, unsubscribed: 2 }), // 0.5% unsub
      vs("B", { sent: 400, converted: 35, unsubscribed: 40 }), // 10% unsub → retire
    ),
  );
  const b = opt.scores.find((s) => s.variantId === "B")!;
  assert(b.retired);
  assertEquals(opt.recommendedWeights.B, 0);
  // A absorbs the full weight even though B converted slightly better.
  assertEquals(opt.recommendedWeights.A, 100);
  assertEquals(opt.winnerId, "A");
});

Deno.test("optimizeStep never retires the last surviving arm", () => {
  // Both arms have high unsub — keep the lower-unsub one alive rather than 0/0.
  const opt = optimizeStep(
    ["A", "B"],
    byId(
      vs("A", { sent: 200, converted: 10, unsubscribed: 20 }), // 10%
      vs("B", { sent: 200, converted: 10, unsubscribed: 30 }), // 15%
    ),
  );
  const survivors = opt.scores.filter((s) => !s.retired);
  assertEquals(survivors.length, 1);
  assertEquals(survivors[0]!.variantId, "A"); // lower unsub kept
  assertEquals(opt.recommendedWeights.A, 100);
});

Deno.test("optimizeStep keeps uniform weights below the sample threshold", () => {
  const opt = optimizeStep(
    ["A", "B", "C"],
    byId(
      vs("A", { sent: 5, converted: 1 }),
      vs("B", { sent: 4, converted: 0 }),
      vs("C", { sent: 3, converted: 2 }),
    ),
  );
  assertEquals(opt.winnerId, null);
  assert(!opt.hasEnoughData);
  // No premature convergence — weights stay ~uniform (sum 100, spread out).
  assertEquals(opt.recommendedWeights.A + opt.recommendedWeights.B + opt.recommendedWeights.C, 100);
  for (const w of Object.values(opt.recommendedWeights)) assert(w >= 33 && w <= 34);
});

// Simulated cohorts: the closed loop converges the default onto the better arm
// and retires the high-unsub arm over repeated tuning rounds (AC #5).
Deno.test("simulated cohorts: winner becomes default, high-unsub arm retired", () => {
  // Deterministic pseudo-cohort: A converts at 14%, B at 4%, and a third arm C
  // converts well (10%) but drives a 9% unsub. Each round sends a fresh cohort
  // weighted by the current weights and re-tunes.
  let graph: DripGraph = {
    entryStepId: "s1",
    steps: [{
      id: "s1",
      label: "Test step",
      phase: "in_trial",
      trigger: "t",
      anchor: "enrollment",
      delayHours: 0,
      conditions: [],
      brief: "",
      incentiveEnabled: false,
      branches: [],
      next: null,
      exit: true,
      variants: [
        { id: "A", weight: 34, subject: "a", html: "<p>a</p>" },
        { id: "B", weight: 33, subject: "b", html: "<p>b</p>" },
        { id: "C", weight: 33, subject: "c", html: "<p>c</p>" },
      ],
    }],
  };

  const TRUTH: Record<string, { conv: number; unsub: number }> = {
    A: { conv: 0.14, unsub: 0.004 },
    B: { conv: 0.04, unsub: 0.004 },
    C: { conv: 0.10, unsub: 0.09 },
  };
  const cohortSize = 3000;
  // The ledger is cumulative over the window — sends accumulate across rounds
  // (a retired arm that stops getting traffic keeps its damning history).
  const ledger: Record<string, VariantStats> = {
    A: vs("A"),
    B: vs("B"),
    C: vs("C"),
  };

  for (let round = 0; round < 6; round++) {
    const step = graph.steps[0]!;
    const totalW = step.variants.reduce((s, v) => s + v.weight, 0) || 1;
    for (const v of step.variants) {
      const sent = Math.round((v.weight / totalW) * cohortSize);
      const t = TRUTH[v.id]!;
      const acc = ledger[v.id]!;
      acc.sent += sent;
      acc.clicked += Math.round(sent * 0.3);
      acc.converted += Math.round(sent * t.conv);
      acc.unsubscribed += Math.round(sent * t.unsub);
    }
    const opts = optimizeGraph(graph, { 1: ledger });
    graph = applyOptimizationToGraph(graph, opts);
  }

  const final = graph.steps[0]!.variants;
  const w = Object.fromEntries(final.map((v) => [v.id, v.weight]));
  // A (best converter, low unsub) is the dominant default.
  assert(w.A > w.B, `A(${w.A}) should beat B(${w.B})`);
  assert(w.A > w.C, `A(${w.A}) should beat C(${w.C})`);
  assert(w.A >= 70, `A should dominate, got ${w.A}`);
  // C is retired for its high unsub despite decent conversion.
  assertEquals(w.C, 0);
});

Deno.test("optimizeGraph flags changed steps and leaves single-variant steps alone", () => {
  const graph: DripGraph = {
    entryStepId: "s1",
    steps: [
      {
        id: "s1",
        label: "AB step",
        phase: "in_trial",
        trigger: "t",
        anchor: "enrollment",
        delayHours: 0,
        conditions: [],
        brief: "",
        incentiveEnabled: false,
        branches: [],
        next: "s2",
        exit: false,
        variants: [
          { id: "A", weight: 50, subject: "a", html: "<p>a</p>" },
          { id: "B", weight: 50, subject: "b", html: "<p>b</p>" },
        ],
      },
      {
        id: "s2",
        label: "single",
        phase: "win_back",
        trigger: "t",
        anchor: "trial_end",
        delayHours: 24,
        conditions: [],
        brief: "",
        incentiveEnabled: false,
        branches: [],
        next: null,
        exit: true,
        variants: [{ id: "A", weight: 100, subject: "x", html: "<p>x</p>" }],
      },
    ],
  };

  const opts = optimizeGraph(graph, {
    1: byId(
      vs("A", { sent: 400, converted: 60 }),
      vs("B", { sent: 400, converted: 10 }),
    ),
  });
  const s1 = opts.find((o) => o.stepId === "s1")!;
  const s2 = opts.find((o) => o.stepId === "s2")!;
  assert(s1.changed);
  assert(!s2.changed); // single variant — never changed

  const applied = applyOptimizationToGraph(graph, opts);
  // single-variant step untouched
  assertEquals(applied.steps[1]!.variants[0]!.weight, 100);
  // AB step shifted toward A
  const av = applied.steps[0]!.variants.find((v) => v.id === "A")!;
  assert(av.weight >= 80);
});

Deno.test("DEFAULT_OPTIMIZER_CONFIG is sane", () => {
  assert(DEFAULT_OPTIMIZER_CONFIG.minSample >= 1);
  assert(DEFAULT_OPTIMIZER_CONFIG.explorationFloor > 0 && DEFAULT_OPTIMIZER_CONFIG.explorationFloor < 1);
  assert(DEFAULT_OPTIMIZER_CONFIG.unsubRetireRate > 0 && DEFAULT_OPTIMIZER_CONFIG.unsubRetireRate < 1);
});
