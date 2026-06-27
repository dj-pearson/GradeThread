import { describe, expect, it } from "vitest";
import {
  REPAIR_RESOURCES,
  computeRepairImpact,
  summarizeRepairTriage,
} from "../repair-triage";
import type { DefectFound } from "@/types/database";

function defect(overrides: Partial<DefectFound> = {}): DefectFound {
  return {
    defect: "test defect",
    severity: "moderate",
    location: "front",
    ...overrides,
  };
}

describe("computeRepairImpact", () => {
  it("a reversible stain yields a positive projected grade + value lift", () => {
    const impact = computeRepairImpact(
      defect({
        defect: "Coffee stain on chest",
        defect_type: "stain",
        severity: "moderate",
        size_bucket: "medium",
        repairability: "reversible",
      }),
    );
    expect(impact).not.toBeNull();
    expect(impact!.repairability).toBe("reversible");
    expect(impact!.gradeLift).toBeGreaterThan(0);
    expect(impact!.valueLiftPct).toBeGreaterThan(0);
    // Reversible flaws recover fully.
    expect(impact!.recoveryFraction).toBe(1);
    expect(impact!.action).toMatch(/clean/i);
    expect(impact!.resource).toEqual(REPAIR_RESOURCES.cleaning);
  });

  it("a permanent tear yields no repair impact (no promise)", () => {
    const impact = computeRepairImpact(
      defect({
        defect: "Large tear across back",
        defect_type: "rip_tear",
        severity: "major",
        size_bucket: "large",
        repairability: "permanent",
      }),
    );
    expect(impact).toBeNull();
  });

  it("treats absent repairability data as permanent (no promise)", () => {
    const impact = computeRepairImpact(
      defect({ defect_type: "stain", severity: "moderate" }),
    );
    expect(impact).toBeNull();
  });

  it("a repairable seam failure recovers most but not all of the cost", () => {
    const impact = computeRepairImpact(
      defect({
        defect: "Unthreaded shoulder seam",
        defect_type: "seam_failure_unthreading",
        severity: "moderate",
        size_bucket: "medium",
        repairability: "repairable",
      }),
    );
    expect(impact).not.toBeNull();
    expect(impact!.repairability).toBe("repairable");
    expect(impact!.recoveryFraction).toBeLessThan(1);
    expect(impact!.gradeLift).toBeGreaterThan(0);
    expect(impact!.resource).toEqual(REPAIR_RESOURCES.tailor);
  });

  it("a larger defect projects a bigger lift than a smaller one of the same type", () => {
    const small = computeRepairImpact(
      defect({ defect_type: "stain", size_bucket: "small", repairability: "reversible" }),
    );
    const large = computeRepairImpact(
      defect({ defect_type: "stain", size_bucket: "extensive", repairability: "reversible" }),
    );
    expect(large!.gradeLift).toBeGreaterThan(small!.gradeLift);
  });
});

describe("summarizeRepairTriage", () => {
  it("returns null with no defects", () => {
    expect(summarizeRepairTriage([])).toBeNull();
    expect(summarizeRepairTriage(null)).toBeNull();
    expect(summarizeRepairTriage(undefined)).toBeNull();
  });

  it("returns null when every defect is permanent", () => {
    const summary = summarizeRepairTriage([
      defect({ defect_type: "rip_tear", repairability: "permanent" }),
      defect({ defect_type: "hole_puncture", repairability: "permanent" }),
    ]);
    expect(summary).toBeNull();
  });

  it("includes only reversible/repairable defects, worst-first, with totals + deduped resources", () => {
    const summary = summarizeRepairTriage([
      defect({ defect_type: "rip_tear", severity: "major", repairability: "permanent" }),
      defect({
        defect: "Light pilling",
        defect_type: "pilling",
        severity: "minor",
        size_bucket: "small",
        repairability: "reversible",
      }),
      defect({
        defect: "Broken zipper",
        defect_type: "broken_zipper",
        severity: "major",
        size_bucket: "medium",
        repairability: "repairable",
      }),
      defect({
        defect: "Set-in stain",
        defect_type: "stain",
        severity: "moderate",
        size_bucket: "medium",
        repairability: "reversible",
      }),
    ]);
    expect(summary).not.toBeNull();
    // Permanent tear excluded → 3 actionable items.
    expect(summary!.items).toHaveLength(3);
    // Worst-first by grade lift (the major broken zipper leads).
    const lifts = summary!.items.map((i) => i.impact.gradeLift);
    expect(lifts).toEqual([...lifts].sort((a, b) => b - a));
    expect(summary!.items[0]!.defect.defect_type).toBe("broken_zipper");
    expect(summary!.totalGradeLift).toBeGreaterThan(0);
    expect(summary!.totalValueLiftPct).toBeGreaterThan(0);
    // tailor (zipper) + diy (pilling) + cleaning (stain) → 3 distinct resources.
    expect(summary!.resources).toHaveLength(3);
  });
});
