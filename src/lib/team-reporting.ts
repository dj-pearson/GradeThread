import { supabase } from "@/lib/supabase";
import type { SalePnlRow } from "@/types/database";

// US-3019 — the sourcing team's numbers.
//
// Everything about money here comes from ONE place: public.sale_pnl (migration
// 00706), which is the same derivation finances_dashboard uses and is checked
// against it to the cent by scripts/check-sale-pnl-invariant.mjs. Nothing in
// this file re-derives net profit, and nothing in it should ever start to --
// a second opinion about profit is a report that quietly contradicts the P&L.
//
// What this file DOES own is the join sale_pnl cannot do on its own: the sold
// side is keyed on the SALE date, the bought side on the ACQUIRED date, and a
// person can appear on either side alone. A sourcer with three buys and no
// sales yet is the most interesting row on the page and the easiest one to
// accidentally drop, so the merge is an outer join in both directions.

/** A person's name folded for grouping. 'Dan', 'dan' and ' DAN ' are one key. */
export function sourcerKey(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  return (trimmed === "" ? "Unassigned" : trimmed).toLowerCase();
}

/** The name to SHOW for a key. Whatever they typed, not the lowercased key. */
export function sourcerLabel(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  return trimmed === "" ? "Unassigned" : trimmed;
}

/** The bought side: one inventory row, only the columns the scorecard needs. */
export interface TeamItemRow {
  id: string;
  sourced_by: string | null;
  acquired_price: number | string | null;
  acquired_date: string | null;
  status: string;
  sold: boolean;
}

export interface ScorecardRow {
  key: string;
  person: string;
  itemsBought: number;
  spend: number;
  itemsSold: number;
  revenue: number;
  net: number;
  /** revenue / spend. null when spend is 0 -- a ratio against nothing is not 0. */
  returnMultiple: number | null;
  /** null when no sale in the period carried a purchase date. */
  avgDaysToSell: number | null;
  /** sold / bought, over items BOUGHT in the period. null when none were. */
  sellThrough: number | null;
  unsoldValue: number;
  unsoldCount: number;
}

export interface Scorecard {
  rows: ScorecardRow[];
  totals: Omit<ScorecardRow, "key" | "person">;
  /** Operating expenses in the period. Attributable to nobody, by design. */
  overhead: number;
  /** True when the caller could not read flipdesk_expenses (see fetchOverhead). */
  overheadUnavailable: boolean;
}

/**
 * A money column to a number.
 *
 * PostgREST hands back `numeric` as a STRING, and `Number(null)` is 0 while
 * `Number("")` is also 0 and `Number(undefined)` is NaN. One helper so a NaN
 * cannot leak into a total and render every cell as an em dash.
 */
