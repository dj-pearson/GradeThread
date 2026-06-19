import { supabaseAdmin } from "./supabase.ts";

// US-976: "State of Resale Condition" — a PUBLIC, aggregate-only data report on
// how a garment's condition grade relates to real-world resale outcomes:
// return rate by grade band, sell-through by grade band, and median resale
// price by grade band. Same safety contract as computePublicTransparency: only
// platform-wide counts and rates leave this function — NO per-user, per-item,
// or per-tenant row ever does. This is the strongest GEO lever: original,
// citable statistics that AI answer engines quote BY NAME.
//
// It deliberately crosses tenants: the edge calls it with the service-role
// client (which BYPASSES RLS), so items_full — a security_invoker view — is
// read across every workspace. That is the intended platform aggregate, NOT a
// tenant leak (US-268): the output is rates and counts, never identifying rows,
// and every published rate is gated behind a minimum sample so a thinly-sampled
// band can't expose, or be distorted by, a single seller.
//
// Honesty rule (matches the brand + the transparency report): when a band has
// too little data to state a rate truthfully, the field is null and the page
// says "not enough data yet" rather than printing a misleading number.

// A band needs at least this many observations before we publish its rate.
export const RESALE_MIN_SAMPLE = 25;
// Bounds cost as volume grows; the page states the actual sample size so the
// cap is truthful ("the most recent N sales and listings"). At launch this is
// every qualifying row.
const SCAN_CAP = 50_000;

export type ResaleBandKey = "high" | "mid" | "low" | "ungraded";

export interface ResaleConditionBand {
  key: ResaleBandKey;
  label: string;
  // Return signal: a "fulfilled" sale is one that shipped (sale_status in
  // completed/refunded); a "return" is a refunded sale (the mechanical proxy
  // the eBay sync stamps from a FULLY_REFUNDED order). Rate is null until the
  // band clears RESALE_MIN_SAMPLE.
  fulfilled_sales: number;
  returns: number;
  return_rate: number | null;
  // Sell-through: "listed" = the item has a list_date; "sold" = it has a
  // sale_date. Rate null until the band has enough listed items.
  listed: number;
  sold: number;
  sell_through: number | null;
  median_days_to_sell: number | null;
  // Resale value (a sold-comp proxy): median sale_price among the band's sold
  // items, in the listing currency's major units. Null until the band clears
  // the sample bar.
  median_sale_price: number | null;
}

export interface ResaleRollup {
  fulfilled_sales: number;
  returns: number;
  return_rate: number | null;
}

export interface ResaleConditionReport {
  generated_at: string;
  scale: { min: number; max: number; increment: number };
  // Sample sizes behind the report — stated on the page for honesty + citation.
  sample: {
    fulfilled_sales: number;
    listed_items: number;
    priced_sales: number;
  };
  // Coverage window (ISO date strings; null when there's no data yet).
  coverage: {
    sales_from: string | null;
    sales_to: string | null;
    listings_from: string | null;
    listings_to: string | null;
  };
  // Headline rollup: graded vs ungraded vs overall return rate.
  return_rollup: {
    graded: ResaleRollup;
    ungraded: ResaleRollup;
    overall: ResaleRollup;
  };
  bands: ResaleConditionBand[];
}

// The minimal row shape we aggregate. Deliberately free of any identifying
// column (no user_id, no item id, no titles) — only the grading + outcome facts.
export interface ResaleConditionRow {
  grade_value: number | null;
  sale_status: string | null;
  sale_date: string | null;
  sold_at_raw: string | null;
  list_date: string | null;
  days_to_sell: number | null;
  sale_price: number | null;
}

// Worst-grade-last so the published table reads top (best condition) to bottom.
const BAND_ORDER: Array<{ key: ResaleBandKey; label: string }> = [
  { key: "high", label: "Graded 8.5 – 10.0" },
  { key: "mid", label: "Graded 6.5 – 8.0" },
  { key: "low", label: "Graded 6.0 or lower" },
  { key: "ungraded", label: "Ungraded" },
];

