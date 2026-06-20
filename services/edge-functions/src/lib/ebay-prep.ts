// US-826: pure persistence-decision helpers for the one-call eBay listing prep.
//
// The /api/flipdesk/ai/extract route (flipdesk-ai.ts runEbayAspectsPhase)
// resolves an eBay leaf category, then fills that category's item-specifics with
// a second model pass. Several outcomes are possible; each persists a DIFFERENT
// shape onto inventory_items. Keeping that mapping pure (no supabase / no env)
// makes the partial-failure behaviour unit-testable — see ebay-prep_test.ts.
//
// The contract AC3 hardens: when the category resolves but aspects CANNOT be
// filled (AI budget exhausted, or the aspect extraction errored), we still
// persist ebay_category_id and FLAG the item (ebay_aspects_refill_needed=true)
// so the specifics editor / publish-prep deterministically refills aspects with
// NO further AI call. A fully-filled or no-aspects-needed category clears the
// flag.

/** Why the aspects pass produced the result it did. */
export type EbayPrepStatus =
  // Category resolved; the category exposes no fillable item-specifics — there
  // is nothing left to do, so this is a COMPLETE prep (no refill).
  | "no_specs"
  // Category resolved; the second AI action could not be reserved (monthly cap
  // hit). Aspects deferred to deterministic refill.
  | "budget_exhausted"
  // Category resolved; the aspect-extraction model call threw. Aspects deferred
  // to deterministic refill.
  | "extraction_failed"
  // Category resolved AND aspects filled + merged. Complete.
  | "filled";

/** The inventory_items column patch for a given prep status. */
export interface EbayPrepUpdate {
  ebay_category_id: string;
  ebay_aspects?: Record<string, string[]>;
  ai_generated_aspects_at?: string;
  ebay_aspects_refill_needed: boolean;
}

/**
 * Build the inventory_items update for a one-call eBay prep outcome.
 *
 * - `filled`          → persist merged aspects + timestamp, clear the flag.
 * - `no_specs`        → persist category only, clear the flag (complete).
 * - `budget_exhausted`/`extraction_failed` → persist category only, SET the
 *   flag so a later deterministic (non-AI) refill kicks in.
 */
export function buildEbayPrepUpdate(args: {
  categoryId: string;
  status: EbayPrepStatus;
  mergedAspects?: Record<string, string[]>;
  now?: string;
}): EbayPrepUpdate {
  const { categoryId, status, mergedAspects, now } = args;
  if (status === "filled") {
    return {
      ebay_category_id: categoryId,
      ebay_aspects: mergedAspects ?? {},
      ai_generated_aspects_at: now ?? new Date().toISOString(),
      ebay_aspects_refill_needed: false,
    };
  }
  return {
    ebay_category_id: categoryId,
    ebay_aspects_refill_needed:
      status === "budget_exhausted" || status === "extraction_failed",
  };
}

/** True when this outcome left aspects unfilled and needs deterministic refill. */
export function isPartialEbayPrep(status: EbayPrepStatus): boolean {
  return status === "budget_exhausted" || status === "extraction_failed";
}
