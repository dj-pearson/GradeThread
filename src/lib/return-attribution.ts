// US-2823: what predicts a return, past the grade band.
//
// flipdesk_return_attribution (migration 00655) reports the same fulfilled and
// refunded arithmetic as flipdesk_return_reduction (00168) against the five
// factor scores and against whether a defect was disclosed.
//
// ⚠ isDisclosed() BELOW IS THE SPEC, NOT THE IMPLEMENTATION. The SQL runs the
// same rule and this function exists so the rule is written somewhere a person
// can read and a test can pin. It does NOT prove the SQL agrees with it — only
// calling the RPC does that. Treat a change here as a change that must be made
// in 00655's successor too.

import { supabase } from "@/lib/supabase";

/** Mirrors MIN_RETURN_SAMPLE in flipdesk-returns-analytics.ts. */
export const MIN_ATTRIBUTION_SAMPLE = 10;

export type GradeFactor =
  | "fabric"
  | "structural"
  | "cosmetic"
  | "functional"
  | "odor";

export const FACTOR_LABEL: Record<GradeFactor, string> = {
  fabric: "Fabric condition",
  structural: "Structural integrity",
  cosmetic: "Cosmetic appearance",
  functional: "Functional elements",
  odor: "Odor and cleanliness",
};

export interface FactorBand {
  band: "low" | "mid" | "high" | "ungraded";
  label: string;
  fulfilled: number;
  returns: number;
  /** Null under the sample floor. Never 0 for a thin band. */
  rate: number | null;
}

export interface FactorRow {
  factor: GradeFactor;
  bands: FactorBand[];
}

export interface DefectDisclosureRow {
  defect: string;
  severity: string;
  disclosedCount: number;
  disclosedReturns: number;
  disclosedRate: number | null;
  undisclosedCount: number;
  undisclosedReturns: number;
  undisclosedRate: number | null;
}

export interface ReturnAttribution {
  periodStart: string | null;
  minSample: number;
  overall: { fulfilled: number; returns: number; graded: number };
  factors: FactorRow[];
  defects: DefectDisclosureRow[];
}

export const EMPTY_ATTRIBUTION: ReturnAttribution = {
  periodStart: null,
  minSample: MIN_ATTRIBUTION_SAMPLE,
  overall: { fulfilled: 0, returns: 0, graded: 0 },
  factors: [],
  defects: [],
};

// ─── The disclosure rule ─────────────────────────────────────────

export interface DefectLike {
  defect?: string | null;
  defect_type?: string | null;
}

/**
 * A defect counts as disclosed when the item carries a photo tagged `defect`,
 * or when the listing description contains the defect's own words.
 *
 * A blank needle never counts as a match: an empty string is a substring of
 * everything, so "no defect text" would otherwise read as "disclosed".
 */
export function isDisclosed(
  defect: DefectLike,
  listingDescription: string | null | undefined,
  hasDefectPhoto: boolean,
): boolean {
  if (hasDefectPhoto) return true;
  const haystack = (listingDescription ?? "").toLowerCase();
  if (!haystack) return false;
  const needles = [
    (defect.defect_type ?? "").trim().replace(/_/g, " "),
    (defect.defect ?? "").trim(),
  ].filter((n) => n.length > 0);
  return needles.some((n) => haystack.includes(n.toLowerCase()));
}

// ─── Reading rules ───────────────────────────────────────────────

export interface FactorFinding {
  factor: GradeFactor;
  /** Worst band's return rate divided by the best band's. */
  multiplier: number;
  worstBand: FactorBand;
  bestBand: FactorBand;
}

/**
 * The factor whose low band returns worst relative to its high band.
 *
 * Only bands with a real rate take part: a null rate means "not enough sales",
 * and treating it as 0 would make every thin factor look perfect and win.
 */
export function worstFactor(report: ReturnAttribution): FactorFinding | null {
  let best: FactorFinding | null = null;
  for (const f of report.factors) {
    const rated = f.bands.filter(
      (b) => b.band !== "ungraded" && b.rate != null && Number.isFinite(b.rate),
    );
    if (rated.length < 2) continue;
    const worstBand = rated.reduce((a, b) => (b.rate! > a.rate! ? b : a));
    const bestBand = rated.reduce((a, b) => (b.rate! < a.rate! ? b : a));
    if (bestBand.rate === 0 || worstBand.rate! <= bestBand.rate!) continue;
    const multiplier = worstBand.rate! / bestBand.rate!;
    if (!best || multiplier > best.multiplier) {
      best = { factor: f.factor, multiplier, worstBand, bestBand };
    }
  }
  return best;
}

export interface DisclosureFinding {
  row: DefectDisclosureRow;
  /** Undisclosed rate divided by disclosed rate. */
  multiplier: number;
}

/**
 * The defect where NOT disclosing it costs the most. Both sides need a real
 * rate, so a defect the seller always discloses produces no finding rather
 * than an infinite one.
 */
export function worstUndisclosedDefect(
  report: ReturnAttribution,
): DisclosureFinding | null {
  let best: DisclosureFinding | null = null;
  for (const row of report.defects) {
    if (row.disclosedRate == null || row.undisclosedRate == null) continue;
    if (row.disclosedRate === 0) continue;
    const multiplier = row.undisclosedRate / row.disclosedRate;
    if (multiplier <= 1) continue;
    if (!best || multiplier > best.multiplier) best = { row, multiplier };
  }
  return best;
}

/** True when no factor and no defect produced a finding. */
export function hasNoFindings(report: ReturnAttribution): boolean {
  return worstFactor(report) == null && worstUndisclosedDefect(report) == null;
}

// ─── Fetch ───────────────────────────────────────────────────────

type RpcClient = {
  rpc: (
    fn: "flipdesk_return_attribution",
    args: { p_period_start: string | null },
  ) => Promise<{
    data: ReturnAttribution | null;
    error: { message: string } | null;
  }>;
};

export async function fetchReturnAttribution(
  periodStart: string | null,
): Promise<ReturnAttribution> {
  const client = supabase as unknown as RpcClient;
  const { data, error } = await client.rpc("flipdesk_return_attribution", {
    p_period_start: periodStart,
  });
  if (error) throw new Error(error.message);
  return data ?? EMPTY_ATTRIBUTION;
}
