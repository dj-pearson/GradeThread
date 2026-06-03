// US-481: AI grading self-consistency math + gate.
//
// Pure stats — no network/DB. These pin the reproducibility metric and
// demonstrate the CI gate: a fixture whose re-grades disagree by more than one
// grading increment makes `assessSelfConsistency(...).passes` false.
//
//   deno test --allow-env src/tests/grading-reliability_test.ts
import { assert, assertAlmostEquals, assertEquals } from "@std/assert";
import {
  assessSelfConsistency,
  gradeSelfConsistency,
  SELF_CONSISTENCY_TOLERANCE,
  type SelfConsistencyItem,
} from "../lib/grading-reliability.ts";

Deno.test("identical re-grades → zero spread, consistent", () => {
  const r = gradeSelfConsistency([7.5, 7.5, 7.5]);
  assertEquals(r.max_spread, 0);
  assertEquals(r.std_dev, 0);
  assertEquals(r.mean, 7.5);
  assert(r.consistent);
});

Deno.test("a single run is trivially consistent", () => {
  const r = gradeSelfConsistency([6.0]);
  assert(r.consistent);
  assertEquals(r.run_count, 1);
});

Deno.test("within one increment → consistent at the default tolerance", () => {
  const r = gradeSelfConsistency([7.0, 7.5]);
  assertAlmostEquals(r.max_spread, 0.5);
  assertEquals(r.tolerance, SELF_CONSISTENCY_TOLERANCE);
  assert(r.consistent);
});

Deno.test("more than one increment of drift → NOT consistent", () => {
  const r = gradeSelfConsistency([6.0, 7.0]);
  assertAlmostEquals(r.max_spread, 1.0);
  assert(!r.consistent);
});

Deno.test("std_dev is the population standard deviation", () => {
  // values 6 and 8 → mean 7, variance 1, std 1.
  const r = gradeSelfConsistency([6, 8]);
  assertAlmostEquals(r.std_dev, 1);
  assertAlmostEquals(r.mean, 7);
});

Deno.test("aggregate gate PASSES when every garment is reproducible", () => {
  const items: SelfConsistencyItem[] = [
    { item_id: "a", scores: [8.0, 8.0, 8.0] },
    { item_id: "b", scores: [5.5, 6.0] }, // within one increment
    { item_id: "c", scores: [9.0] }, // single run, ignored as unmeasured
  ];
  const report = assessSelfConsistency(items);
  assert(report.passes);
  assertEquals(report.measured_item_count, 2);
  assertEquals(report.consistent_fraction, 1);
  assertEquals(report.worst_spread, 0.5);
});

Deno.test("aggregate gate FAILS on any garment that drifts > one increment", () => {
  const items: SelfConsistencyItem[] = [
    { item_id: "a", scores: [8.0, 8.0] },
    { item_id: "b", scores: [5.0, 7.5] }, // 2.5 spread → fails the gate
  ];
  const report = assessSelfConsistency(items);
  assert(!report.passes);
  assertEquals(report.worst_item_id, "b");
  assertAlmostEquals(report.worst_spread, 2.5);
});

Deno.test("empty study is vacuously consistent", () => {
  const report = assessSelfConsistency([]);
  assert(report.passes);
  assertEquals(report.measured_item_count, 0);
  assertEquals(report.consistent_fraction, 1);
});
