import { supabase } from "@/lib/supabase";
import type { ColumnMap, ParsedRow } from "@/lib/statement-import";

// US-2994 — the database half of the bank import.
//
// Kept separate from statement-import.ts so the parsing stays pure and
// testable. Everything here is a read or a write; nothing here decides
// anything.

export interface StatementSource {
  id: string;
  name: string;
  column_map: Partial<ColumnMap>;
}

export interface StatementRow {
  id: string;
  source_id: string;
  posted_on: string;
  amount_cents: number;
  description: string;
  status: "unreviewed" | "matched" | "ignored";
  matched_expense_id: string | null;
  ignored_reason: string | null;
}

export interface MatchCandidate {
  expense_id: string;
  description: string | null;
  amount: number;
  spent_on: string;
  day_gap: number;
  score: number;
}

export interface ImportSummary {
  source_id: string;
  total: number;
  matched: number;
  unreviewed: number;
  ignored: number;
  unreviewed_spend_cents: number;
  first_posted: string | null;
  last_posted: string | null;
}

type Rpc = {
  rpc: ((
    fn: "match_statement_row",
    args: { p_row_id: string },
  ) => Promise<{ data: MatchCandidate[] | null; error: { message: string } | null }>) &
    ((
      fn: "statement_import_summary",
      args: { p_source_id: string },
    ) => Promise<{ data: ImportSummary | null; error: { message: string } | null }>);
};

export async function fetchSources(): Promise<StatementSource[]> {
  const { data, error } = await supabase
    .from("statement_sources")
    .select("id, name, column_map")
    .order("name");
  if (error) throw error;
  return (data ?? []) as StatementSource[];
}

export async function saveSource(
  userId: string,
  name: string,
  columnMap: Partial<ColumnMap>,
  id?: string,
): Promise<string> {
  const { data, error } = await supabase
    .from("statement_sources")
    .upsert(
      { ...(id ? { id } : {}), user_id: userId, name, column_map: columnMap } as never,
      { onConflict: "user_id,name" },
    )
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

export interface ImportOutcome {
  inserted: number;
  /** Rows already present from a previous import of an overlapping range. */
  alreadyKnown: number;
}

/**
 * Write parsed rows, skipping ones already imported.
 *
 * AC3. The unique index on (user_id, source_id, row_fingerprint) is what makes
 * this safe, and `ignoreDuplicates` turns a re-import of an overlapping range
 * into a no-op rather than an error -- which is the normal case, because
 * sellers widen the range to catch something they missed.
 */
export async function importRows(
  userId: string,
  sourceId: string,
  rows: readonly ParsedRow[],
): Promise<ImportOutcome> {
  if (rows.length === 0) return { inserted: 0, alreadyKnown: 0 };
  const payload = rows.map((r) => ({
    user_id: userId,
    source_id: sourceId,
    posted_on: r.posted_on,
    amount_cents: r.amount_cents,
    description: r.description,
    row_fingerprint: r.row_fingerprint,
  }));
  const { data, error } = await supabase
    .from("statement_rows")
    .upsert(payload as never, {
      onConflict: "user_id,source_id,row_fingerprint",
      ignoreDuplicates: true,
    })
    .select("id");
  if (error) throw error;
  const inserted = (data ?? []).length;
  return { inserted, alreadyKnown: rows.length - inserted };
}

export async function fetchRows(
  sourceId: string,
  status?: StatementRow["status"],
): Promise<StatementRow[]> {
  let q = supabase
    .from("statement_rows")
    .select(
      "id, source_id, posted_on, amount_cents, description, status, matched_expense_id, ignored_reason",
    )
    .eq("source_id", sourceId)
    .order("posted_on", { ascending: false });
  if (status) q = q.eq("status", status);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as StatementRow[];
}

export async function fetchCandidates(rowId: string): Promise<MatchCandidate[]> {
  const client = supabase as unknown as Rpc;
  const { data, error } = await client.rpc("match_statement_row", {
    p_row_id: rowId,
  });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function fetchSummary(sourceId: string): Promise<ImportSummary> {
  const client = supabase as unknown as Rpc;
  const { data, error } = await client.rpc("statement_import_summary", {
    p_source_id: sourceId,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No summary returned");
  return data;
}

/**
 * Link a statement row to an expense.
 *
 * AC5/AC6: this writes to the STATEMENT ROW only. The expense is not touched,
 * not even to correct an amount that differs -- an import that rewrites a
 * figure the seller typed is how a bookkeeping tool silently disagrees with the
 * person using it, and the person always loses because they do not know.
 */
export async function linkRow(
  rowId: string,
  expenseId: string,
): Promise<void> {
  const { error } = await supabase
    .from("statement_rows")
    .update({
      matched_expense_id: expenseId,
      status: "matched",
      ignored_reason: null,
    } as never)
    .eq("id", rowId);
  if (error) throw error;
}

/** Undo a match. The link is reversible by design (AC5). */
export async function unlinkRow(rowId: string): Promise<void> {
  const { error } = await supabase
    .from("statement_rows")
    .update({
      matched_expense_id: null,
      status: "unreviewed",
    } as never)
    .eq("id", rowId);
  if (error) throw error;
}

export async function ignoreRow(
  rowId: string,
  reason: string,
): Promise<void> {
  const { error } = await supabase
    .from("statement_rows")
    .update({
      status: "ignored",
      matched_expense_id: null,
      ignored_reason: reason,
    } as never)
    .eq("id", rowId);
  if (error) throw error;
}

/**
 * Create an expense FROM a statement row, then link it.
 *
 * The two writes are not a transaction, and the order is chosen so a failure
 * between them is recoverable: the expense exists and the row stays
 * unreviewed, so the seller sees it again and can link it by hand. The other
 * order would leave a row pointing at nothing.
 */
export async function createExpenseFromRow(
  userId: string,
  row: StatementRow,
  category: string,
): Promise<string> {
  const { data, error } = await supabase
    .from("flipdesk_expenses")
    .insert({
      user_id: userId,
      category,
      description: row.description.slice(0, 300) || null,
      amount: Math.abs(row.amount_cents) / 100,
      spent_on: row.posted_on,
    } as never)
    .select("id")
    .single();
  if (error) throw error;
  const expenseId = (data as { id: string }).id;
  await linkRow(row.id, expenseId);
  return expenseId;
}
