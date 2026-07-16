// US-1906: pure layout/windowing math for the AutoLister grouping workbench's
// virtualized surfaces. The workbench used to mount every tile behind
// IntersectionObserver "load more" chunks; it now renders the ungrouped grid and
// the group list through @tanstack/react-virtual. Keeping the arithmetic here
// (rather than inline in the 3.9k-line page) makes it unit-testable and keeps
// the two virtualizers honest about the SAME breakpoints the Tailwind classes use.

/**
 * Column count for the ungrouped grid at a given viewport width.
 *
 * Mirrors the grid's classes — `grid-cols-3 sm:grid-cols-5 md:grid-cols-7` —
 * which are VIEWPORT media queries (Tailwind sm=640px, md=768px), not container
 * queries. Change one and you must change the other or rows mis-measure.
 */
export function ungroupedGridColumns(viewportWidth: number): number {
  if (viewportWidth >= 768) return 7;
  if (viewportWidth >= 640) return 5;
  return 3;
}

/** Number of virtual rows needed to lay `itemCount` tiles out `columns` wide. */
export function gridRowCount(itemCount: number, columns: number): number {
  if (itemCount <= 0 || columns <= 0) return 0;
  return Math.ceil(itemCount / columns);
}

/** The items belonging to one virtual row (short at the end — never padded). */
export function gridRowItems<T>(items: T[], rowIndex: number, columns: number): T[] {
  if (columns <= 0) return [];
  const start = rowIndex * columns;
  return items.slice(start, start + columns);
}

/**
 * Height of one grid row in px, gap included.
 *
 * Tiles are `aspect-square`, so a tile's height equals its width: the row's
 * usable width minus the inter-column gaps, split evenly. The fixed aspect is
 * what keeps the virtualizer's estimate exact and the page free of layout shift
 * when a thumbnail finally loads — don't let a tile size to its image.
 */
export function squareTileRowHeight(
  containerWidth: number,
  columns: number,
  gap: number,
): number {
  if (columns <= 0 || containerWidth <= 0) return 0;
  const tile = (containerWidth - gap * (columns - 1)) / columns;
  return Math.max(0, tile) + gap;
}

/**
 * The indexes to render for a frame: the virtualizer's own window plus a pinned
 * index, kept sorted and de-duplicated.
 *
 * Virtualization and dnd-kit disagree on one point: the virtualizer wants to
 * unmount whatever scrolls away, but unmounting the node a drag STARTED from
 * cancels that drag (dnd-kit loses the active node). So while a drag is live we
 * pin the source row/group — it stays mounted however far the user auto-scrolls
 * toward the drop target. `pinned` is null when nothing is being dragged, which
 * makes this a no-op on the common path.
 */
export function pinnedVirtualIndexes(
  windowIndexes: number[],
  pinned: number | null,
): number[] {
  if (pinned == null || pinned < 0 || windowIndexes.includes(pinned)) {
    return windowIndexes;
  }
  return [...windowIndexes, pinned].sort((a, b) => a - b);
}
