/**
 * US-3042: read an eBay listing through the Browse API instead of off the page.
 *
 * WHAT THIS REPLACES, AND WHY IT HAD TO GO. The buyer extension used to run a
 * content script on every eBay listing page, pull the gallery photo URLs and the
 * title out of the DOM, and post them to us for grading. It worked, and it was
 * the single largest compliance problem in the integration: eBay's API License
 * Agreement is explicit that eBay content is obtained through the API, and an
 * application asking eBay for a higher call limit while taking data around the
 * API is not an application eBay approves.
 *
 * So the extension now sends an item id and nothing else, and the photos and
 * title come from eBay's own response to us. The listing data crosses the wire
 * from eBay, not from the shopper's browser.
 *
 * A SIDE EFFECT WORTH KEEPING: this is also more reliable than what it replaces.
 * DOM selectors broke every time eBay shipped a layout change — there is a whole
 * selector-health telemetry endpoint that exists because of it. An item id in a
 * URL has been stable for twenty years.
 *
 * Uses the application token with the base scope. Browse getItem is NOT a
 * restricted API, so this needs no additional grant and works on the keyset we
 * already have.
 */

import {
  apiHost,
  countedEbayFetch,
  getAppAccessToken,
  getMarketplaceId,
} from "./ebay-client.ts";

/** eBay legacy item ids are 9-12 digits. Nothing else is accepted. */
const LEGACY_ITEM_ID_RE = /^\d{9,15}$/;

/**
 * Pull the legacy item id out of an eBay listing URL.
 *
 * Handles the two shapes eBay actually serves:
 *   https://www.ebay.com/itm/123456789012
 *   https://www.ebay.com/itm/some-slug-text/123456789012?hash=...
 *   https://www.ebay.com/itm/?item=123456789012
 *
 * Pure and exported so the same rule can be unit tested and mirrored in the
 * extension without the two drifting.
 *
 * Returns null for anything that is not an eBay item URL, INCLUDING other eBay
 * pages (search, seller, category). A null here means "do not treat this as a
 * listing", which is the safe direction.
 */
export function parseEbayItemId(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!/(^|\.)ebay\.[a-z.]{2,6}$/i.test(url.hostname)) return null;

  const fromQuery = url.searchParams.get("item");
  if (fromQuery && LEGACY_ITEM_ID_RE.test(fromQuery)) return fromQuery;

  // /itm/<id> or /itm/<slug>/<id>. Take the LAST numeric segment: a slug can
  // contain digits ("nike-air-max-90"), and the id is always last.
  const segments = url.pathname.split("/").filter(Boolean);
  if (segments[0]?.toLowerCase() !== "itm") return null;
  for (let i = segments.length - 1; i >= 1; i--) {
    const seg = segments[i]!;
    if (LEGACY_ITEM_ID_RE.test(seg)) return seg;
  }
  return null;
}

/** Server-side validation of an id the extension sent us. */
export function isValidEbayItemId(value: unknown): value is string {
  return typeof value === "string" && LEGACY_ITEM_ID_RE.test(value.trim());
}

export interface EbayListingRead {
  itemId: string;
  title: string;
  brand: string | null;
  /** Gallery image URLs, hero first, all eBay-hosted. */
  imageUrls: string[];
  priceCents: number | null;
  currency: string;
  /** eBay's numeric conditionId, for the claimed-vs-objective comparison. */
  conditionId: string | null;
  conditionLabel: string | null;
  itemWebUrl: string | null;
}

