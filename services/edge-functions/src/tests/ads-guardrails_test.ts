// US-1705: guardrails block over-limit applies.
import { assert, assertEquals } from "@std/assert";
import { checkGuardrails, DEFAULT_GUARDRAILS, type Guardrails } from "../lib/ads-guardrails.ts";

const OK_CTX = { todaySpend: 0, appliesThisRun: 0 };
const G: Guardrails = { ...DEFAULT_GUARDRAILS, maxBudgetChangePct: 50, dailySpendCeiling: 500, maxAppliesPerRun: 3 };

Deno.test("a budget change over the % cap is blocked", () => {
  // 100k → 200k = 100% increase, over the 50% cap.
  const r = checkGuardrails("adjust_budget", { amountMicros: "100000000" }, { amountMicros: "200000000" }, G, OK_CTX);
  assertEquals(r.allowed, false);
  assert(r.reason?.includes("%"));
});

Deno.test("a budget change within the % cap is allowed", () => {
  // 100k → 120k = 20% increase, under the 50% cap.
  const r = checkGuardrails("adjust_budget", { amountMicros: "100000000" }, { amountMicros: "120000000" }, G, OK_CTX);
  assertEquals(r.allowed, true);
});

Deno.test("the applies-per-run cap blocks further applies", () => {
  const r = checkGuardrails("pause_campaign", {}, {}, G, { todaySpend: 0, appliesThisRun: 3 });
  assertEquals(r.allowed, false);
  assert(r.reason?.includes("cap"));
});

Deno.test("the daily-spend ceiling freezes changes", () => {
  const r = checkGuardrails("pause_campaign", {}, {}, G, { todaySpend: 600, appliesThisRun: 0 });
  assertEquals(r.allowed, false);
  assert(r.reason?.includes("ceiling"));
});

Deno.test("a non-budget change under the caps is allowed", () => {
  assertEquals(checkGuardrails("pause_keyword", {}, {}, G, OK_CTX).allowed, true);
});

Deno.test("disabled guardrails (0) don't block", () => {
  const off: Guardrails = { maxBudgetChangePct: 1000, dailySpendCeiling: 0, maxAppliesPerRun: 0 };
  assertEquals(checkGuardrails("pause_campaign", {}, {}, off, { todaySpend: 1e9, appliesThisRun: 1e6 }).allowed, true);
});
