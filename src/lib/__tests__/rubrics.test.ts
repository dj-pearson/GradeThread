// US-1997 AC4: the client rubric definitions must stay in sync with the server
// (services/edge-functions/src/lib/rubric.ts). Both suites assert against the
// shared fixture; the edge mirror is services/edge-functions/src/tests/
// rubric-parity_test.ts. See the fixture's _readme.
import { describe, expect, it } from "vitest";
import { RUBRICS, rubricForKey } from "../rubrics";
import fixture from "../../test/fixtures/rubric-factors.json";

const expected = fixture.rubrics as Record<
  string,
  { label: string; factors: { key: string; label: string; weight: number }[] }
>;

describe("rubrics parity with the shared fixture", () => {
  it("defines exactly the fixture's rubric keys (no drift in either direction)", () => {
    expect(Object.keys(RUBRICS).sort()).toEqual(Object.keys(expected).sort());
  });

  for (const [key, want] of Object.entries(expected)) {
    it(`${key}: label + factors (key/label/weight, in order) match the fixture`, () => {
      const rubric = RUBRICS[key];
      expect(rubric, `RUBRICS is missing "${key}"`).toBeDefined();
      expect(rubric!.key).toBe(key);
      expect(rubric!.label).toBe(want.label);
      expect(
        rubric!.factors.map((f) => ({ key: f.key, label: f.label, weight: f.weight })),
      ).toEqual(want.factors);
    });
  }
});

describe("rubric invariants", () => {
  for (const [key, want] of Object.entries(expected)) {
    it(`${key}: weights sum to 1.0`, () => {
      const sum = want.factors.reduce((a, f) => a + f.weight, 0);
      expect(sum).toBeCloseTo(1.0, 10);
    });
  }

  it("rubricForKey falls back to clothing for null/unknown keys", () => {
    expect(rubricForKey(null).key).toBe("clothing");
    expect(rubricForKey(undefined).key).toBe("clothing");
    expect(rubricForKey("not_a_category").key).toBe("clothing");
    expect(rubricForKey("sports_cards").key).toBe("sports_cards");
  });
});
