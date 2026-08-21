import {
  type CrossListingPlatform,
  EXTENSION_CROSS_LISTING_PLATFORMS,
  MARKETPLACE_EXTENSION_FLOW,
} from "@/lib/constants";

// US-2721: which marketplaces this seller cross-posts to.
//
// THE RULE THIS FILE EXISTS TO HOLD: an empty selection means ALL, never none.
//
// Two different states arrive here as "nothing selected" — a seller who has
// never opened the setting (null in the database) and one who unticked the last
// box (an empty array). Neither of them meant "stop offering me marketplaces",
// and reading either as none would silently remove every channel from a draft
// for somebody who never asked. The setting NARROWS what is offered; it cannot
// switch cross-posting off.
//
// Pure, and shared by the picker, the composer's push card and the Listing Kit,
// because three copies of "empty means all" is two chances to write "empty
// means none".

/** A channel that cannot be picked, and the reason to show instead of hiding it. */
export interface UnavailableChannel {
  platform: CrossListingPlatform;
  reason: string;
}

/**
 * Channels whose extension flow is not switched on.
 *
 * Offered as DISABLED with the reason rather than omitted: a channel that
 * silently is not in the list reads as a channel GradeThread does not support,
 * and the seller goes looking for it in the wrong place. `MARKETPLACE_EXTENSION_FLOW`
 * is the same map the badges read, so the picker and the badge cannot disagree.
 */
export function unavailableChannels(): UnavailableChannel[] {
  return EXTENSION_CROSS_LISTING_PLATFORMS
    .filter((p) => MARKETPLACE_EXTENSION_FLOW[p] !== "live")
    .map((p) => ({
      platform: p as CrossListingPlatform,
      reason:
        "The lister flow for this channel is still being checked against its " +
        "live form, so it can't be selected yet.",
    }));
}

export function isChannelSelectable(platform: string): boolean {
  const flow = (MARKETPLACE_EXTENSION_FLOW as Record<string, string>)[platform];
  // A platform outside the extension map (eBay, Shopify) is API-driven and
  // always selectable — the flow map only speaks about extension channels.
  return flow === undefined || flow === "live";
}

/**
 * Is this channel offered, given the seller's selection?
 *
 * `selected` is what the database holds: null when they have never chosen, an
 * array when they have.
 */
export function isChannelEnabled(
  platform: string,
  selected: string[] | null | undefined,
): boolean {
  if (!selected || selected.length === 0) return true;
  return selected.includes(platform);
}

/**
 * Narrow a list of channels by the seller's selection.
 *
 * Order is preserved from the input, because the caller's order is the one the
 * seller sees and re-sorting it here would shuffle their tabs.
 */
export function filterChannels<T extends string>(
  platforms: readonly T[],
  selected: string[] | null | undefined,
): T[] {
  return platforms.filter((p) => isChannelEnabled(p, selected));
}

/**
 * What to write back when the seller ticks boxes.
 *
 * Returns null — meaning ALL — when the selection covers everything or nothing,
 * so the stored value stays the honest default instead of a frozen snapshot of
 * today's channel list. A seller who ticks every box today and finds a seventh
 * channel next month should be offered it.
 */
export function normalizeSelection(
  selected: readonly string[],
  everySelectable: readonly string[],
): string[] | null {
  const cleaned = [...new Set(selected.filter((p) => everySelectable.includes(p)))];
  if (cleaned.length === 0) return null;
  if (cleaned.length === everySelectable.length) return null;
  return cleaned;
}
