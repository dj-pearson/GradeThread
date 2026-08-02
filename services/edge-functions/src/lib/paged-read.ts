// US-2387: the row-cap contract for edge (service-role) Supabase reads.
//
// The EDGE half of src/lib/paged-read.ts. The two files are a deliberate
// mirror: Deno and the SPA are separate projects that cannot import across each
// other, so the logic exists twice and paged-read-parity_test.ts asserts they
// agree. Keep them in lockstep.
//
// Why the edge needs it at all: PostgREST enforces `db-max-rows` on ANY
// response, and the service-role client is not exempt. When a request asks for
// more than the ceiling the server silently returns the ceiling and says so
// ONLY in the Content-Range header — supabase-js surfaces no error and no flag,
// so the caller gets a short array indistinguishable from a small result set.
// Nothing in this repo sets that value (see vault/10-ops/postgrest-row-cap.md,
// which measured no cap at or below 1055 rows on 2026-08-01 but could not prove
// the literal ceiling), so the safe posture is to assume a cap exists at an
// unknown height and never depend on knowing it.
//
// Two shapes, and every unbounded read in the KNOWN_UNBOUNDED register in
// growth-table-bounded-reads_test.ts should become one of them:
//
//   fetchAllPages — "I need the whole set." Walks until an EMPTY response.
//   fetchCapped   — "A cap is fine, but the caller must be told." Asks for one
//                   row past the cap so `truncated` is a fact, not a guess.
//
// The shape to avoid is a fixed `.limit(N)` rendered as if it were everything —
// on the edge that means a payout sweep, a reconciliation or an aggregate
// computed over a subset while reporting success.

/**
 * Rows per request. Sized to sit at Supabase's DEFAULT `db-max-rows` (1000).
 *
 * A comfort setting, NOT a correctness one: {@link fetchAllPages} advances by
 * the rows it actually received, so a server cap anywhere below this only costs
 * extra round trips. That independence is the point — the web loops this
 * mirrors advanced by the page size and stopped on a short page, which
 * truncated silently the moment the real cap was smaller than the page. That
 * bug shipped twice on the web side before it was understood.
 */
export const READ_PAGE_SIZE = 1000;

/**
 * The `db-max-rows` value we assume prod runs with, until an operator confirms
 * the real one. Kept equal to the web constant of the same name.
 */
export const ASSUMED_DB_MAX_ROWS = 1000;

/**
 * How many rows a capped surface reads. Deliberately well under
 * {@link ASSUMED_DB_MAX_ROWS} so the `+1` probe is always answerable even if
 * the real ceiling is somewhat lower than assumed.
 */
export const CAPPED_READ_LIMIT = 500;

/**
 * Read an entire result set in bounded requests.
 *
 * `page(from, to)` runs one inclusive-range request and returns its rows; it
 * should THROW on error rather than returning `[]`, because a swallowed error
 * here is indistinguishable from the end of the data — and on the edge that
 * means a sweep quietly deciding there is no work.
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
  for (let from = 0;;) {
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
 * `read(limit)` must apply the limit it is handed — this asks for `limit + 1`
 * and treats the extra row as the evidence. The extra row is dropped, so the
 * caller processes exactly `limit` and can report "handled the first N".
 *
 * The parameter is `read`, not `fetch` as on the web side: no-bare-fetch_test.ts
 * scans the edge for bare `fetch(` calls, and a parameter of that name reads as
 * one. Renaming is the honest fix — adding this file to that guard's allowlist
 * would have spent a real safety check to keep a variable name.
 */
export async function fetchCapped<T>(
  read: (limit: number) => Promise<T[]>,
  limit: number = CAPPED_READ_LIMIT,
): Promise<CappedRead<T>> {
  const rows = await read(limit + 1);
  const truncated = rows.length > limit;
  return { rows: truncated ? rows.slice(0, limit) : rows, truncated, limit };
}
