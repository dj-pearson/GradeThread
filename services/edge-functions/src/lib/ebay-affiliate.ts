// US-3541: eBay Partner Network (EPN) links for Reseller Swap tips.
//
// A tip points at another seller's EXISTING eBay listing. When the account has
// an EPN campaign id configured (EBAY_EPN_CAMPAIGN_ID), the link carries EPN's
// tracking parameters so eBay pays GradeThread a commission on a qualifying
// purchase. The buyer pays eBay the normal price and the seller gets the normal
// payout; the commission comes out of eBay's side, not either seller's.
//
// Two rules this file holds:
//   * Only real eBay listing URLs are ever returned. A stored listing_url that
//     is not https on an ebay.com host is dropped, and the caller rebuilds the
//     URL from the listing id or skips the tip. A tip is a link we tell a seller
//     to click, so it can never point anywhere else.
//   * No campaign id, or one that is not EPN-shaped, means the plain URL. The
//     feature works without the affiliate program; the commission is extra.

/** EPN rotation id for ebay.com (US site). */
export const EPN_US_ROTATION_ID = "711-53200-19255-0";

/** EPN campaign ids are 10 digits. */
const CAMPAIGN_ID_RE = /^\d{10}$/;

/** Numeric eBay item ids ("legacy" ids), 9 to 15 digits. */
const ITEM_ID_RE = /^\d{9,15}$/;

function isEbayUsHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "ebay.com" || h === "www.ebay.com";
}

/**
 * The canonical listing URL for a stored listing row, or null when neither the
 * stored URL nor the platform id gives a safe eBay link.
 */
export function ebayListingUrl(
  listingUrl: string | null | undefined,
  platformListingId: string | null | undefined,
): string | null {
  if (listingUrl) {
    try {
      const u = new URL(listingUrl);
      if (u.protocol === "https:" && isEbayUsHost(u.hostname)) {
        const m = u.pathname.match(/^\/itm\/(?:[^/]+\/)?(\d{9,15})\/?$/);
        if (m) return `https://www.ebay.com/itm/${m[1]}`;
      }
    } catch {
      // fall through to the id
    }
  }
  const id = platformListingId?.trim();
  if (id && ITEM_ID_RE.test(id)) return `https://www.ebay.com/itm/${id}`;
  return null;
}

/** Read and validate the configured campaign id. Undefined when unusable. */
export function epnCampaignId(
  raw: string | undefined = Deno.env.get("EBAY_EPN_CAMPAIGN_ID"),
): string | undefined {
  const v = raw?.trim();
  return v && CAMPAIGN_ID_RE.test(v) ? v : undefined;
}

/**
 * Add EPN tracking to an eBay listing URL. `customId` shows up in EPN reports
 * so swap commissions can be told apart from any other link; it must never
 * carry a user id or anything else that names a person.
 */
export function withEpnTracking(
  url: string,
  campaignId: string | undefined,
  customId = "gt-swap",
): string {
  if (!campaignId || !CAMPAIGN_ID_RE.test(campaignId)) return url;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  if (u.protocol !== "https:" || !isEbayUsHost(u.hostname)) return url;
  u.searchParams.set("mkcid", "1");
  u.searchParams.set("mkrid", EPN_US_ROTATION_ID);
  u.searchParams.set("siteid", "0");
  u.searchParams.set("campid", campaignId);
  u.searchParams.set(
    "customid",
    customId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 256),
  );
  u.searchParams.set("toolid", "10001");
  u.searchParams.set("mkevt", "1");
  return u.toString();
}
