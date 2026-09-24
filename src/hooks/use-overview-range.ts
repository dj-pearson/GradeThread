import { useEffect, useMemo } from "react";
import { useUrlParamState } from "@/hooks/use-url-param-state";
import {
  overviewRangeKey,
  readOverviewRange,
  resolveOverviewRange,
  writeOverviewRange,
  type OverviewRangeId,
} from "@/lib/overview-range";
import type { OverviewViewId } from "@/lib/overview-view";

/**
 * The Overview's reporting window (US-2547), read on the PAGE and handed down
 * through the board, so no widget goes back to the URL for it.
 *
 * It lives in `?range=` so a seller can bookmark "last 30 days" and hand the
 * link to a partner. FlipDesk only: the grading board has no ranged widget, and
 * a picker over numbers that ignore it is the defect src/lib/overview-range.ts
 * exists to prevent, so on the grading view the param is dropped.
 *
 * Resolved URL first, then this seller's remembered range, then 7 days. The
 * legacy `30d`-style aliases are accepted and the URL is rewritten to the
 * canonical id. The param has no fallback, so picking "7 days" writes d7
 * rather than deleting the param and letting the memory answer instead.
 */
export function useOverviewRange(
  view: OverviewViewId,
  userId: string | null | undefined,
): [OverviewRangeId, (next: string) => void] {
  const [rangeParam, setRangeParam] = useUrlParamState("range");
  const rangeKey = overviewRangeKey(userId);
  const remembered = useMemo(() => readOverviewRange(rangeKey), [rangeKey]);
  const range = resolveOverviewRange(rangeParam, remembered);

  useEffect(() => {
    if (view !== "flipdesk") {
      if (rangeParam) setRangeParam("");
      return;
    }
    writeOverviewRange(rangeKey, range);
    if (rangeParam !== range) setRangeParam(range);
  }, [view, rangeParam, range, rangeKey, setRangeParam]);

  return [range, setRangeParam];
}
