import { AdSpendCard } from "@/components/flipdesk/ad-spend-card";
import {
  DEFAULT_OVERVIEW_RANGE,
  overviewRangeDays,
  overviewRangeDef,
} from "@/lib/overview-range";
import type { WidgetProps } from "@/lib/dashboard-widgets";

// US-3078 AC2: what advertising cost, in the window the board is showing.
//
// The card is imported, not rebuilt: the Money page renders the same component,
// and a second table of eBay money lines is a second set of numbers to
// reconcile the first against.
//
// The card takes a day window, so the board's range is converted to days and
// passed down. `key` remounts it when the seller moves the picker, which is the
// whole behaviour of the card's own 30/90/365 buttons: a local pick sticks
// until the board's window moves, and then the board wins again.

/**
 * The furthest back eBay's Finances feed goes; the edge route clamps to it too.
 * Anything past this is not available at any price, so the widget says so
 * rather than letting the frame's "all time" stand over a year of data.
 */
const EBAY_FINANCES_MAX_DAYS = 365;

export function FlipdeskAdSpendWidget({ range }: WidgetProps) {
  const rangeId = range ?? DEFAULT_OVERVIEW_RANGE;
  const asked = overviewRangeDays(rangeId);
  const days = Math.min(asked ?? EBAY_FINANCES_MAX_DAYS, EBAY_FINANCES_MAX_DAYS);
  // True when the frame's heading promises a longer window than eBay will
  // serve, which "All time" always does and a late-December "Year to date" can.
  const capped = asked === null || asked > EBAY_FINANCES_MAX_DAYS;

  return (
    <div className="space-y-2">
      <AdSpendCard key={days} days={days} />
      {capped ? (
        <p className="text-xs text-muted-foreground">
          eBay only keeps {EBAY_FINANCES_MAX_DAYS} days of transactions, so this
          covers the last {EBAY_FINANCES_MAX_DAYS} days rather than{" "}
          {overviewRangeDef(rangeId).label.toLowerCase()}.
        </p>
      ) : null}
    </div>
  );
}
