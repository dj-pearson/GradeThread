import { describe, expect, it } from "vitest";
import {
  dedupeSuggestions,
  MAX_VERIFY_SAMPLE_PHOTOS,
  planVerifyWindows,
  sampledSizeForVerify,
  suggestionDedupeKey,
} from "./autolister-verify-windows";

// US-1903: every group gets verified across sequential windows, and
// suggestions aggregate + dedupe across those windows.

const g = (id: string, photoCount: number) => ({ id, photoCount });

describe("sampledSizeForVerify", () => {
  it("caps at 3 (first/middle/last) for big groups, fewer for tiny ones", () => {
    expect(sampledSizeForVerify(0)).toBe(0);
    expect(sampledSizeForVerify(1)).toBe(1);
    expect(sampledSizeForVerify(2)).toBe(2);
    expect(sampledSizeForVerify(3)).toBe(3);
    expect(sampledSizeForVerify(50)).toBe(3);
    expect(sampledSizeForVerify(-1)).toBe(0);
  });
});

describe("planVerifyWindows", () => {
  it("keeps everything in one window when it fits the budget", () => {
    const groups = Array.from({ length: 10 }, (_, i) => g(`g${i}`, 3)); // 10*3=30 ≤ 40
    const windows = planVerifyWindows(groups, 40);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toHaveLength(10);
  });

  it("splits a 45-group session into sequential windows, never splitting a group", () => {
    const groups = Array.from({ length: 45 }, (_, i) => g(`g${i}`, 3)); // 3 each → 13/window
    const windows = planVerifyWindows(groups, 40);
    // 13 groups = 39 photos fit; the 14th (would be 42) starts a new window.
    expect(windows[0]).toHaveLength(13);
    // every group appears exactly once, in order, across all windows
    const flat = windows.flat().map((x) => x.id);
    expect(flat).toEqual(groups.map((x) => x.id));
    expect(new Set(flat).size).toBe(45);
    // no window exceeds the budget
    for (const w of windows) {
      const used = w.reduce((n, x) => n + sampledSizeForVerify(x.photoCount), 0);
      expect(used).toBeLessThanOrEqual(40);
    }
  });

  it("accounts for the ≤3 sampling: tiny groups pack more per window", () => {
    const groups = Array.from({ length: 50 }, (_, i) => g(`g${i}`, 1)); // 1 each → 40/window
    const windows = planVerifyWindows(groups, 40);
    expect(windows[0]).toHaveLength(40);
    expect(windows[1]).toHaveLength(10);
  });

  it("drops empty groups", () => {
    const windows = planVerifyWindows([g("a", 2), g("empty", 0), g("b", 2)], 40);
    expect(windows.flat().map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("still places an oversized-sample group alone rather than looping", () => {
    // budget below one group's sample — the group must still land in a window
    const windows = planVerifyWindows([g("a", 3), g("b", 3)], 2);
    expect(windows).toHaveLength(2);
    expect(windows.map((w) => w[0]!.id)).toEqual(["a", "b"]);
  });

  it("defaults to the server budget constant", () => {
    expect(MAX_VERIFY_SAMPLE_PHOTOS).toBe(40);
    const groups = Array.from({ length: 14 }, (_, i) => g(`g${i}`, 3));
    expect(planVerifyWindows(groups)).toHaveLength(2); // uses default 40
  });
});

describe("suggestion dedupe (aggregating across windows)", () => {
  it("treats a merge pair as unordered but a move as directional", () => {
    expect(suggestionDedupeKey({ type: "merge", group_ids: ["a", "b"], photo_ids: [] }))
      .toBe(suggestionDedupeKey({ type: "merge", group_ids: ["b", "a"], photo_ids: [] }));
    expect(suggestionDedupeKey({ type: "move", group_ids: ["a", "b"], photo_ids: ["p"] }))
      .not.toBe(suggestionDedupeKey({ type: "move", group_ids: ["b", "a"], photo_ids: ["p"] }));
  });

  it("is order-insensitive on the photo set", () => {
    expect(suggestionDedupeKey({ type: "split", group_ids: ["g"], photo_ids: ["p2", "p1"] }))
      .toBe(suggestionDedupeKey({ type: "split", group_ids: ["g"], photo_ids: ["p1", "p2"] }));
  });

  it("drops duplicates, keeping first occurrence order", () => {
    const rows = [
      { id: 1, type: "merge" as const, group_ids: ["a", "b"], photo_ids: [] },
      { id: 2, type: "merge" as const, group_ids: ["b", "a"], photo_ids: [] }, // dup of #1
      { id: 3, type: "move" as const, group_ids: ["a", "c"], photo_ids: ["p"] },
    ];
    const out = dedupeSuggestions(rows);
    expect(out.map((r) => r.id)).toEqual([1, 3]);
  });
});
