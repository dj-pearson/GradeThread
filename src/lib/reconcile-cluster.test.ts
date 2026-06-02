import { describe, it, expect } from "vitest";
import { clusterByTimeGap, DEFAULT_GAP_SECONDS, type ClusterablePhoto } from "./reconcile-cluster";

// Helper: a photo at `t` seconds past a fixed epoch (or no capture time).
const base = Date.UTC(2025, 0, 1, 12, 0, 0);
function photo(id: string, seconds: number | null): ClusterablePhoto {
  return { id, capturedAt: seconds === null ? null : new Date(base + seconds * 1000) };
}
const ids = (group: ClusterablePhoto[]) => group.map((p) => p.id);

describe("clusterByTimeGap", () => {
  it("returns empty results for no photos", () => {
    const { clusters, needsSorting } = clusterByTimeGap([], 30);
    expect(clusters).toEqual([]);
    expect(needsSorting).toEqual([]);
  });

  it("puts a single timed photo in its own cluster", () => {
    const { clusters, needsSorting } = clusterByTimeGap([photo("a", 0)], 30);
    expect(clusters.map(ids)).toEqual([["a"]]);
    expect(needsSorting).toEqual([]);
  });

  it("groups photos within the gap and splits when the gap is exceeded", () => {
    // a,b,c are 0/10/20s apart (<30); then a 40s jump to d,e at 60/65s.
    const input = [
      photo("a", 0),
      photo("b", 10),
      photo("c", 20),
      photo("d", 60),
      photo("e", 65),
    ];
    const { clusters } = clusterByTimeGap(input, 30);
    expect(clusters.map(ids)).toEqual([["a", "b", "c"], ["d", "e"]]);
  });

  it("treats a gap exactly equal to the threshold as a new cluster (>=)", () => {
    // Exactly 30s apart -> split, per the '>= threshold' rule.
    const { clusters } = clusterByTimeGap([photo("a", 0), photo("b", 30)], 30);
    expect(clusters.map(ids)).toEqual([["a"], ["b"]]);

    // 29s apart -> same cluster (just under).
    const { clusters: c2 } = clusterByTimeGap([photo("a", 0), photo("b", 29)], 30);
    expect(c2.map(ids)).toEqual([["a", "b"]]);
  });

  it("sorts out-of-order photos by capture time before clustering", () => {
    const input = [photo("c", 20), photo("a", 0), photo("e", 65), photo("b", 10), photo("d", 60)];
    const { clusters } = clusterByTimeGap(input, 30);
    expect(clusters.map(ids)).toEqual([["a", "b", "c"], ["d", "e"]]);
  });

  it("routes photos with no capture time to the Needs-sorting bucket", () => {
    const input = [photo("a", 0), photo("x", null), photo("b", 5), photo("y", null)];
    const { clusters, needsSorting } = clusterByTimeGap(input, 30);
    expect(clusters.map(ids)).toEqual([["a", "b"]]);
    expect(ids(needsSorting)).toEqual(["x", "y"]);
  });

  it("re-clusters live when the threshold changes", () => {
    const input = [photo("a", 0), photo("b", 10), photo("c", 20)];
    // Tight threshold splits each 10s gap.
    expect(clusterByTimeGap(input, 5).clusters.map(ids)).toEqual([["a"], ["b"], ["c"]]);
    // Loose threshold keeps them together.
    expect(clusterByTimeGap(input, 60).clusters.map(ids)).toEqual([["a", "b", "c"]]);
  });

  it("keeps identical timestamps in the same cluster even at gap 0", () => {
    const input = [photo("a", 5), photo("b", 5), photo("c", 5)];
    const { clusters } = clusterByTimeGap(input, 0);
    expect(clusters.map(ids)).toEqual([["a", "b", "c"]]);
  });

  it("defaults the threshold to 30s", () => {
    expect(DEFAULT_GAP_SECONDS).toBe(30);
    const input = [photo("a", 0), photo("b", 29), photo("c", 60)];
    const { clusters } = clusterByTimeGap(input);
    expect(clusters.map(ids)).toEqual([["a", "b"], ["c"]]);
  });
});

import {
  autoAssign,
  reapplyThreshold,
  moveToNewCluster,
  moveToCluster,
  mergeClusters,
  splitCluster,
  groupAssignments,
  type AssignmentMap,
} from "./reconcile-cluster";

