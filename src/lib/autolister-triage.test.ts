import { describe, expect, it } from "vitest";
import { computeTriage, type TriageGroup } from "./autolister-triage";

// US-1907: triage buckets drive the needs-attention chips + list filters.

const grp = (
  id: string,
  photoIds: string[],
  opts: { coverId?: string | null; roles?: Record<string, string> } = {},
): TriageGroup => ({
  id,
  photoIds,
  coverId: opts.coverId === undefined ? (photoIds[0] ?? null) : opts.coverId,
  roles: opts.roles ?? {},
});

describe("computeTriage", () => {
  it("totals photos, groups, and ungrouped", () => {
    const s = computeTriage(
      [grp("a", ["p1", "p2"], { roles: { p2: "tag" } }), grp("b", ["p3"])],
      [],
      5,
      12,
    );
    expect(s.totalGroups).toBe(2);
    expect(s.totalPhotos).toBe(3);
    expect(s.ungroupedCount).toBe(5);
  });

  it("flags singletons and oversized groups", () => {
    const big = Array.from({ length: 13 }, (_, i) => `p${i}`);
    const s = computeTriage(
      [grp("solo", ["x"]), grp("big", big, { roles: { p1: "tag" } })],
      [],
      0,
      12,
    );
    expect(s.buckets.singleton).toEqual(["solo"]);
    expect(s.buckets.oversized).toEqual(["big"]); // 13 > 12
  });

  it("does not flag a 12-photo group as oversized (boundary)", () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `p${i}`);
    const s = computeTriage([grp("g", twelve, { roles: { p0: "tag" } })], [], 0, 12);
    expect(s.buckets.oversized).toEqual([]);
  });

  it("flags a group missing a cover OR a tag photo", () => {
    const s = computeTriage(
      [
        grp("noTag", ["p1", "p2"], { roles: { p1: "detail", p2: "back" } }),
        grp("hasTag", ["p3", "p4"], { roles: { p4: "tag" } }),
        grp("noCover", ["p5", "p6"], { coverId: null, roles: { p6: "tag" } }),
      ],
      [],
      0,
      12,
    );
    expect(s.buckets.missing_cover_or_tag).toEqual(["noTag", "noCover"]);
  });

  it("flags groups with unresolved suggestions (move → source only)", () => {
    const s = computeTriage(
      [
        grp("a", ["p1"], { roles: { p1: "tag" }, coverId: "p1" }),
        grp("b", ["p2"], { roles: { p2: "tag" }, coverId: "p2" }),
        grp("c", ["p3"], { roles: { p3: "tag" }, coverId: "p3" }),
      ],
      [
        { type: "merge", group_ids: ["a", "b"] },
        { type: "move", group_ids: ["c", "a"] }, // only source c flagged
        { type: "split", group_ids: ["gone"] }, // non-existent group ignored
      ],
      0,
      12,
    );
    // singletons all (1 photo each) but has_suggestion is a/b/c in group order
    expect(s.buckets.has_suggestion).toEqual(["a", "b", "c"]);
  });

  it("keeps bucket ids in group order", () => {
    const s = computeTriage(
      [grp("z", ["x"]), grp("y", ["w"]), grp("x", ["v"])],
      [],
      0,
      12,
    );
    expect(s.buckets.singleton).toEqual(["z", "y", "x"]);
  });
});
