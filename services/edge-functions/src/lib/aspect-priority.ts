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
//
// MEASURED 2026-09-11 (US-3044). Two of the paragraphs above are true of the
// API contract and false of the data eBay actually sends us:
//
//  1. `relevanceIndicator` is absent from EVERY aspect of EVERY leaf under
//     Clothing, Shoes & Accessories on EBAY_US: 0 of 8,748 aspect rows across
//     all 457 leaves carry a searchCount. So `count` is 0 for everything and
//     the sort below degenerates to required first, then RECOMMENDED before
//     OPTIONAL, then ALPHABETICAL. That is the old usage-tier sort with an
//     alphabetical tail, not a demand rank. Do not describe it as one without
//     re-measuring. On a marketplace or tree that does return the field, this
//     module works exactly as written.
//  2. The cap almost never bites on apparel. Leaves carry a median of 17
//     aspects and a maximum of 46; exactly ONE leaf of 457 (57974, Girls'
//     Shoes) exceeds 45, and Theme survives the cut even there. Cutting
//     MAX_AI_ASPECTS to 24 would still drop no RECOMMENDED aspect from any
//     apparel leaf, which makes the cap a cheap token lever and a useless
//     fill-rate lever.
//
// The census, the arithmetic and a --self-test are in
// scripts/aspect-demand-cut.mjs; src/test/aspect-demand-cut-parity.test.ts
// pins its mirror of prioritizeByDemand to this one. Re-run
// `node scripts/aspect-demand-cut.mjs --refresh` before trusting the numbers
// in a later quarter.

/**
 * Maximum aspects included in the extraction tool schema.
 *
 * Every aspect is one property (name, mode, cardinality and up to
 * MAX_ALLOWED_VALUES_PER_ASPECT enum values), so this trades request tokens for
 * coverage. 45 covers the full spec of most apparel/footwear leaves; the tail
 * beyond it is near-zero-search-volume aspects once the demand sort below has
 * run.
 *
 * "Most" measured 2026-09-11: 456 of the 457 EBAY_US apparel leaves carry 45
 * aspects or fewer, so on this tree the cap is binding on one leaf. See the
 * MEASURED block at the top of this file before spending a story on it.
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
 *
 * RAISED FROM 150 TO 300 (US-3016), on a count rather than a hunch. Reading
 * the 121 cached categories back, exactly three SELECTION_ONLY aspects run
 * past 150: Country of Origin at 244 values in ALL 121 of them, Year
 * Manufactured at 159 in one, and Silhouette at 7,286 in two. The first is
 * the one that mattered. eBay returns countries in its own order, so a
 * 150-value cut removed most of the late alphabet — Vietnam, Thailand,
 * Turkey, Taiwan, Sri Lanka, Portugal, Philippines, Pakistan, Romania,
 * Tunisia, United States — which between them account for most of what a
 * resale seller actually holds. The model was being asked where a garment
 * was made and handed a menu with the answer missing.
 *
 * 300 clears Country of Origin and Year Manufactured outright. Silhouette
 * stays capped and always will: 7,286 values is not an enum anyone can send,
 * and it appears in two categories. The cost is ~94 extra short strings on
 * the categories carrying Country of Origin, a few hundred tokens beside a
 * request that already carries photos.
 */
export const MAX_ALLOWED_VALUES_PER_ASPECT = 300;

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
 * Order specs by eBay's published aspect demand where it exists, then cap.
 *
 * ⚠ THE NAME IS ASPIRATIONAL ON THE TREE THIS PRODUCT ACTUALLY SELLS ON, and
 * US-3346 exists because that was not written down anywhere a caller would see
 * it. On EBAY_US apparel eBay publishes NO demand: `relevanceIndicator` is
 * absent from all 8,748 aspect rows of all 457 leaves under 11450, re-measured
 * 2026-09-11 on the raw response bytes. Step 2 below therefore scores every
 * aspect zero and the real ordering is step 1, then RECOMMENDED before
 * OPTIONAL, then ALPHABETICAL. **This function does not rank by demand here.**
 * It is not renamed because the logic is correct and a marketplace that does
 * send the field gets a genuine demand rank out of it; src/test/
 * aspect-demand-absent.test.ts goes red the day EBAY_US starts sending it.
 *
 * Ordering:
 *  1. Every REQUIRED aspect, in eBay's own order. These are never dropped —
 *     a missing required aspect blocks the publish outright (see
 *     requiredMissingAspects in aspect-provenance.ts), so trading one away for
 *     an optional aspect is never the right call.
 *  2. Everything else by `relevanceIndicator.searchCount` descending. Absent
 *     on US apparel, so in practice a no-op that leaves every aspect tied.
 *  3. Ties broken RECOMMENDED before OPTIONAL, then by name, so the schema (and
 *     therefore the prompt, and therefore the cache key) is deterministic for a
 *     given category. On US apparel this is the WHOLE sort, not a tie-break.
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
