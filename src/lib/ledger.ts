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
 * Every react-query key whose data is read out of ledger_entries. A rebuild
 * changes all of them, so invalidating only the screen that pressed the button
 * leaves the others showing the old books for their whole staleTime.
 */
export const LEDGER_QUERY_KEYS = [
  "pnl-entries",
  "money-overview-ledger",
  "money-overview-calendar",
  "estimated-tax-entries",
  "ledger-reconciliation",
] as const;

type QueryInvalidator = {
  invalidateQueries: (filters: { queryKey: readonly unknown[] }) => Promise<unknown>;
};

/** Mark every ledger-derived query stale. Call after rebuildMyLedger(). */
export async function invalidateLedgerQueries(qc: QueryInvalidator): Promise<void> {
  await Promise.all(
    LEDGER_QUERY_KEYS.map((key) => qc.invalidateQueries({ queryKey: [key] })),
  );
}

/**
 * Seller-owned tables rebuild_ledger_for_user (00777) derives entries from,
 * each with a trigger-maintained updated_at and a user_id to scope by. Two more
 * inputs are read through their sale in newestLedgerSourceChange: shipments
 * (no user_id) and inventory_items (acquired_price is the COGS line, and a
 * seller often types the cost in after the item sells). mileage_rates is left
 * out: it is a shared rate table, not a seller's row. listings.platform (which
 * sales-tax branch applies) is also an input and is not watched.
 */
const LEDGER_SOURCE_TABLES = [
  "sales",
  "flipdesk_expenses",
  "mileage_trips",
  "home_office_years",
  "ebay_payouts",
] as const;

// A narrowly-typed view for the freshness reads. ebay_payouts is missing from
// the generated types, and a loop over table names defeats the typed builder.
type StampRow = { updated_at?: string | null; created_at?: string | null };
type NewestRowResult = PromiseLike<{
  data: StampRow[] | null;
  error: { message: string } | null;
}>;
type NewestRowQuery = {
  eq: (col: string, v: string) => NewestRowQuery;
  neq: (col: string, v: string) => NewestRowQuery;
  order: (col: string, opts: { ascending: boolean }) => NewestRowQuery;
  limit: (n: number) => NewestRowResult;
};
type FreshnessClient = {
  from: (table: string) => { select: (cols: string) => NewestRowQuery };
};

function newestStamp(rows: StampRow[] | null, col: keyof StampRow): number | null {
  const v = rows?.[0]?.[col];
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/**
 * When this seller's ledger inputs last changed, as epoch ms, or null when
 * they have none. Scoped to the seller's own rows on purpose: RLS also lets a
 * workspace member read the owner's sales, and the ledger is per user, so
 * counting the owner's edits would mark a member's ledger stale on every visit.
 */
async function newestLedgerSourceChange(userId: string): Promise<number | null> {
  const client = supabase as unknown as FreshnessClient;
  const reads: NewestRowResult[] = LEDGER_SOURCE_TABLES.map((table) =>
    client
      .from(table)
      .select("updated_at")
      .eq("user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(1),
  );
  // A shipment belongs to a seller through its sale.
  reads.push(
    client
      .from("shipments")
      .select("updated_at, sales!inner(user_id)")
      .eq("sales.user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(1),
  );
  // An item's cost becomes the sale's COGS entry. Read through the sale so a
  // cost edit on a sold item counts, and edits to unsold items do not.
  reads.push(
    client
      .from("inventory_items")
      .select("updated_at, sales!inner(user_id)")
      .eq("sales.user_id", userId)
      .order("updated_at", { ascending: false })
      .limit(1),
  );
  let newest: number | null = null;
  for (const { data, error } of await Promise.all(reads)) {
    if (error) throw new Error(error.message);
    const t = newestStamp(data, "updated_at");
    if (t !== null && (newest === null || t > newest)) newest = t;
  }
  return newest;
}

/**
 * Make sure the ledger is built and not older than the rows it derives from.
 *
 * Rebuilds when the ledger is EMPTY, or when any sale, expense, trip, home
 * office year, shipment, payout or sold item changed after the last build. The last build
 * is the newest derived entry's created_at: rebuild_ledger_for_user deletes and
 * re-inserts every non-adjustment row, so that stamp is the build time.
 * Adjustments are left out because a seller adds them by hand between builds.
 *
 * A deleted source row bumps no updated_at, so a deletion on its own is not
 * seen here; the P&L rebuild button still covers it.
 *
 * Concurrent callers share one check. The Money overview mounts two ledger
 * queries at once, and two overlapping rebuilds can collide on the
 * natural-key index when the second re-inserts rows the first just wrote.
 */
export function ensureLedgerBuilt(): Promise<number> {
  if (!ensureInFlight) {
    ensureInFlight = ensureLedgerBuiltOnce().finally(() => {
      ensureInFlight = null;
    });
  }
  return ensureInFlight;
}

let ensureInFlight: Promise<number> | null = null;

async function ensureLedgerBuiltOnce(): Promise<number> {
  const { count, error } = await supabase
    .from("ledger_entries")
    .select("id", { count: "exact", head: true });
  if (error) throw error;
  if ((count ?? 0) === 0) return rebuildMyLedger();

  const { data: auth } = await supabase.auth.getSession();
  const userId = auth.session?.user.id;
  if (!userId) return count ?? 0;

  const client = supabase as unknown as FreshnessClient;
  const [built, changed] = await Promise.all([
    client
      .from("ledger_entries")
      .select("created_at")
      .eq("user_id", userId)
      .neq("source_kind", "adjustment")
      .order("created_at", { ascending: false })
      .limit(1),
    newestLedgerSourceChange(userId),
  ]);
  if (built.error) throw new Error(built.error.message);
  const builtAt = newestStamp(built.data, "created_at");

  if (changed === null) return count ?? 0;
  if (builtAt !== null && changed <= builtAt) return count ?? 0;
  return rebuildMyLedger();
}

/** The account behind an entry, preferring the joined row and falling back to the mirror. */
export function entryAccount(row: LedgerEntryRow): LedgerAccount | undefined {
  return row.ledger_accounts ? accountByCode(row.ledger_accounts.code) : undefined;
}
