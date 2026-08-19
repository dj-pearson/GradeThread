// US-9010. The measurement half of the calculator-to-FlipDesk funnel: the hook
// and the query parameter that carries attribution across the hop. Split out of
// the component file so that file exports only components (react-refresh).
//
// One place, so all eight calculators measure the same thing the same way.
//
// FOUR STEPS, and the first one is the one people leave out:
//
//   calculator_view   fires on mount. It is the DENOMINATOR. A funnel built
//                     only from clicks gives you a numerator and nothing to
//                     divide it by, so "is this an acquisition channel or just
//                     traffic" stays unanswerable, which is the exact question
//                     the story asks.
//   calculator_used   fires ONCE, on the first input change. It separates
//                     "landed and read" from "landed and actually computed
//                     something", and those convert very differently.
//   calculator_cta_clicked
//                     fires on the handoff into FlipDesk.
//   signup_started_from_tool
//                     fires on the FlipDesk landing page's signup control when
//                     the visitor arrived from a calculator.
//
// ATTRIBUTION ACROSS THE HOP. The handoff does not go straight to signup — it
// goes to the matching FlipDesk surface, which is where the product gets
// explained. So the calculator slug travels in a `from` query parameter and
// the landing page reads it back. Without that the signup is attributed to the
// landing page and the calculator that produced it disappears.

import { useEffect, useRef } from "react";
import { track } from "@/lib/analytics";

/** Query parameter carrying the originating calculator slug across the hop. */
export const TOOL_SOURCE_PARAM = "from";

/**
 * Fires the view and used events for one calculator.
 *
 * `interacted` should be the value the page already changes when the visitor
 * edits an input — any of them. The hook latches, so it reports the first
 * interaction and then goes quiet for the rest of the visit.
 */
export function useCalculatorFunnel(slug: string, interacted: unknown): void {
  useEffect(() => {
    track("calculator_view", { calculator: slug });
  }, [slug]);

  const first = useRef(interacted);
  const reported = useRef(false);
  useEffect(() => {
    if (reported.current) return;
    // The initial render is not an interaction; only a CHANGE from the value
    // the page mounted with counts.
    if (Object.is(first.current, interacted)) return;
    reported.current = true;
    track("calculator_used", { calculator: slug });
  }, [slug, interacted]);
}

