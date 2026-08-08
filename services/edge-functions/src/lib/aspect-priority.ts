// US-2420: which of a category's item-specifics the AI is allowed to see, and
// in what order.
//
// eBay hands back every aspect a leaf category defines — often 40-60 of them.
// The tool schema we build from that list is sent on every generation call, so
// it has always been capped. What the cap dropped was decided by eBay's USAGE
// TIER: required first, then RECOMMENDED, then OPTIONAL. That sort is why
// Theme, Accents, Occasion, Character and Product Line came back empty on
// basically every listing — they sit in the OPTIONAL tier, so they were sliced
// off before the model was ever asked about them, regardless of how many buyers
// filter on them.
//
// The usage tier is eBay's advice to SELLERS. The number that actually predicts
// whether a buyer will filter on an aspect is in the same payload:
// `relevanceIndicator.searchCount`, eBay's own 30-day search volume for that
// aspect in that category. aspect-provenance.ts already reads it to rank the
// seller-facing "missing specifics" list. This module makes the AI see the same
// ordering, so the cap now drops the aspects nobody searches instead of the
// aspects that happen to be tier-3.
//
// Both spec-building paths (lib/ai-listing.ts buildAspectSpecsForCategory and
// routes/flipdesk-ai.ts toAspectSpecs + prioritizeAspects) consume the caps and
// the sort from here. They previously carried DIFFERENT limits — 35 aspects /
// 80 values on the AutoLister path versus 30 / 200 on the one-item path — so
// the same garment could fill a specific from the item page and not from a bulk
// run, with nothing in the UI to explain the difference.

/**
 * Maximum aspects included in the extraction tool schema.
 *
 * Every aspect is one property (name, mode, cardinality and up to
 * MAX_ALLOWED_VALUES_PER_ASPECT enum values), so this trades request tokens for
 * coverage. 45 covers the full spec of most apparel/footwear leaves; the tail
 * beyond it is near-zero-search-volume aspects once the demand sort below has
 * run.
 */
export const MAX_AI_ASPECTS = 45;

/**
 * Maximum allowed values sent per SELECTION_ONLY / SUGGESTED aspect.
 *
 * The values are an enum constraint on the tool schema — a value that isn't
 * here CANNOT be chosen by the model, and extractEbayAspects drops it as a
 * final safety net. Truncating too hard silently makes a legitimate value
 * unpickable (eBay returns them in its own order, not by popularity), so this
 * sits well above the old 80.
 */
export const MAX_ALLOWED_VALUES_PER_ASPECT = 150;

/** The fields of eBay's raw aspect payload this module ranks on. */
export interface RankableRawAspect {
  localizedAspectName?: string;
  aspectConstraint?: {
    aspectRequired?: boolean;
    /** "REQUIRED" | "RECOMMENDED" | "OPTIONAL". */
    aspectUsage?: string;
  };
  /** eBay's 30-day buyer-search volume for this aspect in this category. */
  relevanceIndicator?: { searchCount?: number };
}

/** The minimum a spec must expose to be ranked. */
export interface RankableSpec {
  name: string;
  required: boolean;
}

/**
 * Order specs by what a buyer is most likely to filter on, then cap.
 *
 * Ordering:
 *  1. Every REQUIRED aspect, in eBay's own order. These are never dropped —
 *     a missing required aspect blocks the publish outright (see
 *     requiredMissingAspects in aspect-provenance.ts), so trading one away for
 *     an optional aspect is never the right call.
 *  2. Everything else by `relevanceIndicator.searchCount` descending.
 *  3. Ties broken RECOMMENDED before OPTIONAL, then by name, so the schema (and
 *     therefore the prompt, and therefore the cache key) is deterministic for a
 *     given category.
 *
 * `cap` bounds the RESULT, but only the non-required tail is ever cut: a
 * category with more required aspects than the cap returns all of them rather
 * than a listing that cannot publish.
 */
export function prioritizeByDemand<T extends RankableSpec>(
  specs: T[],
  rawAspects: unknown,
  cap: number = MAX_AI_ASPECTS,
): T[] {
  const list = Array.isArray(rawAspects) ? (rawAspects as RankableRawAspect[]) : [];
  const searchCountByName = new Map<string, number>();
  const usageByName = new Map<string, string>();
  for (const a of list) {
    const name = typeof a.localizedAspectName === "string" ? a.localizedAspectName : "";
    if (!name) continue;
    const count = Number(a.relevanceIndicator?.searchCount);
    searchCountByName.set(name, Number.isFinite(count) ? count : 0);
    usageByName.set(name, (a.aspectConstraint?.aspectUsage ?? "OPTIONAL").toUpperCase());
  }

  const required = specs.filter((s) => s.required);
  const rest = specs
    .filter((s) => !s.required)
    .map((s, i) => ({
      spec: s,
      // Original position keeps the sort stable across engines when every
      // other key ties (e.g. a category eBay reports no search counts for).
      index: i,
      count: searchCountByName.get(s.name) ?? 0,
      recommended: usageByName.get(s.name) === "RECOMMENDED" ? 0 : 1,
    }))
    .sort(
      (a, b) =>
        b.count - a.count ||
        a.recommended - b.recommended ||
        a.spec.name.localeCompare(b.spec.name) ||
        a.index - b.index,
    )
    .map((e) => e.spec);

  const room = Math.max(0, cap - required.length);
  return [...required, ...rest.slice(0, room)];
}