export function money(value: number | string | null | undefined): number {
  if (value === null || value === undefined || value === "") return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Sum, with the same tolerance for nulls and numeric-as-string. */
function sum(values: Array<number | string | null | undefined>): number {
  let total = 0;
  for (const v of values) total += money(v);
  return total;
}

/**
 * Build the scorecard from the two sides.
 *
 * `sales` are the completed sales whose SALE date fell in the period.
 * `items` are the inventory rows whose ACQUIRED date fell in the period.
 * A person present on either side gets a row; a person present on neither does
 * not exist as far as this period is concerned.
 */
export function buildScorecard(
  sales: SalePnlRow[],
  items: TeamItemRow[],
  overhead: number,
  overheadUnavailable = false,
): Scorecard {
  const byKey = new Map<string, ScorecardRow>();

  const rowFor = (rawName: string | null | undefined): ScorecardRow => {
    const key = sourcerKey(rawName);
    let row = byKey.get(key);
    if (!row) {
      row = {
        key,
        person: sourcerLabel(rawName),
        itemsBought: 0,
        spend: 0,
        itemsSold: 0,
        revenue: 0,
        net: 0,
        returnMultiple: null,
        avgDaysToSell: null,
        sellThrough: null,
        unsoldValue: 0,
        unsoldCount: 0,
      };
      byKey.set(key, row);
    }
    return row;
  };

  // Days to sell is averaged only over the sales that HAVE a purchase date.
  // Counting a null as zero would reward a seller for not filling the field in.
  const dayTotals = new Map<string, { total: number; count: number }>();

  for (const s of sales) {
    const row = rowFor(s.sourcer_name);
    row.itemsSold += 1;
    row.revenue += money(s.revenue);
    row.net += money(s.net);
    const days = s.days_to_sell;
    if (days !== null && days !== undefined) {
      const d = money(days);
      if (d >= 0) {
        const acc = dayTotals.get(row.key) ?? { total: 0, count: 0 };
        acc.total += d;
        acc.count += 1;
        dayTotals.set(row.key, acc);
      }
    }
  }

  for (const it of items) {
    const row = rowFor(it.sourced_by);
    row.itemsBought += 1;
    row.spend += money(it.acquired_price);
    if (!it.sold) {
      row.unsoldCount += 1;
      row.unsoldValue += money(it.acquired_price);
    }
  }

  for (const row of byKey.values()) {
    row.returnMultiple = row.spend > 0 ? row.revenue / row.spend : null;
    // Sell-through is asked of the items BOUGHT in the window, so a person who
    // bought nothing this period has no denominator rather than a 0% score.
    row.sellThrough =
      row.itemsBought > 0
        ? (row.itemsBought - row.unsoldCount) / row.itemsBought
        : null;
    const acc = dayTotals.get(row.key);
    row.avgDaysToSell = acc && acc.count > 0 ? acc.total / acc.count : null;
  }

  const rows = [...byKey.values()].sort((a, b) => b.net - a.net);

  const totals = {
    itemsBought: rows.reduce((n, r) => n + r.itemsBought, 0),
    spend: rows.reduce((n, r) => n + r.spend, 0),
    itemsSold: rows.reduce((n, r) => n + r.itemsSold, 0),
    revenue: rows.reduce((n, r) => n + r.revenue, 0),
    net: rows.reduce((n, r) => n + r.net, 0),
    unsoldValue: rows.reduce((n, r) => n + r.unsoldValue, 0),
    unsoldCount: rows.reduce((n, r) => n + r.unsoldCount, 0),
    returnMultiple: null as number | null,
    avgDaysToSell: null as number | null,
    sellThrough: null as number | null,
  };
  totals.returnMultiple = totals.spend > 0 ? totals.revenue / totals.spend : null;
  totals.sellThrough =
    totals.itemsBought > 0
      ? (totals.itemsBought - totals.unsoldCount) / totals.itemsBought
      : null;
  const allDays = [...dayTotals.values()].reduce(
    (acc, d) => ({ total: acc.total + d.total, count: acc.count + d.count }),
    { total: 0, count: 0 },
  );
  totals.avgDaysToSell = allDays.count > 0 ? allDays.total / allDays.count : null;

  return { rows, totals, overhead, overheadUnavailable };
}

// ══════════════════════════════════════════════════════════
// DEAD CAPITAL (US-3020)
// ══════════════════════════════════════════════════════════

/**
 * Age buckets for unsold stock, in days held.
 *
 * `null` on `maxDays` is the open-ended top bucket. "unknown" is not an age at
 * all -- it is the item with no purchase date, which must be visible rather
 * than dropped or silently treated as bought today.
 */
export const AGE_BUCKETS = [
  { id: "0-30", label: "0-30 days", maxDays: 30 },
  { id: "31-60", label: "31-60 days", maxDays: 60 },
  { id: "61-90", label: "61-90 days", maxDays: 90 },
  { id: "91-180", label: "91-180 days", maxDays: 180 },
  { id: "180+", label: "180+ days", maxDays: null },
  { id: "unknown", label: "Unknown age", maxDays: null },
] as const;

export type AgeBucketId = (typeof AGE_BUCKETS)[number]["id"];

/** The buckets that count toward "older than 90 days". */
const STALE_BUCKETS: AgeBucketId[] = ["91-180", "180+"];

/**
 * Whole days between a purchase date and `now`, floored, never negative.
 *
 * A future acquired_date (a typo, or a timezone slip on an import) would give a
 * negative age and land in no bucket at all, so it is clamped to 0 rather than
 * dropped.
 */
export function daysHeld(
  acquiredDate: string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!acquiredDate) return null;
  const then = new Date(acquiredDate);
  if (Number.isNaN(then.getTime())) return null;
  const ms = now.getTime() - then.getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

/**
 * Which bucket an age falls in.
 *
 * The boundaries are INCLUSIVE at the top: 30 days is "0-30" and 31 days is
 * "31-60", which is what the labels say and is the half of this that a test
 * has to pin. Off-by-one here moves money between columns on a page whose
 * whole job is telling someone their money is stuck.
 */
export function ageBucket(days: number | null): AgeBucketId {
  if (days === null) return "unknown";
  if (days <= 30) return "0-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  if (days <= 180) return "91-180";
  return "180+";
}

/** One unsold item, as the dead-capital card needs it. */
export interface DeadItem {
  id: string;
  title: string;
  acquiredDate: string | null;
  acquiredPrice: number;
  days: number | null;
  bucket: AgeBucketId;
}

export interface DeadCapitalRow {
  key: string;
  person: string;
  /** Dollars per bucket. Every bucket id is present, so columns line up. */
  buckets: Record<AgeBucketId, number>;
  counts: Record<AgeBucketId, number>;
  total: number;
  count: number;
  /** Dollars in items held longer than 90 days. The number to act on. */
  stale: number;
  /** The five oldest, newest-last. Items with no date sort after dated ones. */
  oldest: DeadItem[];
}

export interface DeadCapital {
  rows: DeadCapitalRow[];
  totals: Record<AgeBucketId, number>;
  grandTotal: number;
  staleTotal: number;
}

function emptyBuckets(): Record<AgeBucketId, number> {
  const out = {} as Record<AgeBucketId, number>;
  for (const b of AGE_BUCKETS) out[b.id] = 0;
  return out;
}

/** How many of the oldest items each row names. */
export const OLDEST_SHOWN = 5;

/**
 * Group unsold stock by the person who bought it.
 *
 * `items` must already be filtered to the UNSOLD ones (see fetchDeadCapital) --
 * this function does not know what a sale is, which keeps it testable with
 * nothing but rows.
 */
export function buildDeadCapital(
  items: TeamItemRow[],
  titleById: Map<string, string>,
  now: Date = new Date(),
): DeadCapital {
  const byKey = new Map<string, DeadCapitalRow>();

  for (const it of items) {
    const key = sourcerKey(it.sourced_by);
    let row = byKey.get(key);
    if (!row) {
      row = {
        key,
        person: sourcerLabel(it.sourced_by),
        buckets: emptyBuckets(),
        counts: emptyBuckets(),
        total: 0,
        count: 0,
        stale: 0,
        oldest: [],
      };
      byKey.set(key, row);
    }
    const days = daysHeld(it.acquired_date, now);
    const bucket = ageBucket(days);
    const price = money(it.acquired_price);

    row.buckets[bucket] += price;
    row.counts[bucket] += 1;
    row.total += price;
    row.count += 1;
    if (STALE_BUCKETS.includes(bucket)) row.stale += price;

    row.oldest.push({
      id: it.id,
      title: titleById.get(it.id) ?? "Untitled item",
      acquiredDate: it.acquired_date,
      acquiredPrice: price,
      days,
      bucket,
    });
  }

  const totals = emptyBuckets();
  let grandTotal = 0;
  let staleTotal = 0;

  for (const row of byKey.values()) {
    // Oldest first. An item with no date has no place on an age ladder, so it
    // sorts to the end rather than to either extreme.
    row.oldest.sort((a, b) => {
      if (a.days === null && b.days === null) return 0;
      if (a.days === null) return 1;
      if (b.days === null) return -1;
      return b.days - a.days;
    });
    row.oldest = row.oldest.slice(0, OLDEST_SHOWN);

    for (const b of AGE_BUCKETS) totals[b.id] += row.buckets[b.id];
    grandTotal += row.total;
    staleTotal += row.stale;
  }

  // Worst first: the person with the most money stuck past 90 days is the one
  // this card exists to surface, so they lead regardless of headline total.
  const rows = [...byKey.values()].sort(
    (a, b) => b.stale - a.stale || b.total - a.total,
  );

  return { rows, totals, grandTotal, staleTotal };
}

export const EMPTY_DEAD_CAPITAL: DeadCapital = {
  rows: [],
  totals: emptyBuckets(),
  grandTotal: 0,
  staleTotal: 0,
};

/**
 * Every unsold item in the workspace, grouped by who bought it.
 *
 * Deliberately NOT windowed by the page's period. Dead capital is a question
 * about right now -- "what is stuck" -- and hiding a two-year-old item because
 * the picker says "last 30 days" would answer the opposite of what was asked.
 *
 * Unsold is BOTH tests, not either: status is not a terminal one, AND there is
 * no completed sale. Status alone is unreliable (an item can sell while its
 * row still says 'listed'); the sale alone would keep an archived write-off on
 * the books as live capital, which is exactly the overstatement US-3007 fixed
 * for the tax side.
 */
export async function fetchDeadCapital(
  ownerId: string,
  now: Date = new Date(),
): Promise<DeadCapital> {
  const { data, error } = await supabase
    .from("inventory_items")
    .select("id, title, sourced_by, acquired_price, acquired_date, status")
    .eq("user_id", ownerId)
    .not("status", "in", "(sold,archived)");
  if (error) throw error;
  const rows = (data ?? []) as unknown as Array<
    Omit<TeamItemRow, "sold"> & { title: string | null }
  >;

  const soldIds = await fetchSoldItemIds(ownerId);
  const titleById = new Map<string, string>();
  const unsold: TeamItemRow[] = [];
  for (const r of rows) {
    if (soldIds.has(r.id)) continue;
    titleById.set(r.id, (r.title ?? "").trim() || "Untitled item");
    unsold.push({ ...r, sold: false });
  }

  return buildDeadCapital(unsold, titleById, now);
}

// ══════════════════════════════════════════════════════════
// OVERPAY / MISS (US-3021)
// ══════════════════════════════════════════════════════════

/** The margin a buy is expected to clear. 30% unless the seller says otherwise. */
export const DEFAULT_TARGET_MARGIN = 0.3;

export type MissReason = "loss" | "below-target";

export interface MissClassification {
  isMiss: boolean;
  reason: MissReason | null;
  /** Dollars short of target. Positive by construction when isMiss. */
  shortfall: number;
}

/**
 * Was this sale a miss, and by how much?
 *
 * ALL OF THIS IS DONE IN CENTS. `revenue * 0.3` in floating point gives
 * 29.999999999999996 on ordinary inputs, so a sale landing exactly on target
 * compares as one hundred-millionth of a cent under it and gets reported as a
 * miss. Naming someone for missing target by $0.00000001 is the kind of wrong
 * that destroys trust in a whole report, and it is invisible in every test
 * that does not use an awkward number.
 *
 * A sale with no revenue cannot be measured against a margin, so it is judged
 * on the only question that still makes sense: did it lose money. That falls
 * out of the arithmetic rather than needing its own branch -- the target for
 * zero revenue is zero, so the test reduces to `net < 0`.
 */
export function classifyMiss(
  sale: Pick<SalePnlRow, "revenue" | "net">,
  targetMargin: number,
): MissClassification {
  const revenueCents = Math.round(money(sale.revenue) * 100);
  const netCents = Math.round(money(sale.net) * 100);
  const targetNetCents = Math.round(revenueCents * targetMargin);
  const shortfallCents = targetNetCents - netCents;

  if (shortfallCents <= 0) return { isMiss: false, reason: null, shortfall: 0 };
  return {
    isMiss: true,
    // A sale that lost money is a different conversation from one that made
    // money slowly, so the two are labelled apart even though one formula
    // catches both.
    reason: netCents < 0 ? "loss" : "below-target",
    shortfall: shortfallCents / 100,
  };
}

export interface MissItem {
  saleId: string;
  itemId: string | null;
  title: string;
  sourceKey: string;
  paid: number;
  soldFor: number;
  net: number;
  shortfall: number;
  reason: MissReason;
  saleDate: string;
}

export interface MissShopGroup {
  sourceKey: string;
  count: number;
  shortfall: number;
  net: number;
}

export interface MissPersonGroup {
  key: string;
  person: string;
  count: number;
  /** Of those, how many actually lost money. */
  lossCount: number;
  shortfall: number;
  net: number;
  shops: MissShopGroup[];
  /** The worst five by shortfall -- what the card shows. */
  worst: MissItem[];
  /**
   * Every miss for this person, worst first.
   *
   * The card shows `worst` and tells the reader the CSV has the rest, so the
   * CSV has to actually have the rest. It read `worst` at first, which made
   * that sentence false for anyone with more than five.
   */
  all: MissItem[];
}

export interface MissReport {
  rows: MissPersonGroup[];
  count: number;
  shortfall: number;
  targetMargin: number;
  /** Sales examined. Zero misses out of zero sales is not the same as out of 80. */
  salesConsidered: number;
}

/** How many of the worst items each group names. */
export const WORST_SHOWN = 5;

export function buildMissReport(
  sales: SalePnlRow[],
  titleById: Map<string, string>,
  targetMargin: number,
): MissReport {
  const byKey = new Map<string, MissPersonGroup>();
  // Every miss per person, kept beside the group rather than inside it. The
  // shop rollup and the worst-five are two views of this SAME list, so they
  // cannot disagree about how many misses there were -- and `worst` never
  // spends part of its life meaning "all of them".
  const allMisses = new Map<string, MissItem[]>();
  let count = 0;
  let shortfall = 0;

  for (const s of sales) {
    const verdict = classifyMiss(s, targetMargin);
    if (!verdict.isMiss || verdict.reason === null) continue;

    const key = sourcerKey(s.sourcer_name);
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        person: sourcerLabel(s.sourcer_name),
        count: 0,
        lossCount: 0,
        shortfall: 0,
        net: 0,
        shops: [],
        worst: [],
        all: [],
      };
      byKey.set(key, group);
    }

    group.count += 1;
    if (verdict.reason === "loss") group.lossCount += 1;
    group.shortfall += verdict.shortfall;
    group.net += money(s.net);
    count += 1;
    shortfall += verdict.shortfall;

    const list = allMisses.get(key) ?? [];
    list.push({
      saleId: s.sale_id,
      itemId: s.inventory_item_id,
      title:
        (s.inventory_item_id ? titleById.get(s.inventory_item_id) : null) ??
        "Untitled item",
      sourceKey: s.source_key,
      paid: money(s.cost_basis),
      soldFor: money(s.revenue),
      net: money(s.net),
      shortfall: verdict.shortfall,
      reason: verdict.reason,
      saleDate: s.sale_date,
    });
    allMisses.set(key, list);
  }

  for (const group of byKey.values()) {
    const misses = allMisses.get(group.key) ?? [];
    const shops = new Map<string, MissShopGroup>();
    for (const m of misses) {
      const shop = shops.get(m.sourceKey) ?? {
        sourceKey: m.sourceKey,
        count: 0,
        shortfall: 0,
        net: 0,
      };
      shop.count += 1;
      shop.shortfall += m.shortfall;
      shop.net += m.net;
      shops.set(m.sourceKey, shop);
    }
    group.shops = [...shops.values()].sort((a, b) => b.shortfall - a.shortfall);

    group.all = [...misses].sort((a, b) => b.shortfall - a.shortfall);
    group.worst = group.all.slice(0, WORST_SHOWN);
  }

  const rows = [...byKey.values()].sort(
    (a, b) => b.shortfall - a.shortfall || a.person.localeCompare(b.person),
  );

  return {
    rows,
    count,
    shortfall,
    targetMargin,
    salesConsidered: sales.length,
  };
}

