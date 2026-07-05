// US-1602: Growth agent pure domain logic — funnel normalize/conversion/cliff,
// week-over-week regressions, program health, and the assembled memo.
import { assert, assertEquals } from "@std/assert";
import {
  assembleGrowthMemo,
  compareFunnels,
  computeFunnelConversion,
  funnelCliff,
  normalizeFunnel,
  summarizeProgramHealth,
} from "../lib/growth-agent.ts";

const funnelDoc = (counts: number[]) => ({
  period: { start: "a", end: "b" },
  steps: [
    { key: "signed_up", label: "Signed up", count: counts[0] },
    { key: "submitted", label: "First submission", count: counts[1] },
    { key: "graded", label: "First grade", count: counts[2] },
    { key: "subscribed", label: "Subscribed", count: counts[3] },
  ],
});

// ── Normalize + conversion ───────────────────────────────────────────────────

Deno.test("normalizeFunnel: extracts steps, tolerates a bad shape", () => {
  assertEquals(normalizeFunnel(funnelDoc([100, 40, 38, 10])).length, 4);
  assertEquals(normalizeFunnel(null), []);
  assertEquals(normalizeFunnel({ nope: 1 }), []);
});

Deno.test("computeFunnelConversion: step-to-step ratios, 0 when the prior step is 0", () => {
  const conv = computeFunnelConversion(normalizeFunnel(funnelDoc([1000, 400, 380, 40])));
  assertEquals(conv[0].conversion, 0.4); // 400/1000
  assertEquals(conv[1].conversion, 0.95); // 380/400
  const zero = computeFunnelConversion([{ key: "a", label: "", count: 0 }, { key: "b", label: "", count: 5 }]);
  assertEquals(zero[0].conversion, 0);
});

Deno.test("funnelCliff: returns the lowest-conversion transition", () => {
  const cliff = funnelCliff(computeFunnelConversion(normalizeFunnel(funnelDoc([1000, 400, 380, 40]))));
  assertEquals(cliff?.from, "graded"); // 40/380 ≈ 0.105 is the worst
  assertEquals(cliff?.to, "subscribed");
});

// ── Week-over-week regressions ───────────────────────────────────────────────

Deno.test("compareFunnels: flags a conversion that dropped beyond the band", () => {
  const cur = computeFunnelConversion(normalizeFunnel(funnelDoc([1000, 300, 285, 30]))); // signup→submit 0.30
  const prior = computeFunnelConversion(normalizeFunnel(funnelDoc([1000, 400, 380, 40]))); // was 0.40
  const regs = compareFunnels(cur, prior);
  assert(regs.some((r) => r.from === "signed_up" && r.to === "submitted" && r.drop >= 0.05));
});

Deno.test("compareFunnels: a small wobble under the band is not a regression", () => {
  const cur = computeFunnelConversion(normalizeFunnel(funnelDoc([1000, 390, 380, 40])));
  const prior = computeFunnelConversion(normalizeFunnel(funnelDoc([1000, 400, 380, 40])));
  assertEquals(compareFunnels(cur, prior).length, 0); // 0.39 vs 0.40 = 0.01 drop
});

// ── Program health ───────────────────────────────────────────────────────────

Deno.test("summarizeProgramHealth: growing / declining / unknown verdicts", () => {
  assertEquals(summarizeProgramHealth(120, 100).verdict, "growing");
  assertEquals(summarizeProgramHealth(80, 100).verdict, "declining");
  assertEquals(summarizeProgramHealth(5, 0).verdict, "growing"); // prior 0, now >0
  assertEquals(summarizeProgramHealth(0, 0).verdict, "unknown");
});

// ── Memo ─────────────────────────────────────────────────────────────────────

Deno.test("assembleGrowthMemo: notable when a regression or a declining program shows", () => {
  const memo = assembleGrowthMemo({
    currentFunnel: funnelDoc([1000, 300, 285, 30]),
    priorFunnel: funnelDoc([1000, 400, 380, 40]),
    referralsCurrent: 80,
    referralsPrior: 100,
    priorSlate: { items: ["prior idea"] },
  });
  assertEquals(memo.notable, true);
  assert(memo.regressions.length >= 1);
  assertEquals(memo.program_health.verdict, "declining");
  assertEquals(memo.cliff?.to, "subscribed"); // 30/285 worst
  assertEquals(memo.prior_slate, { items: ["prior idea"] }); // continuity preserved
});

Deno.test("assembleGrowthMemo: steady funnel + flat program is not notable", () => {
  const memo = assembleGrowthMemo({
    currentFunnel: funnelDoc([1000, 400, 380, 40]),
    priorFunnel: funnelDoc([1000, 400, 380, 40]),
    referralsCurrent: 100,
    referralsPrior: 100,
    priorSlate: null,
  });
  assertEquals(memo.notable, false);
  assertEquals(memo.regressions, []);
});
