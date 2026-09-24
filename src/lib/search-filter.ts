// PostgREST parses commas and parentheses as `.or()` SYNTAX, so a search term
// carrying one breaks the whole filter rather than matching nothing: the
// request 400s, or filters on something the user never typed. Strip them from
// the raw term; ilike still matches the rest.
//
// `*` goes too: it is PostgREST's wildcard, so a user typing one would be
// injecting a pattern instead of searching for a character.
//
// SUB-08: `%` and `_` are LIKE's own wildcards, so "levi_s" matched "levis",
// "levi s" and "levi-s", and "50%" matched anything starting with 50. They are
// backslash-escaped (LIKE's default escape), with the backslash itself escaped
// first. A double quote is PostgREST's value-quoting character inside `.or()`,
// and a stray one made the whole list fail to load, so it is stripped.
//
// Lifted out of src/pages/admin/users.tsx (US-2544) when the seller Submissions
// list needed the identical guard. One copy, so a fix reaches both.
export function sanitizeSearch(value: string): string {
  return value
    .replace(/[,()*"]/g, " ")
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/[%_]/g, (c) => `\\${c}`);
}

/**
 * `created_at` bounds for an inclusive range of the seller's LOCAL calendar
 * days, from two `<input type="date">` values.
 *
 * SUB-08: the old end bound was `${date}T23:59:59.999Z`, a UTC day, while the
 * rows display local dates. In Los Angeles a submission filed at 6pm on
 * Sep 30 is Oct 1 in UTC, so it fell outside a Sep 30 to Sep 30 range that
 * listed it as Sep 30. Both bounds are now local midnights: `gte` the start of
 * `from`, `lt` the start of the day after `to`.
 */
export function localDayRangeIso(
  from: string,
  to: string,
): { gte?: string; lt?: string } {
  const out: { gte?: string; lt?: string } = {};
  if (from) out.gte = new Date(`${from}T00:00:00`).toISOString();
  if (to) {
    const next = new Date(`${to}T00:00:00`);
    next.setDate(next.getDate() + 1);
    out.lt = next.toISOString();
  }
  return out;
}
