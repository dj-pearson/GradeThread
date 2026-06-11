// US-473 + US-566: publish pre-flight hardening for eBay.
//
// Two classes of failure used to surface as raw eBay errors (or worse, a 502
// from our own proxy) only AFTER we'd already sent the inventory PUT / publish:
//
//   • too many / duplicate / unreachable images   (eBay error 25601, 25710…)
//   • a condition the leaf category doesn't accept (eBay error 25002/25019…)
//
// These are all knowable BEFORE we call eBay, so we turn them into fixable
// "blockers" the seller can act on. This module is pure (the reachability check
// takes an injected fetcher) so it's fully unit-testable without live calls.

import type { EbayCondition } from "./ai-listing.ts";

// eBay raised the Inventory-API picture cap to 24 (the old 12-image gallery cap
// was Trading-API-era). We honour the real, current limit. Sending more returns
// error 25601 ("The size for ImageLinks cannot exceed…").
export const EBAY_MAX_IMAGES = 24;

export interface ImageCapResult {
  /** De-duplicated, order-preserved URLs, capped to the limit. */
  urls: string[];
  /** Count of duplicate URLs removed before capping. */
  duplicatesRemoved: number;
  /** Count of URLs dropped because the list exceeded the cap (after de-dup). */
  dropped: number;
}

/**
 * De-dup (re-uploads can share a URL), drop empties, preserve order (photos
 * arrive sorted by sort_order so the cover + best shots survive the cap), and
 * cap to eBay's image limit. Reports how many were de-duped vs dropped so the
 * caller can decide whether to warn or block.
 */
export function dedupeAndCapImages(
  urls: Array<string | null | undefined>,
  max: number = EBAY_MAX_IMAGES,
): ImageCapResult {
  const cleaned = urls.filter((u): u is string => !!u && u.trim() !== "");
  const deduped = [...new Set(cleaned)];
  const duplicatesRemoved = cleaned.length - deduped.length;
  const capped = deduped.slice(0, max);
  return {
    urls: capped,
    duplicatesRemoved,
    dropped: deduped.length - capped.length,
  };
}

/**
 * Turn an over-the-cap photo set into a fixable blocker. Returns null when the
 * set fits (≤ max unique images) — duplicates alone are silently de-duped, not
 * blocked. Over-cap is blocked (rather than silently dropping) so a seller
 * never loses a defect shot they intended to publish without knowing.
 */
export function imageCapBlocker(
  result: ImageCapResult,
  max: number = EBAY_MAX_IMAGES,
): string | null {
  if (result.dropped <= 0) return null;
  const total = result.urls.length + result.dropped;
  return (
    `You have ${total} photos but eBay allows ${max}. ` +
    `Remove ${result.dropped} photo${result.dropped === 1 ? "" : "s"} ` +
    `(lowest-priority shots) to publish.`
  );
}

// ── Condition validation against the leaf category ─────────────────────
//
// The Inventory API takes a symbolic condition enum (NEW, USED_EXCELLENT…) but
// eBay's Taxonomy "get_item_condition_policies" returns the numeric conditionId
// allow-list per category. This is the canonical enum→id mapping eBay publishes
// for the Inventory API. Some leaves (vintage, collectibles, designer) restrict
// the set, so we validate against the category's allow-list before publishing.
export const CONDITION_ENUM_TO_ID: Record<EbayCondition, string> = {
  NEW: "1000",
  LIKE_NEW: "2750",
  USED_EXCELLENT: "3000",
  USED_VERY_GOOD: "4000",
  USED_GOOD: "5000",
  USED_ACCEPTABLE: "6000",
  FOR_PARTS_OR_NOT_WORKING: "7000",
};

