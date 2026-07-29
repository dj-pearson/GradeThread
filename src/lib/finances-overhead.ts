import { supabase } from "@/lib/supabase";

// US-2226: the finances_dashboard RPC computes net_profit from per-item P&L
// (sale price minus acquisition, shipping, fees, grading). It does NOT know
// about operating expenses logged on the Expenses page (flipdesk_expenses),
// which are overhead not tied to a single item. That left two different profit
// numbers on the platform. These helpers pull the same overhead the Expenses
// page shows for a period and reconcile it into a single "true net" figure.

export interface OverheadExpenseRow {
  amount: number;
  spent_on: string; // YYYY-MM-DD
}

// The period boundary from finances.tsx is a full ISO timestamp (or null for
// all-time). flipdesk_expenses.spent_on is a date-only column, so compare on
// the date part. ISO date strings sort lexicographically, so a string >= is a
// correct date comparison here.
function periodBoundary(periodStartISO: string | null): string | null {
  return periodStartISO ? periodStartISO.slice(0, 10) : null;
}

// Pure, testable: sum expense amounts that fall on or after the period start.
// A null start means all-time (every row counts).
export function sumExpensesInPeriod(
  rows: OverheadExpenseRow[],
  periodStartISO: string | null,
): number {
  const boundary = periodBoundary(periodStartISO);
  return rows.reduce((sum, r) => {
    if (boundary && r.spent_on < boundary) return sum;
    return sum + (Number.isFinite(r.amount) ? r.amount : 0);
  }, 0);
}

// Pure, testable: net profit after subtracting operating overhead.
export function netAfterOverhead(netProfit: number, overhead: number): number {
  return netProfit - overhead;
}

// Fetch the operating-expense total for the period. RLS scopes flipdesk_expenses
// to the current user, so no explicit user filter is needed on the client.
export async function fetchOperatingExpensesTotal(
  periodStartISO: string | null,
): Promise<number> {
  const boundary = periodBoundary(periodStartISO);
  let query = supabase
    .from("flipdesk_expenses")
    .select("amount, spent_on");
  if (boundary) query = query.gte("spent_on", boundary);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return sumExpensesInPeriod((data ?? []) as OverheadExpenseRow[], periodStartISO);
}
