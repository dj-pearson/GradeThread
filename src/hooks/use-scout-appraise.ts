import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import { edgeFetch } from "@/lib/edge-fetch";
import type { ValueBasis } from "@/components/value/value-basis-note";

// Scout buy-decision mode (US-592). A reseller in the field snaps a photo (or
// scans a barcode) of an item they're CONSIDERING and gets an instant buy /
// maybe / skip before purchase — condition signal, condition-adjusted resale
// range, sell-through forecast, and ROI/breakeven at the price they'd pay.

export type BuyRecommendation = "buy" | "maybe" | "skip";

export interface AppraiseGrade {
  value: number | null;
  tier: string | null;
  confidence: number;
  needsHumanReview: boolean;
  imagesAnalyzed: number;
}

export interface AppraiseValue {
  lowCents: number | null;
  medianCents: number | null;
  highCents: number | null;
  sampleSize: number;
  confidence: number;
  sufficient: boolean;
  currency: string;
  /** US-2850: what this range is. Absent on a response from an older edge. */
  basis?: ValueBasis;
}

export interface AppraiseSellThrough {
  sellThroughPct: number;
  daysLow: number;
  daysHigh: number;
  label: "fast" | "moderate" | "slow" | "unknown";
  sampleSize: number;
}

export interface AppraiseDecision {
  recommendation: BuyRecommendation;
  estProceedsCents: number | null;
  estMarginCents: number | null;
  roiPct: number | null;
  breakevenCents: number | null;
  reason: string;
  confident: boolean;
}

/**
 * US-2851: the highest price to pay for this garment at the grade in hand.
 *
 * `maxPriceCents` is null whenever the edge declined to quote one, and
 * `absentReason` says which refusal it was. Absent is a real answer here: a
 * ceiling derived from an unmeasured comp median would be a spending limit
 * built on a price that was never adjusted for condition.
 */
export interface AppraiseCeiling {
  maxPriceCents: number | null;
  targetRoi: number;
  netResaleCents: number | null;
  absentReason: "no_measured_curve" | "insufficient_comps" | "no_headroom" | null;
}

export interface AppraiseResult {
  grade: AppraiseGrade;
  value: AppraiseValue;
  ceiling?: AppraiseCeiling | null;
  sellThrough: AppraiseSellThrough;
  costCents: number | null;
  decision: AppraiseDecision;
  matchedTitle: string | null;
  /**
   * How matchedTitle was arrived at (US-2763). "barcode" pins a manufactured
   * product; "visual" means eBay returned listings that LOOK like the photo.
   */
  identitySource?: "barcode" | "visual" | null;
  /**
   * May matchedTitle be saved without the seller confirming it? Only a barcode
   * may. A visual match is a suggestion, and saving one silently is how a
   * no-name tank ends up named after a Lululemon listing.
   */
  identityIsAuthoritative?: boolean;
  matchedCategoryId: string | null;
  disclaimer?: string;
}

export interface AppraiseInput {
  /** A data: URI of the item photo (optional when a barcode is provided). */
  image?: string;
  barcode?: string;
  q?: string;
  brand?: string;
  categoryId?: string;
  size?: string;
  costCents?: number;
}

export function useScoutAppraise() {
  return useMutation<AppraiseResult, Error, AppraiseInput>({
    mutationFn: async (input) => {
      const res = await edgeFetch("/api/flipdesk/scout/appraise", {
        method: "POST",
        json: input,
      });
      const data = (await res.json().catch(() => ({}))) as
        & Partial<AppraiseResult>
        & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Appraisal failed");
      return data as AppraiseResult;
    },
    onError: (err) => toastError(err),
  });
}

export interface ScoutBuyInput {
  title: string;
  brand?: string;
  size?: string;
  color?: string;
  costCents?: number;
  targetCents?: number;
  gradeValue?: number;
  gradeLabel?: string;
  conditionNotes?: string;
}

export interface ScoutBuyResult {
  id: string;
  status: string;
}

export function useScoutBuy() {
  return useMutation<ScoutBuyResult, Error, ScoutBuyInput>({
    mutationFn: async (input) => {
      const res = await edgeFetch("/api/flipdesk/scout/buy", {
        method: "POST",
        json: input,
      });
      const data = (await res.json().catch(() => ({}))) as
        & Partial<ScoutBuyResult>
        & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not add to inventory");
      return data as ScoutBuyResult;
    },
    onSuccess: () =>
      toast.success("Added to inventory at the “sourced” stage — it's now in your pipeline."),
    onError: (err) => toastError(err),
  });
}
