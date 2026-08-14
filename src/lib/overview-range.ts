// US-2547: the date range the FlipDesk Overview reports on.
//
// Every flow figure on that page used to be hardcoded to "this week" or to
// all-time, so a seller could not ask "how did last month go". The range lives
// here rather than in the page because two things need to agree about it: the
// window sent to `flipdesk_overview_metrics`, and the words each card uses to
// say which window it is showing. A card that says "this week" over a 30-day
// number is the same class of defect as the pipeline tile that promised a
// filter it did not apply.
//
// Bounds are computed in the VIEWER's local time and sent as ISO instants. The
// upper bound is exclusive and always "now": a range that ran to the end of
// today would include sales that have not happened yet, which reads as a gap
// rather than as an empty future.

export type OverviewRangeId = "d7" | "d30" | "d90" | "ytd" | "all";

export interface OverviewRangeDef {
  id: OverviewRangeId;
  /** Control label — what the seller picks. */
  label: string;
  /** Sentence fragment for a card's own copy: "12 sold in the last 30 days". */
  phrase: string;
}

export const OVERVIEW_RANGES: readonly OverviewRangeDef[] = [
  { id: "d7", label: "7 days", phrase: "in the last 7 days" },
  { id: "d30", label: "30 days", phrase: "in the last 30 days" },
  { id: "d90", label: "90 days", phrase: "in the last 90 days" },
  { id: "ytd", label: "Year to date", phrase: "so far this year" },
  { id: "all", label: "All time", phrase: "all time" },
];

export const DEFAULT_OVERVIEW_RANGE: OverviewRangeId = "d7";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A hand-typed or stale `?range=` value falls back to the default. */
export function isOverviewRangeId(v: string | null | undefined): v is OverviewRangeId {
  return !!v && OVERVIEW_RANGES.some((r) => r.id === v);
}

export function overviewRangeDef(id: OverviewRangeId): OverviewRangeDef {
  return OVERVIEW_RANGES.find((r) => r.id === id) ?? OVERVIEW_RANGES[0];
}

export interface OverviewRangeBounds {
  /** Inclusive lower bound as an ISO instant, or null for unbounded. */
  from: string | null;
  /** Exclusive upper bound as an ISO instant ("now"). */
  to: string;
}

/**
 * The window a range covers.
 *
 * `now` is injected rather than read from the clock so the boundaries are
 * testable — the same reason `matchesSoldFilter` takes one.
 */
export function overviewRangeBounds(
  id: OverviewRangeId,
  now: Date = new Date(),
): OverviewRangeBounds {
  const to = now.toISOString();
  if (id === "all") return { from: null, to };
  if (id === "ytd") {
    // The viewer's calendar year — the boundary a seller's tax year uses.
    return { from: new Date(now.getFullYear(), 0, 1).toISOString(), to };
  }
  const days = id === "d7" ? 7 : id === "d30" ? 30 : 90;
  return { from: new Date(now.getTime() - days * DAY_MS).toISOString(), to };
}