// Human labels for eBay conditionIds, used to phrase the blocker's "allowed
// conditions" hint. Covers the ids a clothing/general-merchandise seller will
// actually see returned by the policies API.
const CONDITION_ID_LABEL: Record<string, string> = {
  "1000": "New",
  "1500": "New other",
  "1750": "New with defects",
  "2000": "Certified refurbished",
  "2010": "Excellent refurbished",
  "2020": "Very good refurbished",
  "2030": "Good refurbished",
  "2500": "Seller refurbished",
  "2750": "Like new",
  "3000": "Used / pre-owned",
  "4000": "Very good",
  "5000": "Good",
  "6000": "Acceptable",
  "7000": "For parts or not working",
};

function labelForConditionId(id: string): string {
  return CONDITION_ID_LABEL[id] ?? `Condition ${id}`;
}

/**
 * Validate a chosen condition enum against the category's allowed conditionIds.
 * Returns a fixable blocker string, or null when valid / unknowable.
 *
 *  • Empty/unknown allow-list → null (don't block on missing policy data; many
 *    categories return no restriction and accept the default set).
 *  • Mapped id present in the allow-list → null (valid).
 *  • Otherwise → a blocker naming the conditions the category DOES accept.
 */
export function validateConditionForCategory(
  conditionEnum: string,
  allowedConditionIds: string[],
): string | null {
  if (!allowedConditionIds || allowedConditionIds.length === 0) return null;
  const id = CONDITION_ENUM_TO_ID[conditionEnum as EbayCondition];
  // Unknown enum (shouldn't happen — it's typed) → don't block.
  if (!id) return null;
  if (allowedConditionIds.includes(id)) return null;

  const allowedLabels = allowedConditionIds
    .map(labelForConditionId)
    // de-dup labels (refurb tiers can collapse) and cap the hint length
    .filter((v, i, a) => a.indexOf(v) === i)
    .slice(0, 6);
  return (
    `"${labelForConditionId(id)}" isn't accepted in this eBay category. ` +
    `Allowed: ${allowedLabels.join(", ")}. Change the condition in the composer.`
  );
}

// ── Image reachability ─────────────────────────────────────────────────
//
// eBay fetches imageUrls server-side at publish; an unreachable URL fails the
// whole publish with an opaque error. We HEAD-probe each unique URL first and
// flag only DEFINITIVE client errors (404/410/403) as blockers. Transient
// problems (timeouts, 5xx, network errors) are treated as reachable so a flaky
// CDN moment doesn't block a legitimate publish — eBay will retry its own fetch.

export type UrlFetcher = (url: string) => Promise<{ ok: boolean; status: number }>;

export interface ReachabilityResult {
  /** URLs that returned a definitive client error (404/410/403). */
  unreachable: string[];
}

const DEFINITIVE_UNREACHABLE = new Set([403, 404, 410]);

/**
 * Probe each unique URL with the injected fetcher and collect the ones that
 * definitively don't exist. Bounded by `maxChecked` so a huge batch doesn't
 * stall publish; the cover + first images (highest priority) are checked first.
 */
export async function checkImageReachability(
  urls: string[],
  fetcher: UrlFetcher,
  opts: { maxChecked?: number } = {},
): Promise<ReachabilityResult> {
  const maxChecked = opts.maxChecked ?? EBAY_MAX_IMAGES;
  const unique = [...new Set(urls.filter((u) => !!u && u.trim() !== ""))].slice(
    0,
    maxChecked,
  );
  const unreachable: string[] = [];
  await Promise.all(
    unique.map(async (url) => {
      try {
        const { status } = await fetcher(url);
        if (DEFINITIVE_UNREACHABLE.has(status)) unreachable.push(url);
      } catch {
        // Network error / timeout → treat as reachable (best-effort, no block).
      }
    }),
  );
  return { unreachable };
}

/** Phrase an unreachable-image set as a single fixable blocker. */
export function reachabilityBlocker(result: ReachabilityResult): string | null {
  if (result.unreachable.length === 0) return null;
  const n = result.unreachable.length;
  return (
    `${n} photo${n === 1 ? " is" : "s are"} unreachable and would fail on eBay. ` +
    `Re-upload the affected photo${n === 1 ? "" : "s"} in the composer and try again.`
  );
}
