import { describe, it, expect } from "vitest";
import {
  gridRowCount,
  gridRowItems,
  pinnedVirtualIndexes,
  squareTileRowHeight,
  ungroupedGridColumns,
} from "./autolister-virtual-grid";

describe("ungroupedGridColumns (US-1906)", () => {
  it("mirrors the grid's Tailwind breakpoints (3 / sm:5 / md:7)", () => {
    expect(ungroupedGridColumns(320)).toBe(3);
    expect(ungroupedGridColumns(639)).toBe(3);
    expect(ungroupedGridColumns(640)).toBe(5);
    expect(ungroupedGridColumns(767)).toBe(5);
    expect(ungroupedGridColumns(768)).toBe(7);
    expect(ungroupedGridColumns(2560)).toBe(7);
  });

  it("never returns 0 columns, even at a degenerate width", () => {
    expect(ungroupedGridColumns(0)).toBe(3);
  });
});

describe("gridRowCount (US-1906)", () => {
  it("counts full and partial rows", () => {
    expect(gridRowCount(600, 7)).toBe(86); // 85 full rows + a 5-tile remainder
    expect(gridRowCount(14, 7)).toBe(2);
    expect(gridRowCount(1, 7)).toBe(1);
  });

  it("is 0 for an empty grid", () => {
    expect(gridRowCount(0, 7)).toBe(0);
  });

  it("guards against a 0 column count instead of dividing by zero", () => {
    expect(gridRowCount(600, 0)).toBe(0);
    expect(Number.isFinite(gridRowCount(600, 0))).toBe(true);
  });
});

describe("gridRowItems (US-1906)", () => {
  const items = Array.from({ length: 10 }, (_, i) => `p${i}`);

  it("slices the row's items in order", () => {
    expect(gridRowItems(items, 0, 3)).toEqual(["p0", "p1", "p2"]);
    expect(gridRowItems(items, 2, 3)).toEqual(["p6", "p7", "p8"]);
  });

  it("returns a short last row rather than padding it", () => {
    expect(gridRowItems(items, 3, 3)).toEqual(["p9"]);
  });

  it("returns nothing past the end", () => {
    expect(gridRowItems(items, 9, 3)).toEqual([]);
  });

  it("reassembles the full list across every row (no photo dropped or doubled)", () => {
    const columns = 7;
    const rows = gridRowCount(items.length, columns);
    const flat = Array.from({ length: rows }, (_, r) => gridRowItems(items, r, columns)).flat();
    expect(flat).toEqual(items);
  });
});

describe("squareTileRowHeight (US-1906)", () => {
  it("derives the row height from the square tile plus one gap", () => {
    // 7 columns, 8px gap (gap-2), 1000px wide: tiles are (1000 - 48) / 7 = 136.
    expect(squareTileRowHeight(1000, 7, 8)).toBeCloseTo(144);
  });

  it("handles a single column (no inter-column gaps)", () => {
    expect(squareTileRowHeight(300, 1, 8)).toBeCloseTo(308);
  });

  it("never returns a negative height when gaps exceed the width", () => {
    expect(squareTileRowHeight(10, 7, 8)).toBeGreaterThanOrEqual(0);
  });

  it("is 0 before the container has been measured", () => {
    expect(squareTileRowHeight(0, 7, 8)).toBe(0);
  });
});

describe("a 600-photo session mounts a bounded number of tiles (US-1906)", () => {
  // The point of the story: what mounts must scale with the VIEWPORT, not with
  // the session size. This asserts that invariant on the layout math the grid
  // virtualizer is driven by — 600 photos must not imply 600 mounted tiles.
  const PHOTOS = 600;
  const CONTAINER = 1000;
  const VIEWPORT_HEIGHT = 900;
  const OVERSCAN_ROWS = 4;

  function mountedRows(photoCount: number): number {
    const columns = ungroupedGridColumns(1440);
    const rowHeight = squareTileRowHeight(CONTAINER, columns, 8);
    const rowsInView = Math.ceil(VIEWPORT_HEIGHT / rowHeight) + 1;
    // The virtualizer renders the visible rows plus overscan above AND below.
    return Math.min(gridRowCount(photoCount, columns), rowsInView + OVERSCAN_ROWS * 2);
  }

  it("mounts a fraction of the grid's rows", () => {
    const columns = ungroupedGridColumns(1440);
    const total = gridRowCount(PHOTOS, columns);
    expect(total).toBe(86);
    expect(mountedRows(PHOTOS)).toBeLessThan(total / 2);
  });

  it("mounts no more tiles for 600 photos than for 200", () => {
    expect(mountedRows(PHOTOS)).toBe(mountedRows(200));
  });

  it("still renders every row when the session is smaller than one window", () => {
    const columns = ungroupedGridColumns(1440);
    expect(mountedRows(14)).toBe(gridRowCount(14, columns));
  });
});

describe("pinnedVirtualIndexes (US-1906)", () => {
  it("passes the window through untouched when nothing is dragging", () => {
    const window = [4, 5, 6];
    expect(pinnedVirtualIndexes(window, null)).toBe(window);
  });

  it("keeps the drag source mounted when it has scrolled out of the window", () => {
    expect(pinnedVirtualIndexes([40, 41, 42], 2)).toEqual([2, 40, 41, 42]);
  });

  it("does not duplicate a pinned index already in the window", () => {
    expect(pinnedVirtualIndexes([4, 5, 6], 5)).toEqual([4, 5, 6]);
  });

  it("stays sorted so rows render in document order", () => {
    expect(pinnedVirtualIndexes([1, 2, 3], 99)).toEqual([1, 2, 3, 99]);
  });

  it("ignores a negative (unresolved) pin", () => {
    expect(pinnedVirtualIndexes([1, 2], -1)).toEqual([1, 2]);
  });
});
