import { describe, expect, it } from "vitest";
import { cleanlinessVisible, sellerStatementLabels } from "@/lib/cleanliness";

// US-3329: the web copy of the Cleanliness rules. The same cases pin the edge
// helper (services/edge-functions/src/tests/cleanliness-statements_test.ts)
// and were run against the SQL in migration 00787.
const CASES: Array<[string, unknown, boolean]> = [
  ["every photo unassessable", [{ unassessable_factors: ["odor_cleanliness"] }, { unassessable_factors: ["odor_cleanliness", "functional_elements"] }], false],
  ["one photo could judge it", [{ unassessable_factors: ["odor_cleanliness"] }, { unassessable_factors: [] }], true],
  ["field missing", [{ image_type: "front" }], true],
  ["no analyses", [], true],
  ["not an array", null, true],
];

describe("cleanliness visibility (US-3329)", () => {
  for (const [name, pia, expected] of CASES) {
    it(name, () => expect(cleanlinessVisible(pia)).toBe(expected));
  }
});

describe("seller statement labels (US-3329)", () => {
  it("labels known statements in canonical order and drops the rest", () => {
    expect(sellerStatementLabels(["pet_free", "smoke_free", "other"])).toEqual([
      "Smoke-free home",
      "Pet-free home",
    ]);
    expect(sellerStatementLabels(undefined)).toEqual([]);
  });
});
