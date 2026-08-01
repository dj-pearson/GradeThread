// US-2169: the row-cap contract for every client-side Supabase read.
//
// PostgREST enforces a `db-max-rows` ceiling on ANY response. When a request
// asks for more than the ceiling, the server silently returns the ceiling and
// says so ONLY in the Content-Range header — supabase-js exposes no error and
// no flag, so the caller receives a short array that is indistinguishable from
// a small result set. Nothing in this repo sets or asserts that value (see
// vault/10-ops/postgrest-row-cap.md), so the safe posture is to assume a cap
// exists, at an unknown height, and never to depend on knowing it.
//
// Two shapes follow from that, and every read should be one of them:
//
//   fetchAllPages — "I need the whole set." Walks until an EMPTY response.
//   fetchCapped   — "A cap is fine, but the seller must be told." Asks for one
//                   row past the cap so `truncated` is a fact, not a guess.
//
// The shape to avoid is the third one: a fixed `.limit(N)` whose result is
// rendered as if it were everything. That is what makes a seller price, relist
// or source against a catalog they cannot tell is incomplete.

/**
 * Rows per request. Sized to sit at Supabase's DEFAULT `db-max-rows` (1000).
 *
 * This is a comfort setting, NOT a correctness one: {@link fetchAllPages}
 * advances by the rows it actually received, so a server cap anywhere below
 * this only costs extra round trips. That independence is the point — the
 * previous loops advanced by the page size and stopped on a short page, which
 * silently truncated the moment the real cap was smaller than the page.
 */
export const READ_PAGE_SIZE = 1000;

/**
 * The `db-max-rows` value we assume prod runs with, until an operator confirms
 * the real one (vault/10-ops/postgrest-row-cap.md). Supabase ships 1000 as the
 * default "Max rows" API setting, self-hosted included.
 *
 * Used only to keep {@link CAPPED_READ_LIMIT} answerable: a capped read asks for
 * `limit + 1` rows, and if that number exceeds the server ceiling the server
 * clips it and the read can no longer tell "exactly at the cap" from "more
 * exists". A guard test asserts the two stay in that relationship.
 */
export const ASSUMED_DB_MAX_ROWS = 1000;

/**
 * How many rows a capped queue surface shows. Deliberately well under
 * {@link ASSUMED_DB_MAX_ROWS} so the `+1` probe is always answerable, even if
 * the real ceiling is somewhat lower than assumed.
 */
export const CAPPED_READ_LIMIT = 500;

/**
 * Read an entire result set in bounded requests.
 *
 * `page(from, to)` runs one inclusive-range request and returns its rows; it
 * should throw on error rather than returning `[]`, because a swallowed error
 * here is indistinguishable from the end of the data.
 *
 * Stops only on an EMPTY response. A short-but-non-empty page can mean the end
 * OR a server cap, and there is no way to tell them apart from the client — so
 * this pays one confirming empty request rather than guessing. That round trip
 * is the whole cost of never truncating silently.
 */
export async function fetchAllPages<T>(
  page: (from: number, to: number) => Promise<T[]>,
  pageSize: number = READ_PAGE_SIZE,
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; ) {
    const batch = await page(from, from + pageSize - 1);
    if (batch.length === 0) break;
    all.push(...batch);
    // Advance by what ARRIVED, never by pageSize. This is the line that makes
    // the loop independent of the server's ceiling.
    from += batch.length;
  }
  return all;
}

export interface CappedRead<T> {
  readonly rows: T[];
  /** True when the source had MORE rows than `limit`. A fact, not a guess. */
  readonly truncated: boolean;
  readonly limit: number;
}

/**
 * Read at most `limit` rows and report honestly whether more exist.
 *
 * `fetch(limit)` must apply the limit it is handed — this asks for `limit + 1`
 * and treats the extra row as the evidence. The extra row is dropped, so the
 * caller renders exactly `limit` and can say "showing the first N".
 */
export async function fetchCapped<T>(
  fetch: (limit: number) => Promise<T[]>,
  limit: number = CAPPED_READ_LIMIT,
): Promise<CappedRead<T>> {
  const rows = await fetch(limit + 1);
  const truncated = rows.length > limit;
  return { rows: truncated ? rows.slice(0, limit) : rows, truncated, limit };
}
