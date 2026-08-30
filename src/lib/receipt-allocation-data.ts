import { supabase } from "@/lib/supabase";
import { toCents } from "@/lib/ledger-math";
import type { AllocationPlan, AllocationTarget } from "@/lib/receipt-allocation";

// US-3012 — the data half of splitting a receipt across the items it bought.
//
// AC5 IS THE RULE THIS FILE EXISTS TO KEEP. Setting a cost basis writes
// `inventory_items.acquired_price` and nothing else. There is no second,
// parallel notion of what an item cost: US-2984's ledger derives cost of goods
// from that column, and a receipt allocation stored anywhere else would produce
// a P&L that disagrees with the item page about the same jacket.

/** How far either side of the receipt date to look. */
export const DEFAULT_WINDOW_DAYS = 3;

function shiftYmd(ymd: string, days: number): string {
  // Parsed as a LOCAL date, never `new Date("2025-04-01")`, which is UTC
  // midnight and lands on the previous day west of Greenwich -- the same class
  // of bug as US-2339, one field along.
  const [y, m, d] = ymd.split("-").map(Number);
  const at = new Date(y!, (m ?? 1) - 1, d ?? 1);
  at.setDate(at.getDate() + days);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
}

/**
 * AC1 — the items the seller acquired near this receipt's date.
 *
 * Same day first, widening by `windowDays`. The order matters: on a day with
 * one sourcing trip the same-day items ARE the answer, and putting them first
 * means the common case needs no scrolling. A wider net would bury them.
 */
export async function fetchAcquisitionCandidates(
  spentOn: string,
  windowDays = DEFAULT_WINDOW_DAYS,
): Promise<AllocationTarget[]> {
  const from = shiftYmd(spentOn, -windowDays);
  const to = shiftYmd(spentOn, windowDays);

  const { data, error } = await supabase
    .from("inventory_items")
    .select("id, title, acquired_price, acquired_date")
    .gte("acquired_date", from)
    .lte("acquired_date", to)
    .order("acquired_date", { ascending: true })
    .limit(200);
  if (error) throw error;

  const rows = (data ?? []) as {
    id: string;
    title: string | null;
    acquired_price: number | string | null;
    acquired_date: string | null;
  }[];

  const targets = rows.map((r) => ({
    id: r.id,
    title: r.title ?? "Untitled item",
    acquired_price_cents: r.acquired_price == null ? null : toCents(r.acquired_price),
    acquired_date: r.acquired_date,
  }));

  // Same day first, then nearest. Stable within a group so the list does not
  // reshuffle between renders while the seller is assigning lines to it.
  return targets.sort((a, b) => {
    const da = a.acquired_date === spentOn ? 0 : 1;
    const db = b.acquired_date === spentOn ? 0 : 1;
    if (da !== db) return da - db;
    return (a.acquired_date ?? "").localeCompare(b.acquired_date ?? "");
  });
}

export interface ApplyResult {
  updated: number;
  failed: { item_id: string; message: string }[];
}

/**
 * Write the plan.
 *
 * ONE COLUMN, ITEM BY ITEM. A bulk upsert would be fewer round trips and would
 * also let one bad row take the others down with it; here a failure names the
 * item it belongs to, and the ones that worked stay written. A seller who has
 * just assigned six lines should not lose five of them to the sixth.
 *
 * Cents to dollars at the boundary, so the stored numeric is always an exact
 * 2-dp value -- the same rule the ledger's own converter keeps.
 */
export async function applyAllocation(plan: AllocationPlan): Promise<ApplyResult> {
  const failed: ApplyResult["failed"] = [];
  let updated = 0;

  for (const a of plan.allocations) {
    const { error } = await supabase
      .from("inventory_items")
      .update({ acquired_price: a.cents / 100 } as never)
      .eq("id", a.item_id);
    if (error) failed.push({ item_id: a.item_id, message: error.message });
    else updated++;
  }

  return { updated, failed };
}

/**
 * AC4 — the leftover, as one operating expense.
 *
 * Category `other` on purpose -- the enum's unsorted value, which
 * `default_account_for_category` maps to the ledger's `uncategorised` account
 * and which therefore reaches NO Schedule C line. A bag fee is not shipping
 * supplies, and guessing would put a wrong figure on a real line; leaving it
 * unsorted puts it in the US-2992 review queue, which is exactly where a thing
 * nobody has decided about belongs.
 */
export async function createRemainderExpense(
  userId: string,
  remainder: { amount_cents: number; description: string; spent_on: string | null },
): Promise<void> {
  const { error } = await supabase.from("flipdesk_expenses").insert({
    user_id: userId,
    category: "other",
    description: remainder.description,
    amount: remainder.amount_cents / 100,
    spent_on: remainder.spent_on,
  } as never);
  if (error) throw error;
}
