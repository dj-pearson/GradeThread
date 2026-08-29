import { supabase } from "@/lib/supabase";
import { fiscalYearLabel, fiscalYearStart, ymd } from "@/lib/tax-profile";

// US-2986 — cost of goods sold, and the ending-inventory number Schedule C
// Part III asks for that nothing in this app could produce.
//
// The valuation lives in the database (migration 00688). This file is the read
// side plus the backfill, which is client-driven because it needs the seller's
// fiscal year and their business start date, both of which live in the tax
// profile rather than in the snapshot table.

export interface CogsWorksheet {
  from: string;
  to: string;
  line_35_beginning_cents: number;
  line_35_present: boolean;
  line_35_reconstructed: boolean;
  line_36_purchases_cents: number;
  line_41_ending_cents: number;
  line_41_present: boolean;
  line_41_reconstructed: boolean;
  line_42_cogs_cents: number;
  /** What the ledger says the sold items cost, by a completely different route. */
  sold_cost_basis_cents: number;
  sold_item_count: number;
  /** Worksheet COGS minus the ledger figure. Non-zero means they disagree. */
  variance_cents: number;
  items_without_cost: {
    beginning: number;
    purchases: number;
    ending: number;
  };
  purchase_item_count: number;
}

export interface InventorySnapshot {
  id: string;
  as_of: string;
  fiscal_label: string;
  total_cost_cents: number;
  item_count: number;
  items_without_cost: number;
  reconstructed: boolean;
  created_at: string;
}

export interface ItemMissingCostBasis {
  item_id: string;
  title: string | null;
  sale_date: string;
  sale_price_cents: number;
}

type CogsRpcClient = {
  rpc: ((
    fn: "cogs_worksheet",
    args: { p_from: string; p_to: string },
  ) => Promise<{ data: CogsWorksheet | null; error: { message: string } | null }>) &
    ((
      fn: "items_missing_cost_basis",
      args: { p_from: string; p_to: string },
    ) => Promise<{
      data: ItemMissingCostBasis[] | null;
      error: { message: string } | null;
    }>) &
    ((
      fn: "take_my_inventory_snapshot",
      args: {
        p_as_of: string;
        p_fiscal_label: string;
        p_reconstructed: boolean;
      },
    ) => Promise<{ data: string | null; error: { message: string } | null }>);
};

export async function fetchCogsWorksheet(
  from: string,
  to: string,
): Promise<CogsWorksheet> {
  const client = supabase as unknown as CogsRpcClient;
  const { data, error } = await client.rpc("cogs_worksheet", {
    p_from: from,
    p_to: to,
  });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No COGS worksheet returned");
  return data;
}

