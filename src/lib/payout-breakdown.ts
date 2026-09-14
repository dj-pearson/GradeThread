import { supabase } from "@/lib/supabase";
import type { SalePnlRow } from "@/types/database";
import { sourcerKey, sourcerLabel } from "@/lib/team-reporting";

// US-3413 — what one eBay deposit actually paid, item by item and person by
// person.
//
// Money comes from public.sale_pnl and nowhere else, the same rule
// team-reporting.ts states and for the same reason: the per-sale net already
// exists in finances_dashboard and the ledger, and a third derivation is a
// report that quietly contradicts the P&L. Nothing here recomputes net.
//
// Read directly through the Supabase client rather than an edge route. sale_pnl
// is security_invoker, so RLS on sales and inventory_items decides what comes
// back, which is how use-ship-queue.ts and the team scorecard already read it.
// An edge route would re-implement that scoping by hand AND need a manual
// container redeploy to ship. The Finances API calls stay on the edge, where
// they have to be; this is a read of our own tables.
//
// WHAT THIS CANNOT SHOW, and says so rather than implying otherwise: sale_pnl
// is WHERE status = 'completed'. A refund or cancellation also moves money in a
// payout, as a negative line eBay settles against the same deposit. Those are
// not here, so `linkedNet` is what the completed sales in this deposit earned,
// not a reconciliation of the bank figure. The deposit total is shown beside it
// from the payout header, and the gap between them is information rather than
// an error — see `PayoutBreakdown.headerAmount`.

/** One settled item in a payout. */
export interface PayoutItemRow {
  saleId: string;
  inventoryItemId: string | null;
  title: string;
  sku: string | null;
  sourcer: string;
  sourcerKey: string;
  saleDate: string;
  revenue: number;
  fees: number;
  costs: number;
  costBasis: number;
  net: number;
}

/** One person's share of a payout. */
export interface PayoutSourcerRow {
  key: string;
  person: string;
  items: number;
  revenue: number;
  fees: number;
  costs: number;
  costBasis: number;
  net: number;
}

export interface PayoutTotals {
  items: number;
  revenue: number;
  fees: number;
  costs: number;
  costBasis: number;
  net: number;
}

export interface PayoutBreakdown {
  payoutId: string;
  items: PayoutItemRow[];
  bySourcer: PayoutSourcerRow[];
  totals: PayoutTotals;
  /**
   * The deposit amount from the payout header, in dollars, when we hold it.
   * Deliberately NOT reconciled against `totals.net` in code: they measure
   * different things (bank deposit vs profit on completed sales) and quietly
   * making them agree would be the fabrication this file exists to avoid.
   */
  headerAmount: number | null;
  headerCurrency: string | null;
  headerDate: string | null;
}

