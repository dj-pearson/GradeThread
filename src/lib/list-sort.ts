// US-1651: prod-safe global sort helpers for the submissions & inventory lists.
//
// The submissions "sort by grade" case sorts by a column in a DIFFERENT table
// (grade_reports.overall_score), so a single paged query can only reorder the
// page in view. PostgREST *can* order a parent by an embedded child column, but
// CLAUDE.md warns local/prod PostgREST diverge on some embedded-resource
// behaviour — and here the embed is a FILTERED one-to-many (only the active,
// non-superseded report), exactly the version-sensitive case.
//
// FALLBACK CHOSEN (AC4): instead of a version-sensitive embedded `.order`, the
// page fetches the full id set (cheap: id + status), resolves the active scores,
// and orders the id list HERE with this pure helper — using only bedrock
// supabase-js features (select / .in / .order on a real column / .range). That is
// prod-safe by construction, so no prod-PostgREST verification gate is needed.
//
// PURE + unit-tested. Nulls (no grade yet) ALWAYS sort last, regardless of
// direction, and ties break by id so pagination is deterministic across fetches.

export type SortDirection = "asc" | "desc";

// Order ids by a numeric score map (missing/undefined = "no grade" → last).
// Deterministic: within-score ties break by id (stable across page fetches).
export function orderIdsByScore(
  ids: readonly string[],
  scoreById: Readonly<Record<string, number | null | undefined>>,
  direction: SortDirection,
): string[] {
  const dir = direction === "asc" ? 1 : -1;
  return [...ids].sort((a, b) => {
    const sa = scoreById[a];
    const sb = scoreById[b];
    const aNull = sa === null || sa === undefined;
    const bNull = sb === null || sb === undefined;
    // Nulls last in BOTH directions.
    if (aNull && bNull) return a < b ? -1 : a > b ? 1 : 0;
    if (aNull) return 1;
    if (bNull) return -1;
    if (sa !== sb) return (sa - sb) * dir;
    return a < b ? -1 : a > b ? 1 : 0; // stable tiebreak
  });
}

// Slice the ordered id list to a page window (bounds-safe).
export function pageSlice<T>(ordered: readonly T[], page: number, pageSize: number): T[] {
  const start = Math.max(0, page) * pageSize;
  return ordered.slice(start, start + pageSize);
}

// Re-materialize fetched rows into a target id order (a `.in()` fetch does not
// preserve order). Rows missing from `byId` are skipped (defensive).
export function reorderByIds<T>(orderedIds: readonly string[], byId: ReadonlyMap<string, T>): T[] {
  const out: T[] = [];
  for (const id of orderedIds) {
    const row = byId.get(id);
    if (row !== undefined) out.push(row);
  }
  return out;
}