export async function fetchItemsMissingCostBasis(
  from: string,
  to: string,
): Promise<ItemMissingCostBasis[]> {
  const client = supabase as unknown as CogsRpcClient;
  const { data, error } = await client.rpc("items_missing_cost_basis", {
    p_from: from,
    p_to: to,
  });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function fetchSnapshots(): Promise<InventorySnapshot[]> {
  const { data, error } = await supabase
    .from("inventory_snapshots")
    .select(
      "id, as_of, fiscal_label, total_cost_cents, item_count, items_without_cost, reconstructed, created_at",
    )
    .order("as_of", { ascending: false });
  if (error) throw error;
  return (data ?? []) as InventorySnapshot[];
}

export async function takeSnapshot(
  asOf: string,
  fiscalLabel: string,
  reconstructed: boolean,
): Promise<string> {
  const client = supabase as unknown as CogsRpcClient;
  const { data, error } = await client.rpc("take_my_inventory_snapshot", {
    p_as_of: asOf,
    p_fiscal_label: fiscalLabel,
    p_reconstructed: reconstructed,
  });
  if (error) throw new Error(error.message);
  return data ?? "";
}

/**
 * The year boundaries a seller needs a snapshot at, oldest first.
 *
 * One per fiscal year start from the year they began selling through the
 * current year's start, plus the NEXT year's start, which is this year's
 * ending inventory. Half-open ranges mean a boundary is both one year's ending
 * and the next year's beginning, so a single snapshot serves both -- which is
 * the whole reason `as_of` is exclusive.
 *
 * Pure, so the list is testable without a database.
 */
export function snapshotBoundaries(
  startMonth: number,
  businessStartedOn: string | null,
  now: Date,
): { asOf: string; label: string }[] {
  const currentStart = fiscalYearStart(now, startMonth);
  // Without a start date, go back three years. Far enough to cover the returns
  // a seller might still amend, short enough that the backfill is not a
  // decade of empty snapshots.
  const firstYear = businessStartedOn
    ? fiscalYearStart(
        new Date(
          Number(businessStartedOn.slice(0, 4)),
          Number(businessStartedOn.slice(5, 7)) - 1,
          Number(businessStartedOn.slice(8, 10)),
        ),
        startMonth,
      )
    : new Date(
        currentStart.getFullYear() - 3,
        currentStart.getMonth(),
        1,
      );

  const out: { asOf: string; label: string }[] = [];
  const cursor = new Date(firstYear);
  // Bounded: a corrupt start date must not spin here. Fifty years is more
  // history than any reseller has and far less than an infinite loop.
  for (let i = 0; i < 50; i++) {
    if (cursor.getTime() > currentStart.getTime()) break;
    out.push({
      asOf: ymd(cursor),
      label: fiscalYearLabel(cursor, startMonth),
    });
    cursor.setFullYear(cursor.getFullYear() + 1);
  }
  // The current year's END, which is next year's start. Without it the seller
  // has a beginning inventory and no ending one, which is half a Part III.
  const nextStart = new Date(currentStart);
  nextStart.setFullYear(nextStart.getFullYear() + 1);
  out.push({
    asOf: ymd(nextStart),
    label: fiscalYearLabel(nextStart, startMonth),
  });
  return out;
}

/**
 * Create a snapshot at every boundary that has none.
 *
 * Every one it creates is marked `reconstructed`, because it is: rebuilt after
 * the fact from whatever data survived, rather than recorded at the time. The
 * distinction is the difference between a record and an estimate, and the tax
 * packet prints it rather than letting an accountant assume the former.
 *
 * Boundaries that already have a snapshot are left alone. Re-taking one is a
 * deliberate act, not a side effect of pressing backfill.
 */
export async function backfillSnapshots(
  startMonth: number,
  businessStartedOn: string | null,
  now: Date,
): Promise<{ created: number; skipped: number }> {
  const existing = new Set((await fetchSnapshots()).map((s) => s.as_of));
  const boundaries = snapshotBoundaries(startMonth, businessStartedOn, now);
  let created = 0;
  let skipped = 0;
  for (const b of boundaries) {
    if (existing.has(b.asOf)) {
      skipped++;
      continue;
    }
    await takeSnapshot(b.asOf, b.label, true);
    created++;
  }
  return { created, skipped };
}

/**
 * What the worksheet is worth, in one word.
 *
 * `variance` and `missing_cost` are DIFFERENT problems and the screen has to
 * say which, because the fix differs: a variance means an item is in one route
 * and not the other, usually a wrong acquisition date; a missing cost means an
 * item was valued at zero, which understates inventory and overstates the
 * deduction. The variance CANNOT catch the second -- both routes read the same
 * acquired_price column, so a null cancels on both sides. Proven on Postgres in
 * scripts/check-cogs-worksheet.mjs.
 */
export type CogsConfidence = "ok" | "missing_cost" | "variance" | "no_snapshot";

export function cogsConfidence(w: CogsWorksheet): CogsConfidence {
  if (!w.line_35_present || !w.line_41_present) return "no_snapshot";
  if (w.variance_cents !== 0) return "variance";
  const nulls =
    w.items_without_cost.beginning +
    w.items_without_cost.purchases +
    w.items_without_cost.ending;
  if (nulls > 0) return "missing_cost";
  return "ok";
}
