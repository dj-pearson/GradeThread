// SRC-14: a listing whose seller-stated condition is worse than its shadow
// grade is flagged "better than listed", but only when the grade is confident.
import { assertEquals } from "@std/assert";
import {
  conditionGap,
  isConditionArbitrage,
  nominalGradeForCondition,
} from "../lib/scout-scoring.ts";

Deno.test("SRC-14: seller says Good, shadow 8.5 at 0.8 confidence is arbitrage", () => {
  assertEquals(isConditionArbitrage("Good", 8.5, 0.8), true);
  assertEquals(conditionGap("Good", 8.5), 1.5);
});

Deno.test("SRC-14: seller says Like new, shadow 8.5 is not", () => {
  assertEquals(isConditionArbitrage("Like new", 8.5, 0.8), false);
  assertEquals(conditionGap("Like new", 8.5), 0);
});

Deno.test("SRC-14: a low-confidence grade never contradicts the seller", () => {
  assertEquals(isConditionArbitrage("Good", 9.5, 0.7), false);
});

Deno.test("SRC-14: an unknown or missing condition never makes a gap", () => {
  assertEquals(conditionGap("Seller refurbished", 9.5), 0);
  assertEquals(conditionGap(null, 9.5), 0);
  assertEquals(conditionGap("Good", null), 0);
});

Deno.test("SRC-14: the specific conditions win over the general words inside them", () => {
  assertEquals(nominalGradeForCondition("New with defects"), 8);
  assertEquals(nominalGradeForCondition("New without tags"), 9.5);
  assertEquals(nominalGradeForCondition("New with tags"), 10);
  assertEquals(nominalGradeForCondition("Pre-owned - Fair"), 5);
  assertEquals(nominalGradeForCondition("Pre-owned"), 7);
  assertEquals(nominalGradeForCondition("For parts or not working"), 3);
});
