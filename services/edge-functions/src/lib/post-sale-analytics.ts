// US-2936: return outcomes measured against the grade we assigned.
//
// This is the analysis no other reseller tool can run, and it did not exist:
// every marketplace shows a seller their return RATE, and none of them knows
// what condition the item was in when it went out, because none of them graded
// it. FlipDesk does. The interesting slice is not "your return rate is 6%", it
// is "your return rate on items where you disclosed a defect is 3%, and on
// items where you disclosed none it is 11%".
//
// ── THE DENOMINATOR IS THE WHOLE POINT ──────────────────────────────────────
//
// A rate with no denominator is a number a seller cannot act on. Three returns
// out of four sales and three out of three hundred are the same numerator and
// opposite businesses. Every slice here carries its `sales` count, and a slice
// under MIN_SALES_FOR_RATE reports `rate: null` rather than a percentage —
// because 1 return in 2 sales is not a 50% return rate, it is noise.
//
// Pure. The loader that feeds it lives in the route; everything here is a
// function of its inputs so the arithmetic is testable without a database.

/** Below this many sales, a rate is noise and is reported as unknown. */
export const MIN_SALES_FOR_RATE = 8;

export interface AnalyticsCase {
  caseType: string;
  reason: string | null;
  inventoryItemId: string | null;
  /** Terminal state, for days-to-resolve. Null while still open. */
  openedAt: string | null;
  closedAt: string | null;
}

export interface AnalyticsSale {
  inventoryItemId: string | null;
  brand: string | null;
  category: string | null;
  /** The assigned overall grade, when the item was graded here. */
  grade: number | null;
  /** How many defects the grade report recorded and the listing disclosed. */
  disclosedDefects: number | null;
}

export interface Slice {
  key: string;
  sales: number;
  returns: number;
  snad: number;
  /** null when `sales` is under MIN_SALES_FOR_RATE. */
  rate: number | null;
  snadShare: number | null;
  avgDaysToResolve: number | null;
}

/**
 * Which reasons count as "not as described".
 *
 * Deliberately the same vocabulary as the frontend's isNotAsDescribed, and
 * deliberately a second implementation: the edge is a separate Deno project and
 * cannot import from src/. The parity that matters is the WORD LIST, and a
 * guard test pins it.
 */
export const SNAD_MARKERS = [
  "NOT_AS_DESCRIBED",
  "NOTASDESCRIBED",
  "SNAD",
  "DEFECT",
  "DAMAGED",
  "WRONG_ITEM",
  "MISSING_PARTS",
  "AUTHENTICITY",
  "COUNTERFEIT",
] as const;

export function isSnadReason(reason: string | null | undefined): boolean {
  const raw = (reason ?? "").toUpperCase();
  if (!raw) return false;
  return SNAD_MARKERS.some((m) => raw.includes(m));
}

/** Whole days between two ISO timestamps, or null if either is unreadable. */
function daysBetween(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Grade bands, because a rate per 0.1 grade step is 90 slices of two sales each.
 *
 * The band edges are the tier boundaries the grading system already uses, so a
 * seller reading "8.0-8.9" is reading the same thing the certificate says.
 */
export function gradeBand(grade: number | null): string | null {
  if (grade == null || !Number.isFinite(grade)) return null;
  if (grade >= 10) return "10 (NWT)";
  const floor = Math.floor(grade);
  return `${floor}.0-${floor}.9`;
}

function buildSlice(
  key: string,
  sales: AnalyticsSale[],
  casesByItem: Map<string, AnalyticsCase[]>,
): Slice {
  let returns = 0;
  let snad = 0;
  const resolveDays: number[] = [];
  for (const sale of sales) {
    if (!sale.inventoryItemId) continue;
    const cases = casesByItem.get(sale.inventoryItemId);
    if (!cases || cases.length === 0) continue;
    // One sale counts ONCE however many cases it produced. A buyer who opens a
    // return, escalates it to a case and files a dispute has not returned three
    // garments, and counting the cases would put the rate over 100%.
    returns++;
    if (cases.some((c) => isSnadReason(c.reason))) snad++;
    for (const c of cases) {
      const d = daysBetween(c.openedAt, c.closedAt);
      if (d != null) resolveDays.push(d);
    }
  }
  const enough = sales.length >= MIN_SALES_FOR_RATE;
  return {
    key,
    sales: sales.length,
    returns,
    snad,
    rate: enough ? returns / sales.length : null,
    snadShare: enough && returns > 0 ? snad / returns : null,
    avgDaysToResolve: resolveDays.length > 0
      ? Math.round(resolveDays.reduce((a, b) => a + b, 0) / resolveDays.length)
      : null,
  };
}

export interface ReturnAnalytics {
  overall: Slice;
  byBrand: Slice[];
  byCategory: Slice[];
  byGradeBand: Slice[];
  /**
   * The comparison a seller actually wants: did disclosing the flaw help?
   *
   * Two slices only — disclosed at least one defect, and disclosed none. Items
   * with no grade report are in NEITHER, because "we do not know what was
   * disclosed" is not the same as "nothing was".
   */
  byDisclosure: Slice[];
}

/**
 * Compute every slice. Pure.
 *
 * `sales` is the denominator set — every sale in the window — and `cases` is
 * what happened to some of them. A case whose item is not in `sales` is
 * ignored rather than counted: it belongs to an earlier window, and counting it
 * would produce a rate above 100% on a slow month.
 */
export function summarizeReturns(
  sales: AnalyticsSale[],
  cases: AnalyticsCase[],
): ReturnAnalytics {
  const casesByItem = new Map<string, AnalyticsCase[]>();
  for (const c of cases) {
    if (!c.inventoryItemId) continue;
    const list = casesByItem.get(c.inventoryItemId);
    if (list) list.push(c);
    else casesByItem.set(c.inventoryItemId, [c]);
  }

  const group = (keyOf: (s: AnalyticsSale) => string | null): Slice[] => {
    const buckets = new Map<string, AnalyticsSale[]>();
    for (const s of sales) {
      const key = keyOf(s);
      if (key == null) continue;
      const list = buckets.get(key);
      if (list) list.push(s);
      else buckets.set(key, [s]);
    }
    return [...buckets.entries()]
      .map(([key, group]) => buildSlice(key, group, casesByItem))
      // Worst rate first, and slices with no rate last — a seller opens this to
      // find the problem, not to read an alphabet.
      .sort((a, b) => {
        if (a.rate == null && b.rate == null) return b.sales - a.sales;
        if (a.rate == null) return 1;
        if (b.rate == null) return -1;
        return b.rate - a.rate;
      });
  };

  return {
    overall: buildSlice("all", sales, casesByItem),
    byBrand: group((s) => s.brand?.trim() || null),
    byCategory: group((s) => s.category?.trim() || null),
    byGradeBand: group((s) => gradeBand(s.grade)),
    byDisclosure: group((s) =>
      s.disclosedDefects == null
        ? null
        : s.disclosedDefects > 0
        ? "Defect disclosed"
        : "No defect disclosed"
    ),
  };
}
