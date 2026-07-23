// US-1997 AC4: the server rubric definitions (../lib/rubric.ts) must stay in
// sync with the client (src/lib/rubrics.ts). Both are declared to match on
// factor keys + weights + labels and NOTHING pinned them — a divergence would
// render a certificate against weights the grade was never computed on.
//
// Same remedy as US-1995 title-sync: both suites load the shared fixture and
// assert their RUBRICS match it. The web mirror is src/lib/__tests__/rubrics.test.ts.
// The fixture constrains only key/label/weight; the server's extra fields
// (guidance, promptGuidance, defectRouting) are intentionally not mirrored.
import { assert, assertEquals } from "@std/assert";
import { NON_CLOTHING_RUBRIC_KEYS, RUBRICS, rubricForKey } from "../lib/rubric.ts";

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
};

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
    assert(key !== "clothing", "clothing must not be in NON_CLOTHING_RUBRIC_KEYS");
  }
});
