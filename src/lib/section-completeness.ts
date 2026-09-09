// US-3202: "6 of 8 filled" on a composer section header.
//
// Borrowed shamelessly from the cross-listing tools that do this well: a long
// form with a count on every section header stops being a wall and becomes a
// scoreboard, and the seller can see from the collapsed state whether a section
// needs them.
//
// The denominator is DERIVED, never typed. A hardcoded "of 8" is right on the
// day it is written and wrong the first time someone adds a field, and the
// failure is silent — the header keeps saying 8 while the card shows 9 inputs.
// Every caller passes the values it actually renders and gets the count back.

export interface SectionFill {
  filled: number;
  total: number;
  /** 0..1. Zero when the section has no fields at all (rather than NaN). */
  fraction: number;
  complete: boolean;
}

/**
 * What counts as filled: anything that isn't null, undefined, an empty/blank
 * string, or an empty array. `false` and `0` COUNT — a seller who set "Free
 * shipping: no" or a price of 0 has answered the question, and treating a
 * deliberate falsy answer as unanswered is how a nag never goes away.
 */
export function isFilled(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Set || value instanceof Map) return value.size > 0;
  if (typeof value === "number") return Number.isFinite(value);
  return true;
}

/** Counts filled values in the order the section renders them. */
export function countFilled(values: readonly unknown[]): SectionFill {
  const total = values.length;
  let filled = 0;
  for (const v of values) if (isFilled(v)) filled += 1;
  return {
    filled,
    total,
    fraction: total === 0 ? 0 : filled / total,
    complete: total > 0 && filled === total,
  };
}

/**
 * Same count, restricted to the fields the caller marks required. Used where a
 * section mixes required and optional inputs and the badge should reflect what
 * actually blocks the seller, not how many boxes exist.
 */
export function countRequiredFilled(
  fields: readonly { value: unknown; required?: boolean }[],
): SectionFill {
  return countFilled(fields.filter((f) => f.required !== false).map((f) => f.value));
}

/** "6 of 8" — the string, so every header renders it the same way. */
export function fillLabel(fill: SectionFill): string {
  return `${fill.filled} of ${fill.total}`;
}
