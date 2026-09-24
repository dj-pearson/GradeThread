// Snap-to-Value formatting and input helpers, kept out of the page so they can
// be unit-tested and shared.

import { GRADE_FACTORS, GRADING_REVIEW_CONFIDENCE_THRESHOLD } from "@/lib/constants";
import type { SnapResult, SnapUsage, SnapValue } from "@/hooks/use-snap";
import { ebayNetProceedsCents } from "@/lib/ebay-fees";

// SNAP-08: what Snap sends. The vision model downsamples to about 1568px, 1600
// is still above the certified bridge's 1200px minimum, and JPEG never comes
// back from Safari as a multi-MB PNG.
export const SNAP_COMPRESS = { maxEdge: 1600, quality: 0.82, outputType: "image/jpeg" } as const;
/** The server refuses above 4.5 MB of image; stay well under it. */
export const SNAP_MAX_UPLOAD_BYTES = 4_000_000;
/** Above this a phone is likely to fail decoding the original at all. */
export const SNAP_MAX_SOURCE_BYTES = 40_000_000;

/** Refusals we can name before decoding anything. */
export function snapFileProblem(file: File): string | null {
  const heic = /^image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
  if (heic) {
    return "HEIC photos can't be read here. Choose a JPEG, or set your iPhone camera to Most Compatible (Settings, Camera, Formats).";
  }
  return null;
}

// ── SNAP-11: the result card explains itself ─────────────────────────────────


/** Money in the comp currency. The old helper hardcoded "$". */
export function formatMoney(cents: number, currency = "USD"): string {
  const whole = Math.abs(cents) % 100 === 0;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2,
    }).format(cents / 100);
  } catch {
    // An unknown currency code: say the number and the code plainly.
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export type SnapValueDisplay =
  | { kind: "none" }
  | { kind: "insufficient"; text: string }
  | {
      kind: "priced";
      headline: string;
      range: string;
      comps: string | null;
      category: string | null;
    };

/** The median is the headline; the range and the comp count sit under it. */
export function valueDisplay(value: SnapValue | null | undefined): SnapValueDisplay {
  if (!value) return { kind: "none" };
  const { lowCents: low, highCents: high } = value;
  if (!value.sufficient || low == null || high == null) {
    return { kind: "insufficient", text: "not enough sales to price" };
  }
  const cur = value.currency || "USD";
  const median = value.medianCents ?? Math.round((low + high) / 2);
  const n = Number.isFinite(value.sampleSize) ? Math.max(0, Math.trunc(value.sampleSize)) : 0;
  return {
    kind: "priced",
    headline: formatMoney(median, cur),
    range: `${formatMoney(low, cur)} to ${formatMoney(high, cur)}`,
    comps: n > 0 ? `from ${n} sold comp${n === 1 ? "" : "s"}` : null,
    category: value.category_name ? value.category_name : null,
  };
}

/** Below the human-review bar, or flagged by the grader: say so. */
export function isLowConfidence(grade: SnapResult["grade"]): boolean {
  return grade.confidence < GRADING_REVIEW_CONFIDENCE_THRESHOLD || grade.needs_review === true;
}

export function formatSnapScore(grade: SnapResult["grade"]): string {
  const n = grade.overall_score.toFixed(1);
  return isLowConfidence(grade) ? `~${n}` : n;
}

export interface SnapFactorRow {
  key: string;
  label: string;
  score: number;
}

/** The five factors, weakest first, labeled from GRADE_FACTORS. */
export function weakestFirst(scores: Record<string, number> | null | undefined): SnapFactorRow[] {
  if (!scores) return [];
  return Object.entries(GRADE_FACTORS)
    .filter(([key]) => typeof scores[key] === "number" && Number.isFinite(scores[key]))
    .map(([key, f]) => ({ key, label: f.label, score: scores[key] as number }))
    .sort((a, b) => a.score - b.score);
}

/** "12 of 15 checks left this month", amber at 3 or fewer. null = unlimited or unknown. */
export function usageLine(usage: SnapUsage | null | undefined): { text: string; low: boolean } | null {
  if (!usage || usage.cap == null) return null;
  const left = Math.max(0, usage.cap - usage.used);
  return {
    text: `${left} of ${usage.cap} check${usage.cap === 1 ? "" : "s"} left this month`,
    low: left <= 3,
  };
}

// ── SNAP-14: buy or pass at the price on the tag ─────────────────────────────

/** "8", "$8.50", "8,50" -> cents. null for blank or nonsense. */
export function parsePriceToCents(v: string): number | null {
  const cleaned = v.replace(/[$\s]/g, "").replace(",", ".");
  if (!cleaned) return null;
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const cents = Math.round(Number(cleaned) * 100);
  return Number.isFinite(cents) && cents > 0 ? cents : null;
}

/**
 * The thresholds, stated once. A reseller's rule of thumb is to buy at a third
 * of the sale price or less; the profit floor stops a $2 shirt that "triples"
 * into $4 of profit reading as a buy.
 *  - buy:   median at least 3x the tag price AND at least $10 profit after fees
 *  - pass:  no profit after fees, or the median under 1.5x the tag price
 *  - maybe: everything between
 */
export const BUY_MIN_MULTIPLE = 3;
export const BUY_MIN_PROFIT_CENTS = 1000;
export const PASS_MAX_MULTIPLE = 1.5;

export interface BuyVerdict {
  /** eBay net proceeds at the median, minus the tag price. */
  profitCents: number;
  /** Median over tag price. */
  multiple: number;
  verdict: "buy" | "maybe" | "pass";
}

export function buyVerdict(
  medianCents: number | null | undefined,
  paidCents: number | null | undefined,
): BuyVerdict | null {
  if (medianCents == null || !Number.isFinite(medianCents) || medianCents <= 0) return null;
  if (paidCents == null || !Number.isFinite(paidCents) || paidCents <= 0) return null;
  const profitCents = ebayNetProceedsCents(medianCents) - paidCents;
  const multiple = medianCents / paidCents;
  let verdict: BuyVerdict["verdict"];
  if (profitCents <= 0 || multiple < PASS_MAX_MULTIPLE) verdict = "pass";
  else if (multiple >= BUY_MIN_MULTIPLE && profitCents >= BUY_MIN_PROFIT_CENTS) verdict = "buy";
  else verdict = "maybe";
  return { profitCents, multiple, verdict };
}

/** The most to pay for a 3x margin at the median, rounded down to the cent. */
export function maxPayForMargin(medianCents: number | null | undefined): number | null {
  if (medianCents == null || !Number.isFinite(medianCents) || medianCents <= 0) return null;
  return Math.floor(medianCents / BUY_MIN_MULTIPLE);
}

/**
 * Whether a verdict may be shown at all: only on a real price and a grade the
 * seller can trust. A buy line on a guess is worse than no line.
 */
export function verdictAllowed(result: SnapResult): boolean {
  const v = result.value;
  return !!v && v.sufficient && v.medianCents != null && v.lowCents != null && v.highCents != null &&
    !isLowConfidence(result.grade);
}