export const EMPTY_MISS_REPORT: MissReport = {
  rows: [],
  count: 0,
  shortfall: 0,
  targetMargin: DEFAULT_TARGET_MARGIN,
  salesConsidered: 0,
};

/** Titles for a set of item ids, in one read. */
export async function fetchItemTitles(
  ownerId: string,
  ids: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const { data, error } = await supabase
    .from("inventory_items")
    .select("id, title")
    .eq("user_id", ownerId)
    .in("id", ids);
  if (error) throw error;
  const rows = (data ?? []) as unknown as Array<{
    id: string;
    title: string | null;
  }>;
  for (const r of rows) out.set(r.id, (r.title ?? "").trim() || "Untitled item");
  return out;
}

export async function fetchMissReport(
  ownerId: string,
  from: string | null,
  targetMargin: number,
  to: string | null = null,
): Promise<MissReport> {
  const sales = await fetchSalePnl(ownerId, from, to);
  // Only the misses need titles, so the id list is the misses' -- not every
  // sale in the period.
  const missIds = [
    ...new Set(
      sales
        .filter((s) => classifyMiss(s, targetMargin).isMiss)
        .map((s) => s.inventory_item_id)
        .filter((id): id is string => !!id),
    ),
  ];
  const titles = await fetchItemTitles(ownerId, missIds);
  return buildMissReport(sales, titles, targetMargin);
}

