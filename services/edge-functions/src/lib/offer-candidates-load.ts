// US-2943: today's send-offer candidates, assembled.
//
// Its own module because TWO callers need the identical answer: the route the
// seller opens, and the once-a-day digest that tells them to open it. A digest
// that counted a different set from the page it links to would be worse than no
// digest — the seller clicks through to find the number does not match.
//
// eBay's eligibility response carries a listing id and, sometimes, a title. The
// watchers and the age come from the local listing, and the cooldown comes from
// the offers we have recorded sending (US-2939). None of the three exists on
// eBay's side of the call.
//
// Tenant-scoped: takes an ownerId, filters every query on it (US-268).

import { supabaseAdmin } from "./supabase.ts";
import { findEligibleNegotiationItems } from "./ebay-client.ts";
import { loadOffers } from "./offer-store.ts";
import {
  OFFER_COOLDOWN_DAYS,
  type OfferCandidate,
  rankOfferCandidates,
  type RankedCandidates,
} from "./offer-candidates.ts";

/**
 * Assemble and rank. Throws only what the eBay call throws — the caller decides
 * whether a 403 is a gate or a failure, because the two surfaces say different
 * things about it.
 */
export async function loadRankedOfferCandidates(
  ownerId: string,
  nowMs: number = Date.now(),
): Promise<RankedCandidates> {
  const eligible = await findEligibleNegotiationItems(ownerId);
  if (eligible.length === 0) return { candidates: [], suppressed: [] };

  const listingIds = eligible.map((it) => it.listingId);
  const { data: listingRows } = await supabaseAdmin
    .from("listings")
    .select("platform_listing_id, listing_title, listing_price, watchers, listed_at")
    .eq("user_id", ownerId)
    .eq("platform", "ebay")
    .in("platform_listing_id", listingIds);
  const localById = new Map(
    ((listingRows ?? []) as unknown as Array<{
      platform_listing_id: string | null;
      listing_title: string | null;
      listing_price: number | null;
      watchers: number | null;
      listed_at: string | null;
    }>).filter((r) => r.platform_listing_id).map((r) => [r.platform_listing_id!, r]),
  );

  // When we last offered each item. Only possible because US-2939 records what
  // goes out; before that the list repeated itself every morning, which teaches
  // a watcher to wait for the next discount instead of buying.
  const sent = await loadOffers(ownerId, {
    direction: "offer_sent",
    sinceIso: new Date(nowMs - OFFER_COOLDOWN_DAYS * 2 * 86_400_000).toISOString(),
    limit: 1000,
  });
  const lastOfferedByItem = new Map<string, string>();
  for (const o of sent) {
    if (!o.itemExternalId) continue;
    const prev = lastOfferedByItem.get(o.itemExternalId);
    if (!prev || o.createdAt > prev) lastOfferedByItem.set(o.itemExternalId, o.createdAt);
  }

  const items: OfferCandidate[] = eligible.map((e) => {
    const local = localById.get(e.listingId);
    const listedAt = local?.listed_at ? Date.parse(local.listed_at) : Number.NaN;
    return {
      listingId: e.listingId,
      title: local?.listing_title ?? e.title,
      priceCents: local?.listing_price != null
        ? Math.round(Number(local.listing_price) * 100)
        : null,
      watchers: local?.watchers ?? 0,
      daysListed: Number.isFinite(listedAt)
        ? Math.floor((nowMs - listedAt) / 86_400_000)
        : null,
      lastOfferedAt: lastOfferedByItem.get(e.listingId) ?? null,
    };
  });

  return rankOfferCandidates(items, nowMs);
}
