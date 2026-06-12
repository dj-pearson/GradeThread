import { useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { cn } from "@/lib/utils";

interface VirtualListProps<T> {
  items: T[];
  /** Stable key per row — required so React reconciles rows correctly. */
  getKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => ReactNode;
  /** Best-guess row height in px; rows are re-measured after mount. */
  estimateSize?: number;
  /** Vertical gap between rows in px (replaces space-y-* on the list). */
  gap?: number;
  /** Extra rows rendered above/below the viewport to smooth fast scrolls. */
  overscan?: number;
  /** Scroll-container classes — set a bounded height here (e.g. max-h-[70vh]). */
  className?: string;
}

// US-416: window-less, element-scoped list virtualizer for the FlipDesk surfaces
// that can grow unbounded (autolister queue, bulk-intake session). Only the rows
// in (and just around) the viewport mount, so a 1k+ row haul scrolls smoothly on
// low-end devices instead of mounting thousands of nodes. Rows are dynamically
// measured, so variable-height content (e.g. an expanded reconcile panel) is fine.
export function VirtualList<T>({
  items,
  getKey,
  renderItem,
  estimateSize = 80,
  gap = 0,
  overscan = 8,
  className,
}: VirtualListProps<T>) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => estimateSize,
    overscan,
    gap,
  });

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div ref={parentRef} className={cn("overflow-y-auto", className)}>
      <div
        style={{
          height: virtualizer.getTotalSize(),
          position: "relative",
          width: "100%",
        }}
      >
        {virtualItems.map((vi) => {
          const item = items[vi.index];
          if (item === undefined) return null;
          return (
            <div
              key={getKey(item, vi.index)}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${vi.start}px)`,
              }}
            >
              {renderItem(item, vi.index)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
