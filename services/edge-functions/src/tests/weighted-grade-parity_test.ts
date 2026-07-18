// US-2034 — EDGE half of the shared weighted-overall guard.
//
// The web asserts the same fixture (src/lib/__tests__/weighted-grade.test.ts).
// This formula necessarily exists twice — the SPA and the Deno edge are separate
// projects that cannot import across each other — so the mirror is legitimate.
// What is NOT legitimate is pinning it with a comment: "keep in lockstep with
// human-review.computeWeightedOverall" was written on the AI-grading copy, and
// the drift shipped anyway. Twice: US-1557 (admin/grading.tsx) and US-2034
// (admin/disputes.tsx, which rounded to 0.5 while the server stored 0.1).
//
// One table, both suites. That is the mechanism.

import { assertAlmostEquals, assertEquals } from "@std/assert";
import { computeWeightedOverall } from "../lib/human-review.ts";

const fixture = JSON.parse(
  await Deno.readTextFile(
    new URL("../../../../src/test/fixtures/weighted-grade-cases.json", import.meta.url),
  ),
) as {
  cases: Array<{
    factors: Record<string, number>;
    expected_overall: number;
  }>;
};

Deno.test("edge weighted overall matches the cross-project fixture", () => {
  assertEquals(
    fixture.cases.length > 10,
    true,
    "fixture looks truncated — it should carry a broad spread of vectors",
  );
  for (const c of fixture.cases) {
    assertEquals(
      computeWeightedOverall(
        c.factors as unknown as Parameters<typeof computeWeightedOverall>[0],
      ),
      c.expected_overall,
      `factors ${JSON.stringify(c.factors)}`,
    );
  }
});

Deno.test("edge rounds to 0.1, NOT 0.5 — the drift that shipped twice", () => {
  const factors = {
    fabric_condition_score: 8.5,
    structural_integrity_score: 8.5,
    cosmetic_appearance_score: 8.0,
    functional_elements_score: 8.0,
    odor_cleanliness_score: 8.5,
  };
  const got = computeWeightedOverall(
    factors as unknown as Parameters<typeof computeWeightedOverall>[0],
  );
  assertEquals(got, 8.3);
  assertEquals(got === 8.5, false, "0.5-rounding is the bug this pins");
});

Deno.test("edge weights sum to exactly 1.0", () => {
  // An all-equal input returning that same value proves the weights are a true
  // average, i.e. that they sum to 1 — without needing the private table.
  for (const v of [1, 5.5, 7, 10]) {
    const factors = {
      fabric_condition_score: v,
      structural_integrity_score: v,
      cosmetic_appearance_score: v,
      functional_elements_score: v,
      odor_cleanliness_score: v,
    };
    assertAlmostEquals(
      computeWeightedOverall(
        factors as unknown as Parameters<typeof computeWeightedOverall>[0],
      ),
      v,
      1e-9,
    );
  }
});
