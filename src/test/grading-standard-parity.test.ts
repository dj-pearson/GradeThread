// US-2107: the public grading standard is now a SPEC (millimetre tolerances,
// factor routing, severity multipliers), not a rubric of adjectives.
//
// A spec that has silently drifted from the engine is worse than adjectives: it
// is a precise, checkable, WRONG claim on the page whose whole purpose is to be
// cited and lifted verbatim into LLM answers. The frontend cannot import from
// services/edge-functions, so the published values are mirrored — and this test
// is what makes the mirror honest.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PUBLISHED_SIZE_BUCKETS,
  PUBLISHED_FLAW_ROUTING,
  PUBLISHED_SEVERITY_SCALE,
  PUBLISHED_FACTOR_WEIGHTS,
} from "@/lib/grading-standard";

const ENGINE = readFileSync(
  join(process.cwd(), "services/edge-functions/src/lib/defect-weighting.ts"),
  "utf8",
);

describe("US-2107: published standard matches the grading engine", () => {
  it("publishes every defect type the engine can emit", () => {
    // If the engine gains a defect type and the page does not, the published
    // standard is quietly incomplete — a flaw with no stated factor.
    const block = ENGINE.match(/const FACTOR_ROUTING[\s\S]*?\n};/)?.[0];
    expect(block, "FACTOR_ROUTING not found — renamed?").toBeTruthy();

    const engineTypes = [...block!.matchAll(/^\s{2}(\w+):\s*\{/gm)].map((m) => m[1]);
    // `other` is a catch-all bucket with no meaningful public name; everything
    // else must appear.
    const expected = engineTypes.filter((t) => t !== "other");

    expect(expected.length).toBeGreaterThan(10);
    expect(
      PUBLISHED_FLAW_ROUTING.length,
      `engine defines ${expected.length} named defect types but the published ` +
        `standard lists ${PUBLISHED_FLAW_ROUTING.length}`,
    ).toBe(expected.length);
  });

  it("routing shares sum to 1.0 for every published flaw", () => {
    for (const { flaw, routes } of PUBLISHED_FLAW_ROUTING) {
      const sum = routes.reduce((a, [, share]) => a + share, 0);
      expect(sum, `${flaw} routing shares must sum to 1.0`).toBeCloseTo(1.0, 5);
    }
  });

  it("published routing shares match the engine's FACTOR_ROUTING", () => {
    const block = ENGINE.match(/const FACTOR_ROUTING[\s\S]*?\n};/)?.[0] ?? "";
    // Every share we publish must literally appear against its factor in the
    // engine table, e.g. `structural_integrity: 0.6`.
    const LABEL_TO_KEY: Record<string, string> = {
      "Fabric condition": "fabric_condition",
      "Structural integrity": "structural_integrity",
      "Cosmetic appearance": "cosmetic_appearance",
      "Functional elements": "functional_elements",
      "Odor & cleanliness": "odor_cleanliness",
    };
    for (const { flaw, routes } of PUBLISHED_FLAW_ROUTING) {
      for (const [label, share] of routes) {
        const key = LABEL_TO_KEY[label];
        expect(key, `unmapped factor label "${label}"`).toBeTruthy();
        expect(
          block,
          `${flaw} → ${label} is published as ${share} but the engine does not ` +
            `contain "${key}: ${share}"`,
        ).toContain(`${key}: ${share}`);
      }
    }
  });

  it("severity multipliers match SEVERITY_MULT", () => {
    const block = ENGINE.match(/const SEVERITY_MULT[\s\S]*?\n};/)?.[0] ?? "";
    expect(block).toContain("minor: 0.5");
    expect(block).toContain("moderate: 1.0");
    expect(block).toContain("major: 1.8");
    expect(PUBLISHED_SEVERITY_SCALE.map((s) => s.severity)).toEqual([
      "Minor",
      "Moderate",
      "Major",
    ]);
  });

  it("publishes every size bucket, including the conservative unknown", () => {
    const block = ENGINE.match(/const SIZE_BUCKETS[\s\S]*?\] as const;/)?.[0] ?? "";
    for (const { bucket } of PUBLISHED_SIZE_BUCKETS) {
      expect(block, `size bucket "${bucket}" is published but not in the engine`)
        .toContain(`"${bucket}"`);
    }
    // The unknown-is-low-impact rule is a published guarantee, so it must stay
    // true in the engine: SIZE_MULT.unknown must not exceed small.
    const mult = ENGINE.match(/const SIZE_MULT[\s\S]*?\n};/)?.[0] ?? "";
    const small = Number(mult.match(/small:\s*([\d.]+)/)?.[1]);
    const unknown = Number(mult.match(/unknown:\s*([\d.]+)/)?.[1]);
    expect(Number.isFinite(small) && Number.isFinite(unknown)).toBe(true);
    expect(
      unknown,
      "we publish that missing size data never inflates a penalty",
    ).toBeLessThanOrEqual(small);
  });

  it("factor weights still sum to 1.0", () => {
    const sum = PUBLISHED_FACTOR_WEIGHTS.reduce((a, f) => a + f.weight, 0);
    expect(sum).toBeCloseTo(1.0, 5);
  });

  it("does NOT publish the exact per-defect penalty weights", () => {
    // Deliberate: publishing BASE_WEIGHT makes the grade gameable. If this ever
    // becomes a product decision to reverse, do it knowingly — not by pasting
    // one more column into the table.
    // Strip comments first: this file EXPLAINS the omission in prose, and an
    // earlier version of this assertion matched its own explanation rather
    // than any code.
    const src = readFileSync(
      join(process.cwd(), "src/lib/grading-standard.ts"),
      "utf8",
    )
      .replace(/\r\n?/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    expect(src).not.toMatch(/BASE_WEIGHT/);
    // Also strip string literals — the published mm ranges ("3–13 mm") contain
    // digits that are prose, not weights.
    const codeOnly = src.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
    // The engine's penalties are all >= 0.4 score points; every legitimately
    // published number here is a weight or share, so <= 1.0. Anything above 1.0
    // means a raw penalty leaked in.
    const numbers = [...codeOnly.matchAll(/\b\d+(?:\.\d+)?\b/g)].map((m) =>
      Number(m[0]),
    );
    expect(numbers.length).toBeGreaterThan(10);
    expect(
      numbers.filter((n) => n > 1),
      "a value above 1.0 in the published standard looks like a raw penalty weight",
    ).toEqual([]);
  });
});