// Deterministic id factory for manual ops.
function seqIds(prefix = "n") {
  let n = 0;
  return () => `${prefix}${++n}`;
}

describe("autoAssign", () => {
  it("assigns timed photos to clusters and untimed to null, all non-manual", () => {
    const photos = [photo("a", 0), photo("b", 10), photo("c", 100), photo("x", null)];
    const map = autoAssign(photos, 30);
    expect(map["a"]!.clusterId).toBe(map["b"]!.clusterId);
    expect(map["a"]!.clusterId).not.toBe(map["c"]!.clusterId);
    expect(map["x"]!.clusterId).toBeNull();
    expect(Object.values(map).every((a) => !a.manual)).toBe(true);
  });
});

describe("manual edit ops", () => {
  const photos = [photo("a", 0), photo("b", 10), photo("c", 20)];
  const baseMap = (): AssignmentMap => autoAssign(photos, 30); // a,b,c all one cluster

  it("moveToNewCluster pulls photos into a fresh manual cluster", () => {
    const map = moveToNewCluster(baseMap(), ["c"], seqIds());
    expect(map["c"]!.clusterId).toBe("manual-n1");
    expect(map["c"]!.manual).toBe(true);
    expect(map["a"]!.clusterId).not.toBe(map["c"]!.clusterId);
  });

  it("moveToCluster moves photos to a named cluster (or null for needs-sorting)", () => {
    const moved = moveToCluster(baseMap(), ["a"], null);
    expect(moved["a"]!.clusterId).toBeNull();
    expect(moved["a"]!.manual).toBe(true);
  });

  it("mergeClusters folds one cluster's photos into another", () => {
    let map = moveToNewCluster(baseMap(), ["c"], seqIds()); // c -> manual-n1
    const target = map["a"]!.clusterId!;
    map = mergeClusters(map, target, "manual-n1");
    expect(map["c"]!.clusterId).toBe(target);
    expect(map["c"]!.manual).toBe(true);
  });

  it("splitCluster behaves like moveToNewCluster for a subset", () => {
    const map = splitCluster(baseMap(), ["a", "b"], seqIds("s"));
    expect(map["a"]!.clusterId).toBe("manual-s1");
    expect(map["b"]!.clusterId).toBe("manual-s1");
    expect(map["c"]!.clusterId).not.toBe("manual-s1");
  });

  it("empty selections are no-ops", () => {
    const map = baseMap();
    expect(moveToNewCluster(map, [])).toBe(map);
    expect(moveToCluster(map, [], "x")).toBe(map);
  });
});

describe("reapplyThreshold", () => {
  it("re-clusters non-manual photos but preserves manual edits", () => {
    const photos = [photo("a", 0), photo("b", 10), photo("c", 20)];
    // Manually pull c into its own cluster at the 30s threshold.
    const edited = moveToNewCluster(autoAssign(photos, 30), ["c"], seqIds());
    const cCluster = edited["c"]!.clusterId;

    // Tighten the slider to 5s — a/b would now split, but c must stay put.
    const next = reapplyThreshold(edited, photos, 5);
    expect(next["c"]!.clusterId).toBe(cCluster); // manual preserved
    expect(next["c"]!.manual).toBe(true);
    expect(next["a"]!.clusterId).not.toBe(next["b"]!.clusterId); // a,b re-split
  });

  it("auto-assigns brand-new photos added after manual edits", () => {
    const photos = [photo("a", 0), photo("b", 10)];
    const edited = moveToNewCluster(autoAssign(photos, 30), ["a"], seqIds());
    const withNew = [...photos, photo("d", 12)];
    const next = reapplyThreshold(edited, withNew, 30);
    expect(next["d"]).toBeDefined();
    expect(next["d"]!.manual).toBe(false);
  });
});

describe("groupAssignments", () => {
  it("orders clusters by earliest capture time and splits out needs-sorting", () => {
    const photos = [photo("a", 100), photo("b", 0), photo("x", null)];
    const map: AssignmentMap = {
      a: { clusterId: "late", manual: false },
      b: { clusterId: "early", manual: false },
      x: { clusterId: null, manual: false },
    };
    const { clusters, needsSorting } = groupAssignments(photos, map);
    expect(clusters.map((c) => c.clusterId)).toEqual(["early", "late"]);
    expect(needsSorting.map((p) => p.id)).toEqual(["x"]);
  });
});
