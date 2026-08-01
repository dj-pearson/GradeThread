// US-2173: the listings page's presentational helpers, shared with the table
// component it was split into.
//
// These live here rather than in either file because both need them and a
// direct import between the two would be circular — listings.tsx renders
// ListingsTable, so ListingsTable cannot reach back for a helper.
//
// Everything here is pure and reads only the row it is given, which is what
// makes it testable without rendering anything.

import type { ItemFullRow } from "@/types/database";

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
// eBay's default handling window; the ship-by countdown is measured from it.
const DEFAULT_HANDLING_DAYS = 3;

export function fmtMoney(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "";
  return `$${n.toFixed(2)}`;
}

export function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (isNaN(t)) return null;
  return Math.floor((Date.now() - t) / DAY_MS);
}

export function scoreColor(score: number): string {
  if (score >= 70) return "text-emerald-600 dark:text-emerald-400";
  if (score >= 45) return "text-amber-600 dark:text-amber-400";
  return "text-muted-foreground";
}

export function marginPct(it: ItemFullRow): number | null {
  if (it.sale_price == null || it.sale_price <= 0) return null;
  if (it.net_profit == null) return null;
  return (it.net_profit / it.sale_price) * 100;
}

export interface ShipBy {
  label: string;
  tone: "red" | "amber" | "green" | "none";
}

export function shipByInfo(it: ItemFullRow): ShipBy {
  const sold = it.sold_at_raw ?? it.sale_date;
  const t = sold ? new Date(sold).getTime() : null;
  if (t == null || isNaN(t)) return { label: "", tone: "none" };
  const dueBy = t + DEFAULT_HANDLING_DAYS * DAY_MS;
  const msLeft = dueBy - Date.now();
  if (msLeft < 0) {
    return {
      label: `${Math.ceil(-msLeft / DAY_MS)}d overdue`,
      tone: "red",
    };
  }
  const hoursLeft = msLeft / HOUR_MS;
  if (hoursLeft < 24) return { label: `${Math.round(hoursLeft)}h left`, tone: "red" };
  if (hoursLeft < 48) {
    return { label: `${Math.round(hoursLeft)}h left`, tone: "amber" };
  }
  return { label: `${Math.round(hoursLeft / 24)}d left`, tone: "green" };
}
