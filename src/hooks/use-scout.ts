import { useMutation } from "@tanstack/react-query";
import { toastError } from "@/lib/toast-error";
import { edgeFetch } from "@/lib/edge-fetch";
import type { ValueBasis } from "@/components/value/value-basis-note";

// ScoutAI sourcing (US-618). A scan grades candidate eBay listings from their own
// photos (private shadow grade) and ranks them by condition-adjusted margin.

export interface ScoutScored {
  itemId: string;
  title: string;
  imageUrl: string | null;
  itemWebUrl: string | null;
  askingCents: number | null;
  shadowGrade: number | null;
  gradeConfidence: number;
  valueLowCents: number | null;
  valueMedianCents: number | null;
  valueHighCents: number | null;
  /** US-2850: what the estimated value is. Absent on an older edge response. */
  valueBasis?: ValueBasis;
  estMarginCents: number | null;
  estMarginPct: number | null;
  underpriced: boolean;
  actionable: boolean;
  reason: string;
  /** US-3098: what the buyer pays, shipping included when eBay stated it. */
  totalCents?: number | null;
  /** False when shipping was unknown, so `totalCents` is asking alone. */
  totalIncludesShipping?: boolean;
  /**
   * US-3098: the most to pay and still clear the seller's target return.
   * Absent, never guessed — `absentReason` says why when there is none.
   */
  ceiling?: {
    maxPriceCents: number | null;
    targetRoi: number;
    netResaleCents: number | null;
    absentReason: string | null;
  };
}

export interface ScoutScanResult {
  scanned: number;
  candidates: ScoutScored[];
  disclaimer?: string;
  note?: string;
  /**
   * US-3098: how many listings phase one looked at, before any AI was spent.
   *
   * The denominator. Eight results with no denominator is a scan a seller
   * cannot judge — "looked at 42, graded 8" is one they can.
   */
  considered?: number;
  /** How many phase two actually shadow-graded. Equals `scanned`. */
  graded?: number;
  /**
   * SRC-3: the AI cap stopped the scan early. An empty list with this set is
   * "you ran out of actions", not "nothing matched".
   */
  capReached?: boolean;
  /** How many listings phase two meant to grade. */
  queued?: number;
  /** Grades that failed and were refunded. */
  failed?: number;
  /** SRC-7: rows scored from an earlier scan's grade, with no AI spent. */
  cachedGrades?: number;
}

/** SRC-3: the most AI actions one scan can use (MAX_CANDIDATES on the edge). */
export const SCOUT_MAX_AI_ACTIONS = 8;

/** US-3098: eBay's three buying options, as the route validates them. */
export type ScoutBuyingOption = "FIXED_PRICE" | "AUCTION" | "BEST_OFFER";

/** US-3098: the sorts a scan can ask for. `bestMatch` is eBay relevance. */
export type ScoutSort = "bestMatch" | "newlyListed" | "endingSoonest" | "priceAsc";

export interface ScoutScanInput {
  categoryId: string;
  q?: string;
  brand?: string;
  limit?: number;
  // US-3098: the deal filter. Every field optional; omitting all of them is
  // exactly the scan this endpoint ran before.
  minMarginCents?: number;
  /** A FRACTION: 0.3 is thirty percent. The route refuses 30. */
  minMarginPct?: number;
  /** Asking plus shipping, in cents. */
  maxTotalCents?: number;
  buyingOptions?: ScoutBuyingOption[];
  conditionIds?: string[];
  freeShippingOnly?: boolean;
  sort?: ScoutSort;
}

export function useScoutScan() {
  return useMutation<ScoutScanResult, Error, ScoutScanInput>({
    mutationFn: async (input) => {
      const res = await edgeFetch("/api/flipdesk/scout", {
        method: "POST",
        json: input,
      });
      const data = (await res.json().catch(() => ({}))) as
        & Partial<ScoutScanResult>
        & { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Scout scan failed");
      return {
        scanned: data.scanned ?? 0,
        candidates: data.candidates ?? [],
        disclaimer: data.disclaimer,
        note: data.note,
        considered: data.considered,
        graded: data.graded,
        capReached: data.capReached,
        queued: data.queued,
        failed: data.failed,
        cachedGrades: data.cachedGrades,
      };
    },
    // SRC-3: no success toast. The results render inline right under the
    // button, and a toast saying the same thing covers them on a phone.
    onError: (err) => toastError(err),
  });
}
