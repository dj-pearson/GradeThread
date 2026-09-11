// US-3375: the pre-publish check has THREE answers, not two.
//
// The bulk editor used to read the response body of
// /api/flipdesk/ebay/listings/validate and never the status line. edgeFetch
// resolves a non-2xx like any other response (its own header says so), and an
// error body carries `{ error }` and no `blockers` array, so a 500, a 429 or a
// 403 produced an empty blockers list. An empty list reads as "nothing wrong":
// the row counted as clean, the toast said "40 clean, 0 blocked", and the row
// state was overwritten with that empty array, deleting the blockers a previous
// good run had found. The seller then bulk-published drafts eBay rejects.
//
// So the outcome is `clean`, `blocked`, or `unchecked`, and `unchecked` is
// load-bearing in all three places the verdict shows up: the row, the counter
// and the toast. The one rule that matters most: an `unchecked` result NEVER
// writes to `validationBlockers`. Losing the evidence is worse than showing it
// one run stale.
//
// Lives here rather than in autolister-bulk-edit.tsx because that file sits on
// the shrink-only ceiling in src/test/autolister-split.test.ts, and because a
// verdict this easy to get wrong should be drivable by a test on its own.

export const VALIDATE_PATH = "/api/flipdesk/ebay/listings/validate";

export type ValidationOutcome = "clean" | "blocked" | "unchecked";

export interface RowValidation {
  id: string;
  outcome: ValidationOutcome;
  /** The server's blockers. Null when the check did not complete. */
  blockers: string[] | null;
  /** Why we could not tell. Null when the check did complete. */
  reason: string | null;
}

/** The shape edgeFetch satisfies, narrowed to what this module asks of it. */
type EdgeFetchLike = (
  path: string,
  opts: { method: string; json: unknown },
) => Promise<Response>;

/** The row fields the verdict writes to. `EditRow` satisfies it. */
export interface ValidatableRow {
  id: string;
  validationBlockers: string[] | null;
  validationUnchecked: string | null;
}

export interface ValidationTally {
  clean: number;
  blocked: number;
  unchecked: number;
}

function unchecked(id: string, reason: string): RowValidation {
  return { id, outcome: "unchecked", blockers: null, reason };
}

/**
 * Ask the edge whether one draft can publish. Never throws: a request that did
 * not produce a verdict comes back as `unchecked` with the reason.
 */
export async function validateOneRow(
  edgeFetchFn: EdgeFetchLike,
  row: { id: string; itemId: string },
): Promise<RowValidation> {
  let res: Response;
  try {
    res = await edgeFetchFn(VALIDATE_PATH, {
      method: "POST",
      json: { inventory_item_id: row.itemId },
    });
  } catch (err) {
    return unchecked(
      row.id,
      err instanceof Error ? err.message : "the request never reached the server",
    );
  }

  const json = (await res.json().catch(() => ({}))) as {
    blockers?: unknown;
    error?: unknown;
  };

  if (!res.ok) {
    const detail = typeof json.error === "string" ? json.error.trim() : "";
    return unchecked(
      row.id,
      detail
        ? `the server answered ${res.status} (${detail})`
        : `the server answered ${res.status}`,
    );
  }
  // A 2xx that carries no blockers array is also a non-answer. Treating a
  // missing field as an empty list is the same mistake one step along.
  if (!Array.isArray(json.blockers)) {
    return unchecked(row.id, "the server sent no verdict");
  }

  const blockers = json.blockers.filter(
    (b): b is string => typeof b === "string" && b.trim().length > 0,
  );
  return {
    id: row.id,
    outcome: blockers.length === 0 ? "clean" : "blocked",
    blockers,
    reason: null,
  };
}

/**
 * Fold a round of results into the rows. An `unchecked` result updates only the
 * "could not be checked" note and leaves `validationBlockers` exactly as it was.
 */
export function applyValidation<T extends ValidatableRow>(
  rows: T[],
  results: readonly RowValidation[],
): T[] {
  return rows.map((r) => {
    const hit = results.find((x) => x.id === r.id);
    if (!hit) return r;
    if (hit.outcome === "unchecked") {
      return { ...r, validationUnchecked: hit.reason };
    }
    return { ...r, validationBlockers: hit.blockers, validationUnchecked: null };
  });
}

/** Add a round of results to a running tally. */
export function tally(
  into: ValidationTally,
  results: readonly RowValidation[],
): ValidationTally {
  for (const r of results) into[r.outcome] += 1;
  return into;
}

export function emptyTally(): ValidationTally {
  return { clean: 0, blocked: 0, unchecked: 0 };
}

/**
 * What the seller is told. A run with anything unchecked is NOT a success: the
 * whole defect was a green sentence over a check that never happened.
 */
export function validationSummary(
  total: number,
  counts: ValidationTally,
): { level: "success" | "warning"; message: string } {
  const parts = [`${counts.clean} clean`, `${counts.blocked} blocked`];
  if (counts.unchecked > 0) {
    parts.push(`${counts.unchecked} could not be checked`);
  }
  return {
    level: counts.unchecked > 0 ? "warning" : "success",
    message: `Validated ${total}: ${parts.join(", ")}.`,
  };
}