function toCents(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

/**
 * Fetch one listing's gradeable content from Browse.
 *
 * `maxImages` is applied HERE rather than by the caller because the caller's cap
 * is an entitlement decision and this is the only place that knows how many
 * photos exist. Hero image first: the composite grader types the first two
 * images as front/back, so the order eBay returns them in is load-bearing.
 *
 * Returns null when the item is gone, private, or on a marketplace our keyset
 * cannot read. Never throws — a failed read costs one grade, not the request.
 */
export async function readEbayListingForGrading(
  legacyItemId: string,
  maxImages = 6,
): Promise<EbayListingRead | null> {
  if (!isValidEbayItemId(legacyItemId)) return null;
  const itemId = legacyItemId.trim();
  try {
    const token = await getAppAccessToken();
    const url = `${apiHost()}/buy/browse/v1/item/get_item_by_legacy_id?legacy_item_id=${
      encodeURIComponent(itemId)
    }`;
    const res = await countedEbayFetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": getMarketplaceId(),
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      // 404 is the normal case for an ended listing, not an incident.
      if (res.status !== 404) {
        console.warn(
          `[ebay-item-read] getItemByLegacyId ${itemId} failed (${res.status})`,
        );
      }
      return null;
    }

    const item = (await res.json()) as {
      itemId?: string;
      title?: string;
      brand?: string;
      price?: { value?: string; currency?: string };
      image?: { imageUrl?: string };
      additionalImages?: Array<{ imageUrl?: string }>;
      conditionId?: string;
      condition?: string;
      itemWebUrl?: string;
      localizedAspects?: Array<{ name?: string; value?: string }>;
    };

    // Hero first, then the rest, de-duplicated. eBay repeats the hero inside
    // additionalImages on some listings, and a duplicate photo would be graded
    // twice and counted twice toward coverage.
    const seen = new Set<string>();
    const imageUrls: string[] = [];
    for (
      const candidate of [
        item.image?.imageUrl,
        ...(item.additionalImages ?? []).map((i) => i.imageUrl),
      ]
    ) {
      const u = candidate?.trim();
      if (!u || seen.has(u)) continue;
      seen.add(u);
      imageUrls.push(u);
      if (imageUrls.length >= maxImages) break;
    }
    if (imageUrls.length === 0) return null;

    // Brand comes from the top-level field when eBay populates it, otherwise
    // from the Brand aspect. Both are eBay's own structured data — this is not
    // a guess parsed out of the title.
    const brandAspect = item.localizedAspects?.find(
      (a) => (a.name ?? "").trim().toLowerCase() === "brand",
    )?.value;

    return {
      itemId: item.itemId ?? itemId,
      title: (item.title ?? "").trim(),
      brand: (item.brand ?? brandAspect ?? "").trim() || null,
      imageUrls,
      priceCents: toCents(item.price?.value),
      currency: item.price?.currency ?? "USD",
      conditionId: item.conditionId?.trim() || null,
      conditionLabel: item.condition?.trim() || null,
      itemWebUrl: item.itemWebUrl?.trim() || null,
    };
  } catch (err) {
    console.error(
      "[ebay-item-read] read failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/**
 * Replace the client-supplied listing fields with eBay's own, for any request
 * body carrying an eBay item URL.
 *
 * This exists so the endpoints that take a marketplace URL (`/ingest-listing`,
 * the flip appraisal) get the same treatment as the grading path without each
 * of them growing its own branch. The caller keeps ONE validation path: the
 * body that comes back out of here has the same shape it went in with, so the
 * existing parser still runs and still rejects the same things.
 *
 * The fields are REPLACED, never merged. Merging would leave a caller able to
 * steer the grade's inputs on the one marketplace where we deliberately do not
 * let them, which would make the whole change cosmetic.
 *
 * Returns `status: "passthrough"` for every non-eBay URL, so nothing changes for
 * Poshmark, Mercari, Grailed, Depop or Vinted. Those marketplaces publish no API
 * we could read instead, which is a real difference and not an inconsistency.
 */
export async function hydrateEbayListingBody(
  body: unknown,
  maxImages: number,
): Promise<
  | { status: "passthrough"; body: unknown }
  | { status: "hydrated"; body: unknown; listing: EbayListingRead }
  | { status: "unavailable"; body: unknown }
> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { status: "passthrough", body };
  }
  const b = body as Record<string, unknown>;
  const rawUrl = typeof b.url === "string"
    ? b.url
    : typeof b.listingUrl === "string"
    ? b.listingUrl
    : null;
  if (!rawUrl) return { status: "passthrough", body };

  const itemId = parseEbayItemId(rawUrl);
  if (!itemId) return { status: "passthrough", body };

  const listing = await readEbayListingForGrading(itemId, maxImages);
  if (!listing) return { status: "unavailable", body };

  return {
    status: "hydrated",
    listing,
    body: {
      ...b,
      imageUrls: listing.imageUrls,
      // Drop the singular form too: leaving it would let a caller's imageUrl
      // survive alongside the replaced array in any parser that prefers it.
      imageUrl: undefined,
      title: listing.title || undefined,
      brand: listing.brand ?? undefined,
      condition: listing.conditionId ?? listing.conditionLabel ?? undefined,
      price: listing.priceCents != null ? listing.priceCents / 100 : undefined,
      priceCents: listing.priceCents ?? undefined,
    },
  };
}
