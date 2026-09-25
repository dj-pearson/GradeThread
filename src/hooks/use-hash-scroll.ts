import { useEffect } from "react";
import { useLocation } from "react-router";

const MAX_FRAMES = 60;

// Scrolls to the element named by the URL hash once it exists.
//
// The browser's own jump to #email-preferences fires when the document loads,
// but the Settings sections mount later (lazy chunks, then the active tab), so
// by the time the card exists the jump has already missed and the reader lands
// above about forty switches. This retries once per animation frame, for about
// a second, until getElementById finds the target, then scrolls to it and moves
// focus there without scrolling again. `dep` re-runs it when the section
// changes (the active tab), since a different tab mounts different anchors.
export function useHashScroll(dep: unknown): void {
  const { hash } = useLocation();
  useEffect(() => {
    const id = hash.startsWith("#") ? decodeURIComponent(hash.slice(1)) : "";
    if (!id) return;
    let frame = 0;
    let handle = 0;
    const tryScroll = () => {
      const el = document.getElementById(id);
      if (el) {
        el.scrollIntoView({ block: "start" });
        if (!el.hasAttribute("tabindex") && el.tabIndex < 0) {
          el.setAttribute("tabindex", "-1");
        }
        el.focus({ preventScroll: true });
        return;
      }
      if (++frame < MAX_FRAMES) handle = requestAnimationFrame(tryScroll);
    };
    handle = requestAnimationFrame(tryScroll);
    return () => cancelAnimationFrame(handle);
  }, [hash, dep]);
}
