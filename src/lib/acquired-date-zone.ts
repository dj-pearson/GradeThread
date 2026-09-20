// US-3314: the zone that named an acquisition day, recorded beside the day.
//
// WHY THIS IS ONE FUNCTION AND NOT FOUR CALLS TO detectTimezone(). The rule it
// carries is not "what zone is the browser in", which is a one-liner; it is
// "a day written without a zone is a day a future repair may not touch". Four
// write sites deciding that separately is how three of them end up right and
// one of them silently stops. `acquired-date-zone.test.ts` scans the writers
// for exactly this call, so the rule has somewhere to live.
//
// WHAT THE ZONE IS FOR, and the honest limit. It is only load-bearing where
// the day was DERIVED from a moment -- the iOS catalogue path, which named the
// day in UTC from a local wall-clock time until US-3310 and is the defect this
// story exists for. Every web writer here takes a date the seller TYPED, where
// no zone can correct anything. It is still recorded, because the repair that
// may one day run on the derived rows has to be able to tell the two apart,
// and a NULL is what says "do not touch this one".

import { detectTimezone } from "@/lib/scheduling";

/**
 * The IANA zone to store beside `acquired_date`, or null when no day is being
 * written.
 *
 * Null in, null out, deliberately: a zone on a row with no acquisition day
 * says the day was named somewhere, which would be false.
 */
export function acquiredDateZoneFor(day: string | null | undefined): string | null {
  if (typeof day !== "string" || day.trim() === "") return null;
  return detectTimezone();
}
