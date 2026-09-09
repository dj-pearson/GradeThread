import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { surfaceLabelFor } from "@/hooks/use-surface-title";

// US-3244. Say out loud that the page changed.
//
// Clicking a nav link in a single-page app swaps the content without a page
// load, so a screen reader announces nothing at all: the user activates a link
// and, as far as anything tells them, stays where they were. GradeThread had
// the neighbouring pieces already -- a skip link, `lang` on <html>, and a polite
// live region on the lazy-route spinner (US-452) -- but nothing named the
// destination once it arrived.
//
// The name comes from surfaceLabelFor, the same resolver behind the browser tab
// title (US-3229), so the two cannot drift into disagreeing about what a page is
// called. That is the whole reason this is four lines of logic rather than a
// second list to maintain.
//
// SILENT ON FIRST PAINT. The initial document title already announces the page,
// and an announcer that fires on load is noise -- and noise is how people learn
// to tune a live region out.
//
// Focus movement is the OTHER half of this pattern and is deliberately not here.
// Sending focus to <main> on every navigation fights with pages that autofocus
// an input (the composer, search), so it needs its own assessment rather than a
// free ride on this one.

export function RouteAnnouncer() {
  const { pathname, search } = useLocation();
  const [message, setMessage] = useState("");
  const firstPaint = useRef(true);

  useEffect(() => {
    if (firstPaint.current) {
      firstPaint.current = false;
      return;
    }
    const label = surfaceLabelFor(pathname, search);
    setMessage(label ? `${label} page` : "Page changed");
  }, [pathname, search]);

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </div>
  );
}
