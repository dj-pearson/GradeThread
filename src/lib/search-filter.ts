// PostgREST parses commas and parentheses as `.or()` SYNTAX, so a search term
// carrying one breaks the whole filter rather than matching nothing — the
// request 400s, or filters on something the user never typed. Strip them from
// the raw term; ilike still matches the rest.
//
// `*` goes too: it is PostgREST's wildcard, so a user typing one would be
// injecting a pattern instead of searching for a character.
//
// Lifted out of src/pages/admin/users.tsx (US-2544) when the seller Submissions
// list needed the identical guard. One copy, so a fix reaches both.
export function sanitizeSearch(value: string): string {
  return value.replace(/[,()*]/g, " ").trim();
}

/**
 * Inclusive end-of-day bound for an `<input type="date">` value.
 *
 * The naive `.lte("created_at", dateTo)` compares a timestamp against midnight,
 * so picking today as the end of a range excludes everything filed today.
 */
export function endOfDayIso(date: string): string {
  return `${date}T23:59:59.999Z`;
}