// ══════════════════════════════════════════════════════════
// PERSON x SHOP (US-3022)
// ══════════════════════════════════════════════════════════

export type CrosstabMetric = "net" | "count" | "avgNet";

export const CROSSTAB_METRICS: Array<{ id: CrosstabMetric; label: string }> = [
  { id: "net", label: "Net profit" },
  { id: "count", label: "Items sold" },
  { id: "avgNet", label: "Avg net per item" },
];

/** How many shops get their own column before the rest are folded together. */
export const MAX_SHOP_COLUMNS = 12;

/** The column every shop past the cap is folded into. */
export const OTHER_SHOPS = "Other shops";

export interface CrosstabCell {
  net: number;
  count: number;
}

export interface CrosstabRow {
  key: string;
  person: string;
  /** Keyed by column label. A missing key means no sales there, not zero. */
  cells: Map<string, CrosstabCell>;
  total: CrosstabCell;
}

export interface Crosstab {
  /** Column labels in display order, 'Other shops' last when present. */
  columns: string[];
  rows: CrosstabRow[];
  columnTotals: Map<string, CrosstabCell>;
  grandTotal: CrosstabCell;
  /** How many real shops went into 'Other shops'. 0 when nothing was folded. */
  foldedShops: number;
}

/**
 * The value a cell shows for a metric.
 *
 * `avgNet` is deliberately derived from the cell's OWN net and count rather
 * than averaged from anything upstream. An average of averages is not an
 * average, and it would make the 'Other shops' column and every total quietly
 * wrong in a way that looks plausible.
 */
