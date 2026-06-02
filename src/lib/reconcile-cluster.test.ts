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
