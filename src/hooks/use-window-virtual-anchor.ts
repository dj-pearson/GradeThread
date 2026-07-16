import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from "react";

export interface WindowVirtualAnchor {
  /** Distance from the top of the DOCUMENT to the list — `scrollMargin`. */
  offsetTop: number;
  /** The list's content width, for deriving a square tile's row height. */
  width: number;
  /**
   * The VIEWPORT width. Not interchangeable with `width`: a responsive grid's
   * `sm:`/`md:` column classes are viewport media queries, so the column count
   * must be resolved against this, while the tile size comes from `width`.
   */
  viewportWidth: number;
}

/**
 * US-1906: measure a page-scrolled list for `useWindowVirtualizer`.
 *
 * A window virtualizer measures against the document, so it needs the list's
 * `scrollMargin` (how far down the page it starts) — otherwise every row is
 * offset by whatever chrome sits above it. That offset is not static here: the
 * upload progress panel, the triage strip, and the AI-suggestion chips all grow
 * and shrink above the list, so we re-measure on any body resize, not just on
 * window resize.
 */
export function useWindowVirtualAnchor<T extends HTMLElement>(
  ref: RefObject<T | null>,
): WindowVirtualAnchor {
  const [anchor, setAnchor] = useState<WindowVirtualAnchor>({
    offsetTop: 0,
    width: 0,
    viewportWidth: 0,
  });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const next = {
      offsetTop: Math.round(rect.top + window.scrollY),
      width: Math.round(rect.width),
      viewportWidth: window.innerWidth,
    };
    // Only commit real changes — a ResizeObserver that setStates unconditionally
    // re-renders forever.
    setAnchor((prev) =>
      prev.offsetTop === next.offsetTop &&
      prev.width === next.width &&
      prev.viewportWidth === next.viewportWidth
        ? prev
        : next,
    );
  }, [ref]);

  useLayoutEffect(measure, [measure]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // Content ABOVE the list changes its offsetTop without resizing the list
    // itself, so watch the document body too.
    observer.observe(document.body);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [ref, measure]);

  return anchor;
}
