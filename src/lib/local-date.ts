// US-1636: date-only defaults must reflect the USER'S local calendar day, not
// UTC. `new Date().toISOString().split("T")[0]` yields the UTC date, so an
// evening user west of UTC records tomorrow's date — which corrupts tax-year
// boundaries and payout matching. `en-CA` formats as YYYY-MM-DD in the given
// (default: local) timezone, so it's a drop-in for the `<input type="date">`
// value shape.

/** Today's date in the local timezone as YYYY-MM-DD (for `<input type="date">`). */
export function todayLocalDate(): string {
  return new Date().toLocaleDateString("en-CA");
}

/** A specific instant's date in the local timezone as YYYY-MM-DD. */
export function toLocalDate(value: Date | string | number): string {
  return new Date(value).toLocaleDateString("en-CA");
}
