import { supabase } from "@/lib/supabase";
import { accountByCode, type LedgerAccount } from "@/lib/chart-of-accounts";

// US-2984 — reading the ledger from the client.
//
// The derivation lives in Postgres (rebuild_ledger_for_user, migration 00685).
// The browser never writes a derived entry: the only INSERT policy on
// ledger_entries covers `source_kind = 'adjustment'`, so a seller cannot
// hand-author a sale entry and inflate the very number their 1099-K
// reconciliation is meant to check.

export interface LedgerEntryRow {
  id: string;
  entry_date: string;
  amount_cents: number;
  currency: string;
  memo: string | null;
  source_kind: string;
  source_id: string | null;
  source_detail: string;
  ledger_accounts: {
    code: string;
    name: string;
    flow: string;
    schedule_c_line: string | null;
  } | null;
}

export interface LedgerReconciliation {
  dashboard_net_cents: number;
  ledger_sale_net_cents: number;
  variance_cents: number;
  agrees: boolean;
  overhead_cents: number;
  true_net_cents: number;
  excluded_cents: number;
  entry_count: number;
}

// Neither RPC is in the generated Database types, so both go through a
// narrowly-typed view of the client -- the same pattern finances-dashboard.ts
// uses for finances_dashboard and finances_export.
type LedgerRpcClient = {
  rpc: ((
    fn: "rebuild_my_ledger",
  ) => Promise<{ data: number | null; error: { message: string } | null }>) &
    ((
      fn: "ledger_reconciliation",
      args: { p_period_start: string | null },
    ) => Promise<{
      data: LedgerReconciliation | null;
      error: { message: string } | null;
    }>);
};

/**
 * Re-derive this seller's ledger from their sales, expenses and payouts.
 *
 * Safe to call as often as you like: the derived rows are replaced wholesale
 * and the natural-key index refuses a duplicate, so a re-run produces the same
 * rows rather than doubling anything. Hand-entered adjustments are never
 * touched -- they are the correction mechanism, and a rebuild that erased them
 * would erase the only record of why a number moved.
 *
 * Returns the resulting entry count.
 */
export async function rebuildMyLedger(): Promise<number> {
  const client = supabase as unknown as LedgerRpcClient;
  const { data, error } = await client.rpc("rebuild_my_ledger");
  if (error) throw new Error(error.message);
  return data ?? 0;
}

/** Entries in a date range, newest first. Half-open on `to`, like every range here. */
export async function fetchLedgerEntries(
  from: string | null,
  to: string | null,
): Promise<LedgerEntryRow[]> {
  let q = supabase
    .from("ledger_entries")
    .select(
      "id, entry_date, amount_cents, currency, memo, source_kind, source_id, source_detail, ledger_accounts(code, name, flow, schedule_c_line)",
    )
    .order("entry_date", { ascending: false })
    .order("created_at", { ascending: false });
  if (from) q = q.gte("entry_date", from);
  if (to) q = q.lt("entry_date", to);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as LedgerEntryRow[];
}

/**
 * The ledger against finances_dashboard for one period.
 *
 * `agrees: false` means the LEDGER is wrong. The dashboard is the behaviour
 * sellers have been reading for months, so it is the one with standing.
 */
export async function fetchLedgerReconciliation(
  periodStart: string | null,
): Promise<LedgerReconciliation> {
  const client = supabase as unknown as LedgerRpcClient;
  const { data, error } = await client.rpc("ledger_reconciliation", {
    p_period_start: periodStart,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No reconciliation returned");
  return data;
}

/**
 * Make sure the ledger has been built at least once.
 *
 * Called before a books screen renders. It rebuilds only when the ledger is
 * EMPTY, so opening the P&L does not fire a full re-derivation on every visit;
 * a seller who wants a refresh after editing a sale presses the control for it.
 */
export async function ensureLedgerBuilt(): Promise<number> {
  const { count, error } = await supabase
    .from("ledger_entries")
    .select("id", { count: "exact", head: true });
  if (error) throw error;
  if ((count ?? 0) > 0) return count ?? 0;
  return rebuildMyLedger();
}

/** The account behind an entry, preferring the joined row and falling back to the mirror. */
export function entryAccount(row: LedgerEntryRow): LedgerAccount | undefined {
  return row.ledger_accounts ? accountByCode(row.ledger_accounts.code) : undefined;
}
