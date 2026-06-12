// Row-count-checked writes for service-role edge handlers (US-474).
//
// The edge service talks to Supabase with the SERVICE-ROLE client, which
// bypasses RLS — so an `update().eq("id", …)` that matches no row succeeds
// silently with `error === null` and `data === null`. Admin grade corrections
// and dispute resolutions used to run as BROWSER Supabase calls that no-oped
// under RLS yet reported success; moving them to the edge fixes the RLS no-op,
// and this helper closes the remaining gap: a write whose id no longer matches
// (deleted/renamed row, wrong id) must surface a REAL error, not a false
// "saved". Every mutating admin write that targets a single row by id should go
// through updateByIdChecked so 0 affected rows throws instead of lying.

// Minimal structural shape of the supabase-js update→eq→select chain. Kept
// loose (not the full PostgrestFilterBuilder type) so tests can inject a tiny
// in-memory fake without dragging in the whole client.
export interface CheckedUpdateClient {
  from(table: string): {
    update(values: Record<string, unknown>): {
      eq(column: string, value: string): {
        select(columns: string): PromiseLike<{
          data: Array<{ id: string }> | null;
          error: { message?: string } | null;
        }>;
      };
    };
  };
}

/** Thrown when a by-id update matched no rows (the row vanished or the id is wrong). */
export class ZeroRowsAffectedError extends Error {
  constructor(public readonly table: string, public readonly id: string) {
    super(`Update affected 0 rows on ${table} (id=${id})`);
    this.name = "ZeroRowsAffectedError";
  }
}

/**
 * Update a single row by id and VERIFY a row actually changed.
 *
 * Uses `.select("id")` so the affected rows come back (the service-role client
 * returns `data: null` for an update that matched nothing). Throws on a DB
 * error or when 0 rows were affected, so callers can return a real failure
 * instead of a false success.
 */
export async function updateByIdChecked(
  db: CheckedUpdateClient,
  table: string,
  id: string,
  values: Record<string, unknown>,
  idColumn = "id",
): Promise<Array<{ id: string }>> {
  const { data, error } = await db
    .from(table)
    .update(values)
    .eq(idColumn, id)
    .select("id");
  if (error) {
    throw new Error(error.message ?? `Failed to update ${table}`);
  }
  if (!data || data.length === 0) {
    throw new ZeroRowsAffectedError(table, id);
  }
  return data;
}
