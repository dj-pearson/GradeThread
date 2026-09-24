import { useCallback, useEffect, useLayoutEffect, useState } from "react";

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
export function useWindowVirtualAnchor<T extends HTMLElement>(): [
  (node: T | null) => void,
  WindowVirtualAnchor,
] {
  const [anchor, setAnchor] = useState<WindowVirtualAnchor>({
    offsetTop: 0,
    width: 0,
    viewportWidth: 0,
  });
  // AL-12: a CALLBACK ref. The lists this measures render only once they have
  // content, so on a fresh session the node does not exist at mount; a ref
  // object read in an effect saw null, never measured, and a 7-column desktop
  // grid rendered 3 columns until a reload. The node is now measured and
  // observed the moment it attaches, and released when it detaches.
  const [node, setNode] = useState<T | null>(null);

  const measure = useCallback(() => {
    if (!node) return;
    const rect = node.getBoundingClientRect();
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
  }, [node]);

  useLayoutEffect(measure, [measure]);

  useEffect(() => {
    if (!node) return;
    window.addEventListener("resize", measure);
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(measure);
      observer.observe(node);
      // Content ABOVE the list changes its offsetTop without resizing the list
      // itself, so watch the document body too.
      observer.observe(document.body);
    }
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [node, measure]);

  return [setNode, anchor];
}