/** Coerce the numeric-as-string values PostgREST returns for numeric columns. */
function money(v: number | string | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Round to cents once, at the end, so a column of sums does not drift. */
function cents(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Build the per-item and per-sourcer views of one payout.
 *
 * Pure: takes rows, returns the breakdown. The fetch below is what talks to the
 * database, so the grouping is testable with nothing but objects.
 */
export function buildPayoutBreakdown(
  payoutId: string,
  rows: SalePnlRow[],
  itemFacts: Map<string, { title: string | null; sku: string | null }>,
  header?: { amount: number | null; currency: string | null; date: string | null },
): PayoutBreakdown {
  const items: PayoutItemRow[] = rows.map((r) => {
    const facts = r.inventory_item_id ? itemFacts.get(r.inventory_item_id) : undefined;
    return {
      saleId: r.sale_id,
      inventoryItemId: r.inventory_item_id,
      // An item deleted after it sold leaves the sale behind. Naming that is
      // better than a blank cell that reads as a data bug.
      title: facts?.title?.trim() || "Untitled item",
      sku: facts?.sku?.trim() || null,
      sourcer: sourcerLabel(r.sourcer_name),
      sourcerKey: sourcerKey(r.sourcer_name),
      saleDate: r.sale_date,
      revenue: money(r.revenue),
      fees: money(r.fees),
      costs: money(r.costs),
      costBasis: money(r.cost_basis),
      net: money(r.net),
    };
  });

  const byKey = new Map<string, PayoutSourcerRow>();
  for (const it of items) {
    let row = byKey.get(it.sourcerKey);
    if (!row) {
      row = {
        key: it.sourcerKey,
        person: it.sourcer,
        items: 0,
        revenue: 0,
        fees: 0,
        costs: 0,
        costBasis: 0,
        net: 0,
      };
      byKey.set(it.sourcerKey, row);
    }
    row.items += 1;
    row.revenue += it.revenue;
    row.fees += it.fees;
    row.costs += it.costs;
    row.costBasis += it.costBasis;
    row.net += it.net;
  }

  const bySourcer = [...byKey.values()]
    .map((r) => ({
      ...r,
      revenue: cents(r.revenue),
      fees: cents(r.fees),
      costs: cents(r.costs),
      costBasis: cents(r.costBasis),
      net: cents(r.net),
    }))
    // Biggest earner first, then by name so the order is stable when two tie.
    .sort((a, b) => b.net - a.net || a.person.localeCompare(b.person));

  const totals: PayoutTotals = {
    items: items.length,
    revenue: cents(items.reduce((s, i) => s + i.revenue, 0)),
    fees: cents(items.reduce((s, i) => s + i.fees, 0)),
    costs: cents(items.reduce((s, i) => s + i.costs, 0)),
    costBasis: cents(items.reduce((s, i) => s + i.costBasis, 0)),
    net: cents(items.reduce((s, i) => s + i.net, 0)),
  };

  // Newest sale first inside the deposit.
  items.sort((a, b) => (a.saleDate < b.saleDate ? 1 : a.saleDate > b.saleDate ? -1 : 0));

  return {
    payoutId,
    items,
    bySourcer,
    totals,
    headerAmount: header?.amount ?? null,
    headerCurrency: header?.currency ?? null,
    headerDate: header?.date ?? null,
  };
}

const PAYOUT_PNL_COLUMNS =
  "sale_id, inventory_item_id, sale_date, sourcer_name, sourcer_key, payout_id, payout_date, revenue, fees, costs, cost_basis, net";

/**
 * Fetch one payout's settled sales and the item facts the table shows.
 *
 * Two reads rather than an embed: `inventory_items` is a separate RLS-guarded
 * table and PostgREST's embedded select on a VIEW cannot follow the foreign key
 * (sale_pnl has none), so the titles come from a second keyed read.
 */
export async function fetchPayoutBreakdown(
  ownerId: string,
  payoutId: string,
): Promise<PayoutBreakdown> {
  const { data, error } = await supabase
    .from("sale_pnl")
    .select(PAYOUT_PNL_COLUMNS)
    .eq("user_id", ownerId)
    .eq("payout_id", payoutId);
  if (error) throw error;
  const rows = (data ?? []) as unknown as SalePnlRow[];

  const itemIds = [...new Set(rows.map((r) => r.inventory_item_id).filter(Boolean))] as string[];
  const itemFacts = new Map<string, { title: string | null; sku: string | null }>();
  if (itemIds.length > 0) {
    const { data: items, error: itemsErr } = await supabase
      .from("inventory_items")
      .select("id, title, sku")
      .eq("user_id", ownerId)
      .in("id", itemIds);
    if (itemsErr) throw itemsErr;
    for (const it of (items ?? []) as unknown as Array<{
      id: string;
      title: string | null;
      sku: string | null;
    }>) {
      itemFacts.set(it.id, { title: it.title, sku: it.sku });
    }
  }

  // The header is optional on purpose: a reference can exist without one.
  const { data: header } = await supabase
    .from("ebay_payouts")
    .select("amount_cents, currency, payout_date")
    .eq("user_id", ownerId)
    .eq("payout_id", payoutId)
    .maybeSingle();
  const h = header as unknown as {
    amount_cents: number | null;
    currency: string | null;
    payout_date: string | null;
  } | null;

  return buildPayoutBreakdown(payoutId, rows, itemFacts, {
    amount: h?.amount_cents != null ? h.amount_cents / 100 : null,
    currency: h?.currency ?? null,
    date: h?.payout_date ?? null,
  });
}

/** CSV of the item table, for a seller who wants it in a spreadsheet. */
export function payoutBreakdownCsv(b: PayoutBreakdown): string {
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = [
    "payout_id,sale_date,title,sku,sourcer,revenue,fees,costs,cost_basis,net",
  ];
  for (const it of b.items) {
    lines.push(
      [
        esc(b.payoutId),
        esc(it.saleDate.slice(0, 10)),
        esc(it.title),
        esc(it.sku ?? ""),
        esc(it.sourcer),
        it.revenue.toFixed(2),
        it.fees.toFixed(2),
        it.costs.toFixed(2),
        it.costBasis.toFixed(2),
        it.net.toFixed(2),
      ].join(","),
    );
  }
  return lines.join("\n");
}