export function crosstabValue(
  cell: CrosstabCell | undefined,
  metric: CrosstabMetric,
): number | null {
  if (!cell || cell.count === 0) return null;
  if (metric === "count") return cell.count;
  if (metric === "net") return cell.net;
  return cell.net / cell.count;
}

function addTo(target: Map<string, CrosstabCell>, key: string, net: number) {
  const cell = target.get(key) ?? { net: 0, count: 0 };
  cell.net += net;
  cell.count += 1;
  target.set(key, cell);
}

/**
 * Net profit by person and by shop.
 *
 * Columns are chosen by ABSOLUTE net, so the shop that lost the most money is
 * as likely to earn a column as the one that made the most. Ranking by net
 * alone would fold a disaster into 'Other shops' and hide the single thing on
 * the page worth acting on.
 */
export function buildCrosstab(
  sales: SalePnlRow[],
  maxColumns: number = MAX_SHOP_COLUMNS,
): Crosstab {
  // Pass 1: how much each shop is worth, so the columns can be chosen.
  const shopTotals = new Map<string, CrosstabCell>();
  for (const s of sales) addTo(shopTotals, s.source_key, money(s.net));

  const ranked = [...shopTotals.entries()].sort(
    (a, b) =>
      Math.abs(b[1].net) - Math.abs(a[1].net) ||
      b[1].count - a[1].count ||
      a[0].localeCompare(b[0]),
  );
  const kept = new Set(ranked.slice(0, maxColumns).map(([name]) => name));
  const foldedShops = Math.max(0, ranked.length - kept.size);

  const columnOf = (shop: string) => (kept.has(shop) ? shop : OTHER_SHOPS);

  // Pass 2: the grid itself.
  const byKey = new Map<string, CrosstabRow>();
  const columnTotals = new Map<string, CrosstabCell>();
  const grandTotal: CrosstabCell = { net: 0, count: 0 };

  for (const s of sales) {
    const key = sourcerKey(s.sourcer_name);
    let row = byKey.get(key);
    if (!row) {
      row = {
        key,
        person: sourcerLabel(s.sourcer_name),
        cells: new Map(),
        total: { net: 0, count: 0 },
      };
      byKey.set(key, row);
    }
    const net = money(s.net);
    const column = columnOf(s.source_key);

    addTo(row.cells, column, net);
    addTo(columnTotals, column, net);
    row.total.net += net;
    row.total.count += 1;
    grandTotal.net += net;
    grandTotal.count += 1;
  }

  // 'Other shops' always sorts last: it is a bucket, not a place, and letting
  // it rank among real shops implies it is one.
  const columns = ranked
    .slice(0, maxColumns)
    .map(([name]) => name)
    .filter((name) => columnTotals.has(name));
  if (columnTotals.has(OTHER_SHOPS)) columns.push(OTHER_SHOPS);

  const rows = [...byKey.values()].sort(
    (a, b) => b.total.net - a.total.net || a.person.localeCompare(b.person),
  );

  return { columns, rows, columnTotals, grandTotal, foldedShops };
}

