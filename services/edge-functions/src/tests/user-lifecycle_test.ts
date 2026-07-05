// US-1600: User Lifecycle pure logic — activation-stall diagnosis, churn
// narrative, winback sizing, memo assembly, and a PII-absence assertion.
import { assert, assertEquals } from "@std/assert";
import {
  assembleLifecycleMemo,
  type CohortWeek,
  diagnoseActivationStall,
  type FunnelStep,
  narrateChurnRisk,
  sizeWinback,
  type TrialCohort,
} from "../lib/user-lifecycle.ts";

const funnel: FunnelStep[] = [
  { key: "signed_up", label: "Signed up", count: 1000 },
  { key: "submitted", label: "First submission", count: 300 }, // 30% → the stall
  { key: "graded", label: "First grade", count: 285 }, // 95% of submitted → healthy
];

// ── Activation stall ─────────────────────────────────────────────────────────

Deno.test("diagnoseActivationStall: the worst sub-threshold transition is the stall", () => {
  const stall = diagnoseActivationStall(funnel);
  assert(stall !== null);
  assertEquals(stall?.step_from, "signed_up");
  assertEquals(stall?.step_to, "submitted");
  assertEquals(stall?.retained_rate, 0.3);
  assertEquals(stall?.drop_count, 700);
});

Deno.test("diagnoseActivationStall: a healthy funnel → null", () => {
  const healthy: FunnelStep[] = [
    { key: "a", label: "A", count: 100 },
    { key: "b", label: "B", count: 90 },
    { key: "c", label: "C", count: 80 },
  ];
  assertEquals(diagnoseActivationStall(healthy), null);
  assertEquals(diagnoseActivationStall([{ key: "a", label: "A", count: 5 }]), null); // too small
});

// ── Churn narrative ──────────────────────────────────────────────────────────

Deno.test("narrateChurnRisk: conversion down >10% → worsening; up → improving; flat → steady", () => {
  const prior: CohortWeek = { week: "w0", enrolled: 100, converted: 30, churned: 20 };
  assertEquals(narrateChurnRisk({ week: "w1", enrolled: 100, converted: 20, churned: 30 }, prior).risk, "worsening");
  assertEquals(narrateChurnRisk({ week: "w1", enrolled: 100, converted: 40, churned: 10 }, prior).risk, "improving");
  assertEquals(narrateChurnRisk({ week: "w1", enrolled: 100, converted: 31, churned: 20 }, prior).risk, "steady");
});

Deno.test("narrateChurnRisk: no prior enrollment → unknown, rates null-safe", () => {
  const n = narrateChurnRisk({ week: "w1", enrolled: 0, converted: 0, churned: 0 }, { week: "w0", enrolled: 0, converted: 0, churned: 0 });
  assertEquals(n.risk, "unknown");
  assertEquals(n.conversion_rate, null);
});

// ── Winback sizing ───────────────────────────────────────────────────────────

Deno.test("sizeWinback: sums the expired pool + the still-savable trials", () => {
  const cohorts: TrialCohort[] = [
    { bucket: "expiring_3d", count: 5 },
    { bucket: "expiring_7d", count: 8 },
    { bucket: "expired_unconverted", count: 42 },
  ];
  const w = sizeWinback(cohorts);
  assertEquals(w.reachable, 42);
  assertEquals(w.expiring_soon, 13);
});

// ── Memo + PII absence ───────────────────────────────────────────────────────

Deno.test("assembleLifecycleMemo: a clean lifecycle week is all_clear", () => {
  const healthy: FunnelStep[] = [{ key: "a", label: "A", count: 100 }, { key: "b", label: "B", count: 95 }];
  const memo = assembleLifecycleMemo(
    healthy,
    { week: "w1", enrolled: 100, converted: 35, churned: 5 },
    { week: "w0", enrolled: 100, converted: 33, churned: 6 },
    [{ bucket: "expiring_7d", count: 3 }],
  );
  assertEquals(memo.all_clear, true);
  assert(memo.summary.includes("no activation stall"));
});

Deno.test("assembleLifecycleMemo: the memo is cohort-only — no per-user fields", () => {
  const memo = assembleLifecycleMemo(
    funnel,
    { week: "w1", enrolled: 100, converted: 20, churned: 30 },
    { week: "w0", enrolled: 100, converted: 30, churned: 20 },
    [{ bucket: "expired_unconverted", count: 42 }],
  );
  assertEquals(memo.all_clear, false);
  const json = JSON.stringify(memo);
  // No user identity leaks into what the model sees.
  assert(!/user_id|email|"id"|@/.test(json));
});
