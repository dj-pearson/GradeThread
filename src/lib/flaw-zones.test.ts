// US-3336: each numbered flaw lands on one inspection zone of the outline.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildFlawMap,
  HINT_ALIASES,
  zoneForFlaw,
  zoneFromPhoto,
  zonesFromLocation,
} from "@/lib/flaw-zones";
import { silhouetteFor } from "@/lib/coverage-silhouettes";
import type { AnnotatedPhotoGroup } from "@/components/certificate/annotated-defect-photo";

const TOP = silhouetteFor("shirt")!;
const BOTTOM = silhouetteFor("jeans")!;

function flaw(n: number, issue: string, location: string) {
  return { n, issue, severity: "minor" as const, location, bbox: [0.1, 0.1, 0.1, 0.1] as [number, number, number, number] };
}

describe("zonesFromLocation", () => {
  it("names the specific zone before the side it is on", () => {
    expect(zonesFromLocation("back of collar")[0]).toBe("collar_neckline");
    expect(zonesFromLocation("chest pocket")[0]).toBe("pockets");
    expect(zonesFromLocation("left cuff")[0]).toBe("cuffs");
    expect(zonesFromLocation("front hem")[0]).toBe("hem");
  });

  it("matches at word starts only, so vintage is not a tag and chemical is not a hem", () => {
    expect(zonesFromLocation("vintage wear overall")).toEqual([]);
    expect(zonesFromLocation("chemical smell")).toEqual([]);
    expect(zonesFromLocation("Sleeves")).toEqual(["cuffs"]);
    expect(zonesFromLocation("hemline")).toEqual(["hem"]);
  });

  it("reads nothing into an empty location", () => {
    expect(zonesFromLocation("")).toEqual([]);
    expect(zonesFromLocation(null)).toEqual([]);
  });
});

describe("zoneForFlaw", () => {
  it("falls back to the source photo when the words say nothing", () => {
    expect(zoneForFlaw("", "back", TOP.anchors)).toBe("back");
    expect(zoneForFlaw("near the middle", "front", TOP.anchors)).toBe("front");
    expect(zoneForFlaw("", "label_2", TOP.anchors)).toBe("branding");
    expect(zoneFromPhoto("detail_2")).toBeNull();
  });

  it("the words win over the photo", () => {
    expect(zoneForFlaw("collar", "back", TOP.anchors)).toBe("collar_neckline");
  });

  it("a zone the shape cannot draw falls to the next word, then to unmapped", () => {
    // Underarms is not on the bottoms outline; the waistband is.
    expect(zoneForFlaw("underarm", "detail", BOTTOM.anchors)).toBeNull();
    expect(zoneForFlaw("sleeve near waist", "detail", BOTTOM.anchors)).toBe("waistband");
    expect(zoneForFlaw("somewhere", "detail", TOP.anchors)).toBeNull();
  });
});

describe("buildFlawMap", () => {
  const groups: AnnotatedPhotoGroup[] = [
    { image_type: "front", annotations: [flaw(1, "hole", "collar"), flaw(2, "stain", "")] },
    { image_type: "detail", annotations: [flaw(3, "pill", "collar"), flaw(4, "snag", "unclear spot")] },
  ];

  it("keeps the callout numbers and lists what cannot be placed", () => {
    const map = buildFlawMap(groups, TOP);
    expect(map.pinned.map((p) => [p.n, p.zone])).toEqual([
      [1, "collar_neckline"],
      [2, "front"],
      [3, "collar_neckline"],
    ]);
    expect(map.unmapped.map((a) => a.n)).toEqual([4]);
  });

  it("two flaws in one zone do not sit on top of each other, and stay inside the drawing", () => {
    const [a, , b] = buildFlawMap(groups, TOP).pinned;
    expect([a?.cx, a?.cy]).not.toEqual([b?.cx, b?.cy]);
    for (const p of buildFlawMap(groups, TOP).pinned) {
      expect(p.cx).toBeGreaterThanOrEqual(5);
      expect(p.cx).toBeLessThanOrEqual(95);
      expect(p.cy).toBeGreaterThanOrEqual(5);
      expect(p.cy).toBeLessThanOrEqual(125);
    }
  });

  it("with no outline for the garment, nothing is pinned", () => {
    const map = buildFlawMap(groups, null);
    expect(map.pinned).toEqual([]);
    expect(map.unmapped).toHaveLength(4);
  });
});

describe("parity with the edge coverage catalog", () => {
  it("uses the same keywords, in the same order, as services/edge-functions/src/lib/coverage.ts", () => {
    const edge = readFileSync(
      resolve(__dirname, "../../services/edge-functions/src/lib/coverage.ts"),
      "utf8",
    );
    const block = edge.match(/const HINT_ALIASES[^=]*=\s*\[([\s\S]*?)\n\];/);
    expect(block).not.toBeNull();
    const pairs = [...(block?.[1] ?? "").matchAll(/\["([^"]+)",\s*"([^"]+)"\]/g)].map((m) => [m[1], m[2]]);
    expect(pairs.length).toBeGreaterThan(20);
    expect(HINT_ALIASES.map(([t, z]) => [t, z])).toEqual(pairs);
  });
});
