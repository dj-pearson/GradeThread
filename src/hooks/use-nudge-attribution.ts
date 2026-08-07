import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router";
import { edgeFetch } from "@/lib/edge-fetch";

// US-1859: the click half of nudge attribution.
//
// A re-engagement nudge deep-links with `?nudge=<sendId>`. Landing on the page
// is the click, so this posts it back once and then STRIPS the param.
//
// Stripping matters more than it looks: without it, a bookmark, a shared URL or
// a back-navigation would re-post the same send forever, and the click rate — the
// number that decides whether this feature keeps running — would be a count of
// page views rather than of nudges opened. The server-side `.is("clicked_at",
// null)` guard is the real defence; this is the one that stops us generating the
// traffic in the first place.
//
// Best-effort throughout: an attribution failure is silent. Nothing on the page
// depends on it, and a toast about a measurement problem is a worse experience
// than a missing data point.
export function useNudgeAttribution(): void {
  const [params, setParams] = useSearchParams();
  const sent = useRef<string | null>(null);
  const nudgeId = params.get("nudge");

  useEffect(() => {
    if (!nudgeId || sent.current === nudgeId) return;
    sent.current = nudgeId;

    void edgeFetch(`/api/rewards/nudges/${encodeURIComponent(nudgeId)}/click`, {
      method: "POST",
      skipWorkspaceHeader: true,
    }).catch(() => {});

    // Drop `nudge` and the utm trio the notification carried, keeping anything
    // else on the URL (a saved view, a tab) intact. `replace` so the un-stripped
    // URL never becomes a history entry the back button can return to.
    const next = new URLSearchParams(params);
    for (const key of ["nudge", "utm_source", "utm_medium", "utm_campaign"]) {
      next.delete(key);
    }
    setParams(next, { replace: true });
  }, [nudgeId, params, setParams]);
}
