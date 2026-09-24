import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildSnapBridge,
  inputsChangedSince,
  sourceHadCompQuery,
  type SnapResultSource,
} from "@/lib/snap-bridge";
import type { SnapResult } from "@/hooks/use-snap";
import type { SnapHistoryEntry } from "@/lib/snap-history";

const RESULT: SnapResult = {
  grade: { overall_score: 7.4, grade_tier: "very_good", confidence: 0.82, factor_scores: {} },
  value: null,
  garment: { type: "jacket", category: "outerwear" },
  estimate: true,
  disclaimer: "d",
};

function entry(over: Partial<SnapHistoryEntry> = {}): SnapHistoryEntry {
  return {
    id: "e1",
    at: "2026-09-20T10:00:00.000Z",
    brand: "Patagonia",
    keyword: "Nano Puff",
    grade: 7.4,
    gradeTier: "very_good",
    valueCents: null,
    result: RESULT,
    ...over,
  };
}

describe("buildSnapBridge (SNAP-04)", () => {
  it("a fresh snap carries the photo and the inputs that were submitted", () => {
    const src: SnapResultSource = { kind: "live", dataUri: "data:image/jpeg;base64,AAA", brand: " Arc'teryx ", keyword: "" };
    expect(buildSnapBridge(RESULT, src)).toEqual({
      imageDataUri: "data:image/jpeg;base64,AAA",
      brand: "Arc'teryx",
      title: undefined,
      garmentType: "jacket",
      garmentCategory: "outerwear",
    });
  });

  it("a revisit with a different photo loaded never stages that photo", () => {
    const src: SnapResultSource = { kind: "revisit", entry: entry() };
    const bridge = buildSnapBridge(RESULT, src);
    expect(bridge.imageDataUri).toBeNull();
    expect(bridge.brand).toBe("Patagonia");
    expect(bridge.title).toBe("Nano Puff");
  });

  it("a revisit after a reload sends the entry's brand and no photo", () => {
    const src: SnapResultSource = { kind: "revisit", entry: entry({ brand: null, keyword: "flannel" }) };
    expect(buildSnapBridge(RESULT, src)).toMatchObject({ imageDataUri: null, brand: undefined, title: "flannel" });
  });

  it("the caption reads the submitted inputs, not what is typed now", () => {
    expect(sourceHadCompQuery({ kind: "live", dataUri: null, brand: "", keyword: "" })).toBe(false);
    expect(sourceHadCompQuery({ kind: "revisit", entry: entry({ brand: null, keyword: null }) })).toBe(false);
    expect(sourceHadCompQuery({ kind: "revisit", entry: entry() })).toBe(true);
  });

  it("notices when the brand or item changed after pricing", () => {
    const sub = { dataUri: null, brand: "Nike", keyword: "" };
    expect(inputsChangedSince(sub, "Nike ", "")).toBe(false);
    expect(inputsChangedSince(sub, "Adidas", "")).toBe(true);
    expect(inputsChangedSince(sub, "Nike", "dunk")).toBe(true);
    expect(inputsChangedSince(null, "x", "y")).toBe(false);
  });

  it("the page builds the bridge from one source", () => {
    const src = readFileSync(resolve(process.cwd(), "src/pages/snap.tsx"), "utf8");
    expect(src).toContain("buildSnapBridge(result, source)");
    expect(src).toContain("state={{ snap: bridge }");
    expect(src).not.toMatch(/snap: \{\s*imageDataUri: dataUri/);
  });
});
