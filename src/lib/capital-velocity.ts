// US-2825: return on capital per day held.
//
// Sell-through says what fraction moved. Profit says what it earned. Neither
// says what a DOLLAR earned while it was tied up, and that is the number that
// decides what to buy more of: $30 of profit on a $20 coat that sold in nine
// days is a different business from $30 on a $90 coat that sat for a year.
//
// Pure over rows, no supabase and no env, so every edge case below is testable
// without a database (same posture as flipdesk-analytics.ts).
//
// ── THE THREE WAYS THIS ARITHMETIC LIES, all handled explicitly ─────────────
// 1. A free or unpriced item divides by zero capital. Excluded and counted.
// 2. A same-day sale divides by zero days. Clamped to MIN_HOLD_DAYS.
// 3. A group that never sells has no realized profit, so it scores 0 and reads
//    as merely mediocre. Its parked capital is reported alongside, because a
//    group holding $4,000 that has never returned a cent is the finding.

import type { ItemFullRow } from "@/types/database";

export type VelocityGroupKey = "category" | "brand" | "source";

/**
 * A day, in the "how long was the money tied up" sense. A sale on the day of
 * purchase held capital for some of a day, not for none of it, and dividing by
 * zero would report it as infinitely good.
 */
export const MIN_HOLD_DAYS = 1;

/** Groups with fewer realized sales than this get counts and no velocity. */
export const MIN_VELOCITY_SALES = 3;

export type VelocityFields = Pick<
  ItemFullRow,
  | "purchase_price"
  | "purchase_date"
  | "sale_date"
  | "sale_status"
  | "net_profit"
  | "category"
  | "brand"
  | "source_name"
>;

export interface VelocityRow {
  group: string;
  /** Items whose capital is counted (priced above zero). */
  pricedItems: number;
  /** Priced items that sold. */
  soldItems: number;
  /** Sum of purchase_price over SOLD priced items. */
  deployedCapital: number;
  realizedProfit: number;
  medianDaysHeld: number | null;
  /**
   * Percent returned per dollar per day. Null under MIN_VELOCITY_SALES or when
   * any input is missing.
   */
  velocityPctPerDay: number | null;
  /** Capital in priced items that have NOT sold. */
  parkedCapital: number;
  parkedItems: number;
  medianDaysParked: number | null;
  /** Items dropped from every capital figure for want of a price. */
  unpricedItems: number;
}

export interface VelocityReport {
  rows: VelocityRow[];
  /** Account-wide count of items with no usable purchase price. */
  unpricedItems: number;
}

function groupValue(item: VelocityFields, key: VelocityGroupKey): string {
  if (key === "category") return item.category?.trim() || "Uncategorized";
  if (key === "brand") return item.brand?.trim() || "No brand";
  return item.source_name?.trim() || "No source";
}

function median(nums: number[]): number | null {
  const s = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (s.length === 0) return null;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(from.slice(0, 10));
  const b = Date.parse(to.slice(0, 10));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  const d = Math.round((b - a) / 86_400_000);
  return d < 0 ? null : d;
}

function isSold(item: VelocityFields): boolean {
  return item.sale_date != null && item.sale_status === "completed";
}

function usablePrice(item: VelocityFields): number | null {
  const p = item.purchase_price;
  return p != null && Number.isFinite(p) && p > 0 ? p : null;
}

/**
 * Velocity per group, best first.
 *
 * `asOf` is the day parked inventory is aged against. Passed in rather than
 * read from the clock so the output is deterministic in a test.
 */
export function capitalVelocity(
  items: VelocityFields[],
  key: VelocityGroupKey,
  asOf: string,
): VelocityReport {
  const acc = new Map<
    string,
    {
      priced: number;
      unpriced: number;
      soldCapital: number;
      profit: number;
      soldDays: number[];
      soldCount: number;
      parkedCapital: number;
      parkedCount: number;
      parkedDays: number[];
    }
  >();

  let unpricedTotal = 0;

  for (const item of items) {
    const g = groupValue(item, key);
    const row =
      acc.get(g) ??
      {
        priced: 0,
        unpriced: 0,
        soldCapital: 0,
        profit: 0,
        soldDays: [],
        soldCount: 0,
        parkedCapital: 0,
        parkedCount: 0,
        parkedDays: [],
      };
    acc.set(g, row);

    const price = usablePrice(item);
    if (price == null) {
      row.unpriced += 1;
      unpricedTotal += 1;
      continue;
    }
    row.priced += 1;

    if (isSold(item)) {
      row.soldCapital += price;
      row.soldCount += 1;
      if (item.net_profit != null && Number.isFinite(item.net_profit)) {
        row.profit += item.net_profit;
      }
      if (item.purchase_date && item.sale_date) {
        const d = daysBetween(item.purchase_date, item.sale_date);
        if (d != null) row.soldDays.push(d);
      }
    } else {
      row.parkedCapital += price;
      row.parkedCount += 1;
      if (item.purchase_date) {
        const d = daysBetween(item.purchase_date, asOf);
        if (d != null) row.parkedDays.push(d);
      }
    }
  }

  const rows: VelocityRow[] = Array.from(acc.entries()).map(([group, r]) => {
    const medDays = median(r.soldDays);
    const held = medDays == null ? null : Math.max(medDays, MIN_HOLD_DAYS);
    const velocity =
      r.soldCount >= MIN_VELOCITY_SALES && r.soldCapital > 0 && held != null
        ? (r.profit / r.soldCapital / held) * 100
        : null;
    return {
      group,
      pricedItems: r.priced,
      soldItems: r.soldCount,
      deployedCapital: round2(r.soldCapital),
      realizedProfit: round2(r.profit),
      medianDaysHeld: medDays,
      velocityPctPerDay: velocity == null ? null : round4(velocity),
      parkedCapital: round2(r.parkedCapital),
      parkedItems: r.parkedCount,
      medianDaysParked: median(r.parkedDays),
      unpricedItems: r.unpriced,
    };
  });

  rows.sort((a, b) => {
    // Unranked groups sort last rather than sorting as zero: "no velocity yet"
    // and "velocity of nothing" are different answers.
    const av = a.velocityPctPerDay;
    const bv = b.velocityPctPerDay;
    if (av == null && bv == null) return b.parkedCapital - a.parkedCapital;
    if (av == null) return 1;
    if (bv == null) return -1;
    return bv - av || a.group.localeCompare(b.group);
  });

  return { rows, unpricedItems: unpricedTotal };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/** Groups carrying a real velocity, best first. */
export function rankedGroups(report: VelocityReport): VelocityRow[] {
  return report.rows.filter((r) => r.velocityPctPerDay != null);
}

/** The group holding the most capital that has never returned a cent. */
export function deadestCapital(report: VelocityReport): VelocityRow | null {
  const candidates = report.rows.filter(
    (r) => r.parkedCapital > 0 && r.realizedProfit <= 0 && r.soldItems === 0,
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) =>
    b.parkedCapital > a.parkedCapital ? b : a,
  );
}
