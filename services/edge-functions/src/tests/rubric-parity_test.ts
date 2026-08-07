// US-1997 AC4: the server rubric definitions (../lib/rubric.ts) must stay in
// sync with the client (src/lib/rubrics.ts). Both are declared to match on
// factor keys + weights + labels and NOTHING pinned them — a divergence would
// render a certificate against weights the grade was never computed on.
//
// Same remedy as US-1995 title-sync: both suites load the shared fixture and
// assert their RUBRICS match it. The web mirror is src/lib/__tests__/rubrics.test.ts.
// The fixture constrains only key/label/weight; the server's extra fields
// (guidance, promptGuidance, defectRouting) are intentionally not mirrored.
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  computeRubricWeightedOverall,
  NON_CLOTHING_RUBRIC_KEYS,
  RUBRIC_WEIGHT_SUM_TOLERANCE,
  RUBRICS,
  rubricForKey,
  rubricWeightSum,
} from "../lib/rubric.ts";
import {
  computeWeightedOverall,
  type FactorScores as ColumnFactorScores,
} from "../lib/human-review.ts";

interface FixtureFactor {
  key: string;
  label: string;
  weight: number;
}
const FIXTURE = JSON.parse(
  await Deno.readTextFile(
    new URL("../../../../src/test/fixtures/rubric-factors.json", import.meta.url),
  ),
) as {
  rubrics: Record<string, { label: string; factors: FixtureFactor[] }>;
  weighted_cases: {
    rubric: string;
    scores: Record<string, number>;
    expected_overall: number;
  }[];
  refusal_cases: { why: string; rubric: string; scores: Record<string, unknown> }[];
};

const WEIGHTED_FIXTURE = JSON.parse(
  await Deno.readTextFile(
    new URL("../../../../src/test/fixtures/weighted-grade-cases.json", import.meta.url),
  ),
) as { cases: { factors: ColumnFactorScores; expected_overall: number }[] };

Deno.test("shared fixture: rubric keys match exactly (no drift either direction)", () => {
  assert(Object.keys(FIXTURE.rubrics).length > 0, "fixture is empty — wrong path?");
  assertEquals(Object.keys(RUBRICS).sort(), Object.keys(FIXTURE.rubrics).sort());
});

for (const [key, want] of Object.entries(FIXTURE.rubrics)) {
  Deno.test(`shared fixture: ${key} label + factors match the server rubric`, () => {
    const rubric = RUBRICS[key];
    assert(rubric, `RUBRICS is missing "${key}"`);
    assertEquals(rubric.key, key);
    assertEquals(rubric.label, want.label);
    // Compare only the shared fields; the server carries extra per-factor guidance.
    assertEquals(
      rubric.factors.map((f) => ({ key: f.key, label: f.label, weight: f.weight })),
      want.factors,
    );
  });
}

Deno.test("shared fixture: every rubric's weights sum to 1.0", () => {
  for (const [key, want] of Object.entries(FIXTURE.rubrics)) {
    const sum = want.factors.reduce((a, f) => a + f.weight, 0);
    assert(Math.abs(sum - 1.0) < 1e-9, `${key} weights sum to ${sum}, expected 1.0`);
  }
});

Deno.test("rubricForKey falls back to clothing for null/unknown keys", () => {
  assertEquals(rubricForKey(null).key, "clothing");
  assertEquals(rubricForKey(undefined).key, "clothing");
  assertEquals(rubricForKey("not_a_category").key, "clothing");
  assertEquals(rubricForKey("sports_cards").key, "sports_cards");
});

Deno.test("NON_CLOTHING_RUBRIC_KEYS are all defined rubrics and exclude clothing", () => {
  for (const key of NON_CLOTHING_RUBRIC_KEYS) {
    assert(RUBRICS[key], `NON_CLOTHING_RUBRIC_KEYS names "${key}" but RUBRICS has no such rubric`);
    // String() so this stays a runtime guard even though the key's type already
    // excludes "clothing" (a bare `key !== "clothing"` is TS2367 dead code).
    assert(String(key) !== "clothing", "clothing must not be in NON_CLOTHING_RUBRIC_KEYS");
  }
});

