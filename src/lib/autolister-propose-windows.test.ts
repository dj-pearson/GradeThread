import { describe, expect, it } from "vitest";
import {
  type ClientProposedGroup,
  mergeProposalWindows,
  planProposeWindows,
  PROPOSE_OVERLAP,
  PROPOSE_WINDOW,
} from "./autolister-propose-windows";

// US-1904: window a big dump with overlap, then stitch the per-window proposals
// so a seam-spanning item stays whole.

const ids = (n: number, prefix = "p") => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

describe("planProposeWindows", () => {
  it("returns a single window when everything fits", () => {
    expect(planProposeWindows(ids(40), 40, 4)).toEqual([ids(40)]);
  });

  it("returns [] for no photos", () => {
    expect(planProposeWindows([], 40, 4)).toEqual([]);
  });

  it("overlaps adjacent windows by `overlap` and covers every photo", () => {
    const all = ids(100);
    const windows = planProposeWindows(all, 40, 4); // step = 36
    expect(windows[0]).toEqual(all.slice(0, 40));
    expect(windows[1]).toEqual(all.slice(36, 76));
    expect(windows[2]).toEqual(all.slice(72, 100));
    // overlap: last 4 of window 0 === first 4 of window 1
    expect(windows[0]!.slice(-4)).toEqual(windows[1]!.slice(0, 4));
    // union covers all
    expect(new Set(windows.flat()).size).toBe(100);
  });

  it("guarantees progress even if overlap ≥ windowSize", () => {
    const windows = planProposeWindows(ids(10), 3, 5); // clamped overlap → step ≥ 1
    expect(windows.length).toBeGreaterThan(1);
    expect(new Set(windows.flat()).size).toBe(10);
  });

  it("exposes the server-matched defaults", () => {
    expect(PROPOSE_WINDOW).toBe(40);
    expect(PROPOSE_OVERLAP).toBe(4);
  });
});

describe("mergeProposalWindows", () => {
  const g = (photoIds: string[], confidence = 0.9, reason = ""): ClientProposedGroup => ({
    photoIds,
    confidence,
    reason,
  });

  it("passes a single window through unchanged", () => {
    const win = [g(["p1", "p2"]), g(["p3"])];
    expect(mergeProposalWindows([win])).toEqual(win);
  });

  it("merges a seam-spanning item across two overlapping windows", () => {
    // window A ends with item [p4,p5]; window B starts with the SAME item
    // continuing into p6,p7 (p4,p5 are the overlap).
    const a = [g(["p1", "p2", "p3"]), g(["p4", "p5"], 0.8, "jacket")];
    const b = [g(["p4", "p5", "p6", "p7"], 0.5, "still jacket"), g(["p8"], 0.9, "tee")];
    const merged = mergeProposalWindows([a, b]);
    expect(merged.map((x) => x.photoIds)).toEqual([
      ["p1", "p2", "p3"],
      ["p4", "p5", "p6", "p7"], // stitched, no split at the seam
      ["p8"],
    ]);
    // the seam group keeps the ORIGINAL boundary's confidence/reason
    expect(merged[1]!.confidence).toBe(0.8);
    expect(merged[1]!.reason).toBe("jacket");
  });

  it("dedupes photos and drops a group wholly inside the overlap", () => {
    const a = [g(["p1", "p2"]), g(["p3", "p4"])];
    const b = [g(["p3", "p4"]), g(["p5"])]; // first B group is entirely overlap
    const merged = mergeProposalWindows([a, b]);
    expect(merged.map((x) => x.photoIds)).toEqual([["p1", "p2"], ["p3", "p4"], ["p5"]]);
    expect(new Set(merged.flat().flatMap((_, i) => merged[i]!.photoIds)).size).toBe(5);
  });

  it("starts a fresh item when the boundary lands exactly on the seam", () => {
    // window B's first group shares NO photo with A's last group → new item
    const a = [g(["p1", "p2", "p3", "p4"])];
    const b = [g(["p4"]), g(["p5", "p6"])]; // p4 overlap alone → dropped; p5.. new
    const merged = mergeProposalWindows([a, b]);
    expect(merged.map((x) => x.photoIds)).toEqual([["p1", "p2", "p3", "p4"], ["p5", "p6"]]);
  });
});
