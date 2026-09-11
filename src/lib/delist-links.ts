// US-3369: where a seller goes to see (and end) their live listings on each
// marketplace, and the small rules around getting them there.
//
// This is the fallback that has to work when the extension does not: every
// listed extension listing shows a link to its platform's own active-listings
// page, and so does every row the Delist button could not finish.
//
// The URLs were checked on 2026-09-11. eBay, Etsy, Depop and Grailed answer a
// signed-out request with a redirect to their login, which is what a real
// owner-only page does. Poshmark has no handle-free closet (/closet, /closet/me
// and /my-closet all 404), so its link needs the seller's username. Vinted's
// wardrobe is /member/{numeric id}, which we do not hold, so it gets the site's
// front door and says so.

import type { ListerLocaleMap } from "@/lib/lister-locales";

export type MarketplaceHandleMap = Record<string, string>;

interface ActiveListingsPage {
  /** `{handle}` is replaced with the seller's username. */
  url: string;
  /** False when the link is only the site's home page, not the listings. */
  exact: boolean;
}

const ACTIVE_LISTINGS: Record<string, ActiveListingsPage> = {
  ebay: { url: "https://www.ebay.com/sh/lst/active", exact: true },
  etsy: { url: "https://www.etsy.com/your/shops/me/tools/listings", exact: true },
  depop: { url: "https://www.depop.com/sellinghub/", exact: true },
  poshmark: {
    url: "https://poshmark.com/closet/{handle}?availability=available",
    exact: true,
  },
  mercari: { url: "https://www.mercari.com/mypage/listings/active/", exact: true },
  grailed: { url: "https://www.grailed.com/users/myitems", exact: true },
  facebook: { url: "https://www.facebook.com/marketplace/you/selling", exact: true },
  vinted: { url: "https://www.vinted.com/", exact: false },
};

/** Platforms whose active-listings link needs the seller's username. */
export const HANDLE_PLATFORMS = ["poshmark"] as const;

export function needsSellerHandle(platform: string): boolean {
  return (HANDLE_PLATFORMS as readonly string[]).includes(platform);
}

/** A username we are willing to put inside a URL. Same rule as the edge and the extension. */
export function isValidSellerHandle(v: unknown): v is string {
  return typeof v === "string" && /^[A-Za-z0-9._-]{1,40}$/.test(v);
}

/**
 * What a seller types, made into a username or null. Forgiving about the two
 * things people paste: a leading "@", and the whole closet URL.
 */
export function parseSellerHandle(input: string): string | null {
  let v = input.trim();
  const fromUrl = v.match(/\/closet\/([^/?#]+)/i);
  if (fromUrl?.[1]) v = fromUrl[1];
  v = v.replace(/^@/, "");
  return isValidSellerHandle(v) ? v : null;
}

export interface ActiveListingsLink {
  url: string;
  /** True when the link lands on the seller's listings, not just the site. */
  exact: boolean;
}

/**
 * The seller's active-listings page on `platform`, or null when we cannot
 * build one (unknown platform, or Poshmark with no saved username).
 */
export function activeListingsLink(
  platform: string,
  opts: { handles?: MarketplaceHandleMap | null; locales?: ListerLocaleMap | null } = {},
): ActiveListingsLink | null {
  const page = ACTIVE_LISTINGS[platform];
  if (!page) return null;
  let url = page.url;
  if (url.includes("{handle}")) {
    const handle = opts.handles?.[platform];
    if (!isValidSellerHandle(handle)) return null;
    url = url.replace("{handle}", encodeURIComponent(handle));
  }
  // A Vinted seller on vinted.fr has no account on vinted.com.
  if (platform === "vinted") {
    const key = opts.locales?.vinted;
    if (typeof key === "string" && /^vinted\.[a-z.]+$/.test(key)) url = `https://www.${key}/`;
  }
  return { url, exact: page.exact };
}

/** "Somewhere else" in Record sale's where-did-it-sell picker. */
export const SOLD_ELSEWHERE = "elsewhere";

/**
 * Which listing Record sale preselects as the one that sold: the only live
 * one when there is exactly one. Otherwise nothing is assumed and the seller
 * picks, because guessing wrong ends the listing that is still for sale.
 */
export function defaultSoldListing(
  rows: readonly { id: string; listing_status: string | null }[],
): string {
  const live = rows.filter((r) => r.listing_status === "active");
  return live.length === 1 && live[0] ? live[0].id : SOLD_ELSEWHERE;
}

// US-3369: the "listing still live" notification links to the inventory page
// with ?item=<id>&pendingDelists=1 (the iOS app routes the same link to its own
// delist list). On the web that item's Delist panel is on the item page.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function delistRedirectTarget(params: URLSearchParams): string | null {
  const item = params.get("item");
  if (params.get("pendingDelists") !== "1" || !item || !UUID_RE.test(item)) return null;
  return `/dashboard/flipdesk/items/${item}#delist`;
}
