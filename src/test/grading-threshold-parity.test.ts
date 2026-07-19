// US-2107: /grading/methodology now publishes the human-review confidence
// threshold as a spec number (0.75) instead of the vague "our threshold".
//
// Publishing a number creates an obligation the prose did not: it must keep
// matching the engine. The threshold lives in THREE places that can drift —
// the frontend constant we render, the edge's env fallback, and (at runtime)
// the DB settings registry. This guards the two that live in source control.
//
// A published spec that has silently stopped matching the code is worse than
// no published spec: it is a precise, checkable, wrong claim on a page whose
// entire purpose is to be citable.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GRADING_REVIEW_CONFIDENCE_THRESHOLD } from "@/lib/constants";

const AI_CONFIG = join(
  process.cwd(),
  "services/edge-functions/src/lib/ai-config.ts",
);

describe("US-2107: published review threshold matches the engine", () => {
  it("the frontend constant equals the edge's env fallback", () => {
    const src = readFileSync(AI_CONFIG, "utf8");

    // reviewConfidenceEnvFallback() ends with:
    //   return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.75;
    const fn = src.match(
      /function reviewConfidenceEnvFallback\(\)[\s\S]*?\n}/,
    )?.[0];
    expect(fn, "reviewConfidenceEnvFallback() not found — did it get renamed?").toBeTruthy();

    const fallback = fn!.match(/:\s*(0?\.\d+)\s*;/)?.[1];
    expect(fallback, "could not read the fallback literal").toBeTruthy();

    expect(
      Number(fallback),
      "the edge's default review threshold changed but /grading/methodology " +
        "still publishes the old number — update GRADING_REVIEW_CONFIDENCE_THRESHOLD " +
        "and the page copy in the same commit",
    ).toBe(GRADING_REVIEW_CONFIDENCE_THRESHOLD);
  });

  it("the methodology page renders the constant, not a hardcoded literal", () => {
    const page = readFileSync(
      join(process.cwd(), "src/pages/marketing/grading-methodology.tsx"),
      "utf8",
    );
    expect(
      page,
      "the threshold must be rendered from the guarded constant so this test " +
        "actually governs what the page says",
    ).toMatch(/GRADING_REVIEW_CONFIDENCE_THRESHOLD/);
    // The old vague phrasing is the thing this story removed.
    expect(page).not.toMatch(/below\s+our threshold/);
  });

  it("the threshold is a plausible confidence value", () => {
    expect(GRADING_REVIEW_CONFIDENCE_THRESHOLD).toBeGreaterThan(0);
    expect(GRADING_REVIEW_CONFIDENCE_THRESHOLD).toBeLessThanOrEqual(1);
  });
});