Deno.test("rubricWeightSum reports 1.0 for every shipped rubric", () => {
  for (const [key, rubric] of Object.entries(RUBRICS)) {
    const sum = rubricWeightSum(rubric);
    assert(
      Math.abs(sum - 1) < RUBRIC_WEIGHT_SUM_TOLERANCE,
      `${key} weights sum to ${sum}, expected 1.0`,
    );
  }
});

// ---------------------------------------------------------------------------
// US-1997 activation step 2 — the generalized weighted overall.
// ---------------------------------------------------------------------------

/** JSON has no NaN literal; the fixture carries the sentinel string instead. */
function decodeSentinels(scores: Record<string, unknown>): Record<string, number> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(scores)) out[k] = v === "__NaN__" ? NaN : v;
  return out as Record<string, number>;
}

Deno.test("shared fixture actually carries weighted cases (an empty table proves nothing)", () => {
  assert(FIXTURE.weighted_cases.length > 0, "weighted_cases is empty — wrong path?");
  assert(FIXTURE.refusal_cases.length > 0, "refusal_cases is empty — wrong path?");
});

for (const [i, c] of FIXTURE.weighted_cases.entries()) {
  Deno.test(`computeRubricWeightedOverall case ${i} (${c.rubric}) → ${c.expected_overall}`, () => {
    const rubric = RUBRICS[c.rubric];
    assert(rubric, `fixture names unknown rubric "${c.rubric}"`);
    assertEquals(computeRubricWeightedOverall(rubric, c.scores), c.expected_overall);
  });
}

for (const [i, c] of FIXTURE.refusal_cases.entries()) {
  Deno.test(`computeRubricWeightedOverall refusal ${i}: ${c.why}`, () => {
    const rubric = RUBRICS[c.rubric];
    assert(rubric, `fixture names unknown rubric "${c.rubric}"`);
    assertThrows(
      () => computeRubricWeightedOverall(rubric, decodeSentinels(c.scores)),
      Error,
      "Refusing to compute a weighted overall",
    );
  });
}

Deno.test("the NaN sentinel is translated, not asserted on as a string", () => {
  // Without this, a runner that forgot to decode would still see a throw (a
  // string factor also refuses) and pass for the wrong reason.
  const withSentinel = FIXTURE.refusal_cases.find((c) =>
    Object.values(c.scores).includes("__NaN__")
  );
  assert(withSentinel, "fixture lost its NaN sentinel case");
  const decoded = decodeSentinels(withSentinel.scores);
  assert(
    Object.values(decoded).some((v) => Number.isNaN(v)),
    "sentinel was not converted to a real NaN",
  );
});

// The strongest available guard on the generalization, inventing no data: every
// case that ALREADY pins human-review.computeWeightedOverall against the web
// mirror (US-2034/US-2386) is replayed through the generalized function under
// the clothing rubric. If the generalization drifts from the formula it
// generalizes, these fail on both sides at once.
for (const [i, c] of WEIGHTED_FIXTURE.cases.entries()) {
  Deno.test(`clothing rubric matches computeWeightedOverall — case ${i}`, () => {
    // Column names (fabric_condition_score) → rubric factor keys
    // (fabric_condition). Derived, not a second hardcoded map.
    const byFactorKey = Object.fromEntries(
      Object.entries(c.factors).map(([k, v]) => [k.replace(/_score$/, ""), v]),
    );
    const viaRubric = computeRubricWeightedOverall(RUBRICS.clothing, byFactorKey);
    assertEquals(viaRubric, computeWeightedOverall(c.factors));
    assertEquals(viaRubric, c.expected_overall);
  });
}