export const EMPTY_CROSSTAB: Crosstab = {
  columns: [],
  rows: [],
  columnTotals: new Map(),
  grandTotal: { net: 0, count: 0 },
  foldedShops: 0,
};

/**
 * The largest absolute cell value for a metric, for scaling the shading.
 *
 * Totals are excluded on purpose: they dwarf every cell, and scaling to them
 * would wash the whole grid out to one flat tint.
 */
export function crosstabScale(grid: Crosstab, metric: CrosstabMetric): number {
  let max = 0;
  for (const row of grid.rows) {
    for (const column of grid.columns) {
      const v = crosstabValue(row.cells.get(column), metric);
      if (v !== null) max = Math.max(max, Math.abs(v));
    }
  }
  return max;
}

export async function fetchCrosstab(
  ownerId: string,
  from: string | null,
  to: string | null = null,
  maxColumns: number = MAX_SHOP_COLUMNS,
): Promise<Crosstab> {
  const sales = await fetchSalePnl(ownerId, from, to);
  return buildCrosstab(sales, maxColumns);
}

// ══════════════════════════════════════════════════════════
// FETCHERS
// ══════════════════════════════════════════════════════════

const SALE_PNL_COLUMNS =
  "sale_id, inventory_item_id, sale_date, sourcer_name, sourcer_key, source_key, brand_key, category_key, revenue, fees, costs, cost_basis, net, days_to_sell, days_on_market";