// Grade-band classification — mirrors flipdesk_return_reduction (migration
// 00168) so this public report and the per-seller dashboard bucket identically.
export function bandForGrade(grade: number | null): ResaleBandKey {
  if (grade === null || grade === undefined || !Number.isFinite(grade)) {
    return "ungraded";
  }
  if (grade <= 6) return "low";
  if (grade <= 8) return "mid";
  return "high";
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

function publishedRate(
  numerator: number,
  denominator: number,
  minSample: number,
): number | null {
  return denominator >= minSample ? numerator / denominator : null;
}

function dateRange(dates: string[]): { from: string | null; to: string | null } {
  if (dates.length === 0) return { from: null, to: null };
  const sorted = [...dates].sort();
  return { from: sorted[0] ?? null, to: sorted[sorted.length - 1] ?? null };
}

interface BandAcc {
  fulfilled: number;
  returns: number;
  listed: number;
  sold: number;
  daysToSell: number[];
  salePrices: number[];
}

/**
 * Pure, deterministic aggregation — exported for unit testing. Buckets the raw
 * rows into grade bands and computes the published, sample-gated statistics.
 * Reproducible: the same rows + the same minSample always yield the same report
 * (apart from generated_at, which the async wrapper stamps).
 */
export function buildResaleConditionReport(
  rows: ResaleConditionRow[],
  minSample: number = RESALE_MIN_SAMPLE,
): Omit<ResaleConditionReport, "generated_at"> {
  const emptyAcc = (): BandAcc => ({
    fulfilled: 0,
    returns: 0,
    listed: 0,
    sold: 0,
    daysToSell: [],
    salePrices: [],
  });
  const byBand = new Map<ResaleBandKey, BandAcc>();
  for (const b of BAND_ORDER) byBand.set(b.key, emptyAcc());

  const saleDates: string[] = [];
  const listDates: string[] = [];

  for (const r of rows) {
    const acc = byBand.get(bandForGrade(r.grade_value))!;
    const fulfilled = r.sale_status === "completed" || r.sale_status === "refunded";
    if (fulfilled) {
      acc.fulfilled++;
      if (r.sale_status === "refunded") acc.returns++;
    }
    if (r.list_date) {
      acc.listed++;
      listDates.push(r.list_date);
    }
    if (r.sale_date) {
      acc.sold++;
      saleDates.push(r.sale_date ?? r.sold_at_raw ?? "");
      if (typeof r.days_to_sell === "number" && Number.isFinite(r.days_to_sell)) {
        acc.daysToSell.push(r.days_to_sell);
      }
    }
    if (typeof r.sale_price === "number" && Number.isFinite(r.sale_price)) {
      acc.salePrices.push(r.sale_price);
    }
  }

  const bands: ResaleConditionBand[] = BAND_ORDER.map(({ key, label }) => {
    const a = byBand.get(key)!;
    return {
      key,
      label,
      fulfilled_sales: a.fulfilled,
      returns: a.returns,
      return_rate: publishedRate(a.returns, a.fulfilled, minSample),
      listed: a.listed,
      sold: a.sold,
      sell_through: publishedRate(a.sold, a.listed, minSample),
      median_days_to_sell: a.sold >= minSample ? median(a.daysToSell) : null,
      median_sale_price: a.salePrices.length >= minSample ? median(a.salePrices) : null,
    };
  });

  // Rollups: graded = high + mid + low; ungraded = the ungraded band; overall =
  // everything. Computed from the band accumulators so they always reconcile.
  const sum = (keys: ResaleBandKey[]) => {
    let fulfilled = 0;
    let returns = 0;
    for (const k of keys) {
      const a = byBand.get(k)!;
      fulfilled += a.fulfilled;
      returns += a.returns;
    }
    return { fulfilled, returns };
  };
  const graded = sum(["high", "mid", "low"]);
  const ungraded = sum(["ungraded"]);
  const overall = sum(["high", "mid", "low", "ungraded"]);

  const sales = dateRange(saleDates.filter((d) => d.length > 0));
  const listings = dateRange(listDates);

  return {
    scale: { min: 1, max: 10, increment: 0.5 },
    sample: {
      fulfilled_sales: overall.fulfilled,
      listed_items: bands.reduce((n, b) => n + b.listed, 0),
      priced_sales: [...byBand.values()].reduce((n, a) => n + a.salePrices.length, 0),
    },
    coverage: {
      sales_from: sales.from,
      sales_to: sales.to,
      listings_from: listings.from,
      listings_to: listings.to,
    },
    return_rollup: {
      graded: {
        fulfilled_sales: graded.fulfilled,
        returns: graded.returns,
        return_rate: publishedRate(graded.returns, graded.fulfilled, minSample),
      },
      ungraded: {
        fulfilled_sales: ungraded.fulfilled,
        returns: ungraded.returns,
        return_rate: publishedRate(ungraded.returns, ungraded.fulfilled, minSample),
      },
      overall: {
        fulfilled_sales: overall.fulfilled,
        returns: overall.returns,
        return_rate: publishedRate(overall.returns, overall.fulfilled, minSample),
      },
    },
    bands,
  };
}

/**
 * Build the public "State of Resale Condition" report. Aggregate-only and safe
 * to expose unauthenticated. Callers should cache it (it scans items_full) —
 * see routes/public-grading.ts.
 *
 * Reproducible aggregation (AC4): one bounded scan of items_full (the canonical
 * grading + sales/listing fact view) → buildResaleConditionReport(). It reads
 * across tenants by design (service-role bypasses RLS) to produce the platform
 * aggregate; the output carries no per-tenant data.
 */
export async function computeResaleConditionReport(): Promise<ResaleConditionReport> {
  const { data, error } = await supabaseAdmin
    .from("items_full")
    .select(
      "grade_value, sale_status, sale_date, sold_at_raw, list_date, days_to_sell, sale_price",
    )
    // Only items that have entered the market (listed and/or sold) carry any
    // resale signal; everything else is noise for this report.
    .or("list_date.not.is.null,sale_date.not.is.null")
    .order("created_at", { ascending: false })
    .limit(SCAN_CAP);

  if (error) {
    throw new Error(`Failed to load resale-condition rows: ${error.message}`);
  }

  const rows = (data ?? []) as ResaleConditionRow[];
  return {
    generated_at: new Date().toISOString(),
    ...buildResaleConditionReport(rows),
  };
}
