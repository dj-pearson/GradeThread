import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";

// DASH-15: land on the exact row a link named.
//
// A Needs-you row on the Overview knows the id of the return, case or offer it
// counts, and used to link to the queue page only, so a seller clicking a
// return with a one-day deadline had to find it again. Now it links with
// `?focus=<id>`, and the page marks its rows with `data-focus-id`. This hook
// finds that row once it has rendered, scrolls it into view, highlights it
// (`data-focused="true"`, which the row styles) and moves keyboard focus to
// it.

/** The attribute a focusable row carries. */
export const FOCUS_ATTR = "data-focus-id";

/** How long to keep looking for a row that renders after its data arrives. */
const FIND_FOR_MS = 3000;

function findRow(id: string): HTMLElement | null {
  const all = [...document.querySelectorAll<HTMLElement>(`[${FOCUS_ATTR}]`)].filter(
    (el) => el.getAttribute(FOCUS_ATTR) === id,
  );
  // A page can render the same row twice (a table at md+, cards below it);
  // take the one that is actually laid out.
  return all.find((el) => el.getClientRects().length > 0) ?? all[0] ?? null;
}

export interface FocusParam {
  /** The `?focus=` value, or null. */
  focusId: string | null;
  /**
   * True once the page's data has loaded and the id is not in it: the case
   * was closed or the offer expired. The page says so instead of silently
   * showing the list.
   */
  missing: boolean;
}

/**
 * @param ready  the page's data has loaded, so an absent row means gone.
 * @param known  the id is among the rows the page can show.
 */
export function useFocusParam({
  ready,
  known,
}: {
  ready: boolean;
  known: boolean;
}): FocusParam {
  const [searchParams] = useSearchParams();
  const focusId = searchParams.get("focus");
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!focusId || !ready || !known || done === focusId) return;
    let cancelled = false;
    const started = Date.now();
    const attempt = () => {
      if (cancelled) return;
      const row = findRow(focusId);
      if (row) {
        if (!row.hasAttribute("tabindex")) row.setAttribute("tabindex", "-1");
        row.setAttribute("data-focused", "true");
        row.scrollIntoView?.({ block: "center", behavior: "smooth" });
        row.focus({ preventScroll: true });
        setDone(focusId);
        return;
      }
      if (Date.now() - started < FIND_FOR_MS) setTimeout(attempt, 100);
    };
    attempt();
    return () => {
      cancelled = true;
    };
  }, [focusId, ready, known, done]);

  return { focusId, missing: !!focusId && ready && !known };
}