/**
 * Completed sales in the period, from the view.
 *
 * `from`/`to` are yyyy-mm-dd and the range is half-open on `to`, matching every
 * other range in this codebase. `null` on either end means unbounded.
 */
export async function fetchSalePnl(
  ownerId: string,
  from: string | null,
  to: string | null = null,
): Promise<SalePnlRow[]> {
  let q = supabase
    .from("sale_pnl")
    .select(SALE_PNL_COLUMNS)
    .eq("user_id", ownerId);
  if (from) q = q.gte("sale_date", from);
  if (to) q = q.lt("sale_date", to);
  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []) as unknown as SalePnlRow[];
}

/**
 * Inventory bought in the period, plus whether each item has sold.
 *
 * Two queries rather than a join: PostgREST cannot express "has a completed
 * sale" as a filter on the embedded resource without dropping the parent rows
 * we specifically want to keep (the UNSOLD ones). The sold-id set is a second
 * read of one column.
 */
export async function fetchTeamItems(
  ownerId: string,
  from: string | null,
  to: string | null = null,
): Promise<TeamItemRow[]> {
  let q = supabase
    .from("inventory_items")
    .select("id, sourced_by, acquired_price, acquired_date, status")
    .eq("user_id", ownerId);
  if (from) q = q.gte("acquired_date", from);
  if (to) q = q.lt("acquired_date", to);
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data ?? []) as unknown as Array<Omit<TeamItemRow, "sold">>;

  const soldIds = await fetchSoldItemIds(ownerId);
  return rows.map((r) => ({ ...r, sold: soldIds.has(r.id) }));
}

