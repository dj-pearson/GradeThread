import { describe, expect, it } from "vitest";
import { buildAnnotatedGroups } from "../annotated-defect-photo";
import type { PublicImageDefectAnnotations } from "@/types/database";

describe("buildAnnotatedGroups", () => {
  it("returns [] for null/empty/non-array input", () => {
    expect(buildAnnotatedGroups(null)).toEqual([]);
    expect(buildAnnotatedGroups(undefined)).toEqual([]);
    expect(buildAnnotatedGroups([])).toEqual([]);
  });

  it("numbers localized defects sequentially across images, worst-first", () => {
    const groups: PublicImageDefectAnnotations[] = [
      {
        image_type: "front",
        annotations: [
          { issue: "pilling", severity: "minor", location: "cuff", bbox: [0.1, 0.1, 0.2, 0.2] },
          { issue: "stain", severity: "major", location: "chest", bbox: [0.5, 0.5, 0.1, 0.1] },
        ],
      },
      {
        image_type: "back",
        annotations: [
          { issue: "snag", severity: "moderate", location: "hem", bbox: [0.3, 0.3, 0.1, 0.1] },
        ],
      },
    ];
    const out = buildAnnotatedGroups(groups);
    expect(out).toHaveLength(2);
    // front: major (stain) before minor (pilling), numbered 1 then 2
    expect(out[0]!.image_type).toBe("front");
    expect(out[0]!.annotations.map((a) => [a.n, a.issue])).toEqual([
      [1, "stain"],
      [2, "pilling"],
    ]);
    // back continues the running counter
    expect(out[1]!.annotations[0]!.n).toBe(3);
  });

  it("drops defects without a valid bbox (text-list fallback) and empty groups", () => {
    const groups: PublicImageDefectAnnotations[] = [
      {
        image_type: "front",
        annotations: [
          { issue: "fade", severity: "minor", location: "", bbox: null },
          { issue: "tear", severity: "major", location: "sleeve", bbox: [0.2, 0.2, 0.3, 0.3] },
        ],
      },
      {
        // no drawable boxes → group omitted entirely
        image_type: "label",
        annotations: [
          { issue: "wear", severity: "minor", location: "", bbox: [1, 2, 3] as unknown as [number, number, number, number] },
        ],
      },
    ];
    const out = buildAnnotatedGroups(groups);
    expect(out).toHaveLength(1);
    expect(out[0]!.image_type).toBe("front");
    expect(out[0]!.annotations).toHaveLength(1);
    expect(out[0]!.annotations[0]).toMatchObject({ n: 1, issue: "tear" });
  });
});
