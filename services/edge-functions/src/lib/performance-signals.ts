// US-565: post-publish performance feedback loop — pure suggestion logic.
//
// Turns the engagement snapshot the getTrafficReport sync writes per active
// listing (impressions / views / watchers / click-through-rate) into one
// actionable, plain-English suggestion, AND into a single boolean the repricing
// engine consumes ("does engagement justify a markdown?"). No I/O here so it's
// unit-tested directly and shared by the /pricing/performance endpoint and the
// repricing engine without duplicating thresholds.

export type PerformanceSignalCode =
  | "NO_TRAFFIC" // listed a while, almost no impressions → promote / refresh keywords
  | "LOW_CTR" // seen a lot, rarely clicked → fix the title or lead photo
  | "WATCHED_NO_SALE" // clicked + watched, still unsold → drop price / enable Best Offer
  | "HEALTHY"; // nothing to do

export interface PerformanceMetrics {
  /** Impressions over the trailing window (eBay reports 7 days). */
  impressions: number;
  views: number;
  watchers: number;
  /** 0..1 fraction (the sync stores eBay's % / 100); null when unknown. */
  clickThroughRate: number | null;
  listingAgeDays: number;
  /** Best Offer already enabled? Suppresses the "enable Best Offer" nudge. */
  hasBestOffer: boolean;
}

export interface PerformanceSuggestion {
  code: PerformanceSignalCode;
  title: string;
  message: string;
  // Actions the suggestion implies — surfaced as buttons by the UI and read by
  // the repricing feed (suggestsPriceDrop).
  suggestsPriceDrop: boolean;
  suggestsBestOffer: boolean;
  suggestsContentFix: boolean;
}

// Thresholds — deliberately conservative so a nudge feels earned, not noisy.
export const MIN_IMPRESSIONS_FOR_CTR = 100; // need real exposure before judging CTR
export const LOW_CTR = 0.01; // < 1% click-through despite real exposure
export const HIGH_WATCHERS = 3; // "several people watching"
export const WATCHED_NO_SALE_DAYS = 7; // watched this long without selling
export const NO_TRAFFIC_DAYS = 10; // listed at least this long…
export const NO_TRAFFIC_MAX_IMPRESSIONS = 20; // …with barely any exposure

const HEALTHY: PerformanceSuggestion = {
  code: "HEALTHY",
  title: "Performing normally",
  message: "Engagement looks healthy — no action needed.",
  suggestsPriceDrop: false,
  suggestsBestOffer: false,
  suggestsContentFix: false,
};

/**
 * The single most useful suggestion for one listing, evaluated as a funnel:
 * no exposure → exposure-but-no-clicks → clicks-but-no-sale → healthy. Returning
 * one (not a list) keeps the feed actionable rather than a wall of advice.
 */
export function evaluatePerformance(
  m: PerformanceMetrics,
): PerformanceSuggestion {
  // 1. No exposure at all — can't judge CTR or interest; the fix is visibility.
  if (
    m.listingAgeDays >= NO_TRAFFIC_DAYS &&
    m.impressions <= NO_TRAFFIC_MAX_IMPRESSIONS
  ) {
    return {
      code: "NO_TRAFFIC",
      title: "Barely any impressions",
      message: `Listed ${m.listingAgeDays} days with almost no impressions. Refresh the keywords/category or enable Promoted Listings to get it seen.`,
      suggestsPriceDrop: false,
      suggestsBestOffer: false,
      suggestsContentFix: true,
    };
  }

  // 2. Plenty of impressions but almost nobody clicks — a top-of-funnel problem,
  //    so the lever is the title and lead photo, not the price.
  if (
    m.impressions >= MIN_IMPRESSIONS_FOR_CTR &&
    m.clickThroughRate != null &&
    m.clickThroughRate < LOW_CTR
  ) {
    return {
      code: "LOW_CTR",
      title: "Low click-through",
      message: `${m.impressions.toLocaleString()} impressions but only a ${(m.clickThroughRate * 100).toFixed(1)}% click-through. Improve the title or lead photo so more shoppers click in.`,
      suggestsPriceDrop: false,
      suggestsBestOffer: false,
      suggestsContentFix: true,
    };
  }

  // 3. People are clicking and watching, but it still hasn't sold — the lever is
  //    price (or Best Offer to let them name one).
  if (m.watchers >= HIGH_WATCHERS && m.listingAgeDays >= WATCHED_NO_SALE_DAYS) {
    const offerHint = m.hasBestOffer
      ? "drop the price to convert that interest"
      : "drop the price or enable Best Offer to convert that interest";
    return {
      code: "WATCHED_NO_SALE",
      title: "Watched but unsold",
      message: `${m.watchers} watchers but no sale in ${m.listingAgeDays} days — ${offerHint}.`,
      suggestsPriceDrop: true,
      suggestsBestOffer: !m.hasBestOffer,
      suggestsContentFix: false,
    };
  }

  return HEALTHY;
}

/**
 * Does the engagement snapshot independently justify a price markdown, beyond
 * plain age/no-watchers staleness? This is the signal the repricing engine
 * consumes — it's true exactly for the WATCHED_NO_SALE case (high interest, no
 * conversion), where a price cut is the right move.
 */
export function engagementSuggestsMarkdown(m: PerformanceMetrics): boolean {
  return evaluatePerformance(m).suggestsPriceDrop;
}