/**
 * Every item id with a completed sale, at any time.
 *
 * Deliberately NOT windowed by the period: an item bought in January and sold
 * in March is sold, and calling it dead capital because the sale fell outside
 * the window would be wrong in the direction that makes someone look bad.
 */
export async function fetchSoldItemIds(ownerId: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("sales")
    .select("inventory_item_id")
    .eq("user_id", ownerId)
    .eq("status", "completed");
  if (error) throw error;
  const rows = (data ?? []) as unknown as Array<{
    inventory_item_id: string | null;
  }>;
  const ids = new Set<string>();
  for (const r of rows) if (r.inventory_item_id) ids.add(r.inventory_item_id);
  return ids;
}

/**
 * Operating expenses in the period.
 *
 * A workspace member CAN read these: flipdesk_expenses carries both the
 * owner-only policy from 00019 and a later `is_workspace_member_with_role(
 * user_id, 'viewer')` policy, checked against the live database rather than
 * inferred from the migration that created the table. This function originally
 * short-circuited on `viewerId !== ownerId` on the strength of 00019 alone,
 * which would have shown every member a confident $0.00 of overhead.
 *
 * The `unavailable` flag survives that correction because the failure it
 * describes is still real, just rarer: if the read is refused for any reason,
 * the card says so instead of printing a zero. A zero and "I could not look"
 * are different answers, and only one of them means the totals tie.
 */
export async function fetchOverhead(
  ownerId: string,
  from: string | null,
  to: string | null = null,
): Promise<{ total: number; unavailable: boolean }> {
  let q = supabase
    .from("flipdesk_expenses")
    .select("amount")
    .eq("user_id", ownerId);
  if (from) q = q.gte("spent_on", from);
  if (to) q = q.lt("spent_on", to);
  const { data, error } = await q;
  // Deliberately not a throw. Overhead is one footer row; losing it should not
  // take the whole scorecard down with it.
  if (error) return { total: 0, unavailable: true };
  const rows = (data ?? []) as unknown as Array<{ amount: number | string }>;
  return { total: sum(rows.map((r) => r.amount)), unavailable: false };
}

/** Everything the scorecard needs, in one call. */
export async function fetchScorecard(
  ownerId: string,
  from: string | null,
  to: string | null = null,
): Promise<Scorecard> {
  const [sales, items, overhead] = await Promise.all([
    fetchSalePnl(ownerId, from, to),
    fetchTeamItems(ownerId, from, to),
    fetchOverhead(ownerId, from, to),
  ]);
  return buildScorecard(sales, items, overhead.total, overhead.unavailable);
}

export const EMPTY_SCORECARD: Scorecard = {
  rows: [],
  totals: {
    itemsBought: 0,
    spend: 0,
    itemsSold: 0,
    revenue: 0,
    net: 0,
    returnMultiple: null,
    avgDaysToSell: null,
    sellThrough: null,
    unsoldValue: 0,
    unsoldCount: 0,
  },
  overhead: 0,
  overheadUnavailable: false,
};

// ══════════════════════════════════════════════════════════
// SORTING
// ══════════════════════════════════════════════════════════

export type ScorecardSortKey =
  | "person"
  | "itemsBought"
  | "spend"
  | "itemsSold"
  | "revenue"
  | "net"
  | "returnMultiple"
  | "avgDaysToSell"
  | "sellThrough"
  | "unsoldValue";

/**
 * Sort the rows, with nulls always LAST regardless of direction.
 *
 * A null here means "not applicable" (no spend, so no multiple), not "zero".
 * Letting it sort as 0 would put every person who bought nothing at the top of
 * an ascending sort on return multiple, which reads as the worst performers.
 */
export function sortScorecard(
  rows: ScorecardRow[],
  key: ScorecardSortKey,
  dir: "asc" | "desc",
): ScorecardRow[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (key === "person") return sign * a.person.localeCompare(b.person);
    const av = a[key];
    const bv = b[key];
    if (av === null && bv === null) return a.person.localeCompare(b.person);
    if (av === null) return 1;
    if (bv === null) return -1;
    if (av === bv) return a.person.localeCompare(b.person);
    return sign * (av - bv);
  });
}
