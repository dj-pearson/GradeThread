import { describe, expect, it } from "vitest";
import { pruneCommitted } from "@/lib/reconcile-board";
import type { AssignmentMap } from "@/lib/reconcile-cluster";

const photos = ["a1", "a2", "b1", "b2", "c1", "c2", "c3", "d1", "u1"].map((id) => ({ id }));
const assignments: AssignmentMap = {
  a1: { clusterId: "A", manual: false },
  a2: { clusterId: "A", manual: false },
  b1: { clusterId: "B", manual: false },
  b2: { clusterId: "B", manual: false },
  c1: { clusterId: "C", manual: false },
  c2: { clusterId: "C", manual: false },
  c3: { clusterId: "C", manual: false },
  d1: { clusterId: "D", manual: false },
  u1: { clusterId: null, manual: false },
};

describe("pruneCommitted", () => {
  // 3 of 4 clusters succeeded (A, B, D); C saved 2 of 3.
  const results = [
    { clusterId: "A", ok: true, itemId: "iA", savedPhotoIds: ["a1", "a2"] },
    { clusterId: "B", ok: true, itemId: "iB", savedPhotoIds: ["b1", "b2"] },
    { clusterId: "C", ok: false, itemId: "iC", savedPhotoIds: ["c1", "c2"] },
    { clusterId: "D", ok: true, itemId: "iD", savedPhotoIds: ["d1"] },
  ];

  it("drops what went through and keeps the rest committable", () => {
    const out = pruneCommitted(photos, assignments, results);
    expect(out.photos.map((p) => p.id)).toEqual(["c3", "u1"]);
    expect(out.dropped.map((p) => p.id).sort()).toEqual(
      ["a1", "a2", "b1", "b2", "c1", "c2", "d1"].sort(),
    );
    expect(Object.keys(out.assignments).sort()).toEqual(["c3", "u1"]);
  });

  it("remembers the partial cluster's item and pins its leftover", () => {
    const out = pruneCommitted(photos, assignments, results);
    expect(out.resume).toEqual({ C: "iC" });
    expect(out.assignments.c3).toEqual({ clusterId: "C", manual: true });
    expect(out.assignments.u1).toEqual({ clusterId: null, manual: false });
  });

  it("keeps a cluster that failed before any upload exactly as it was", () => {
    const out = pruneCommitted(photos, assignments, [
      { clusterId: "A", ok: false, savedPhotoIds: [] },
    ]);
    expect(out.photos).toHaveLength(photos.length);
    expect(out.resume).toEqual({});
    expect(out.assignments.a1).toEqual({ clusterId: "A", manual: false });
  });
});
