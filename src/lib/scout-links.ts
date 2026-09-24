// Links INTO the Sourcing host's Scout tabs, built in one place so the
// parameter names Scout reads and the ones other pages write cannot drift.

/**
 * SRC-8: where a facet sends the seller. This used to be /scout?q=, which
 * nothing read. A brand prefills Scout's brand field; a category term prefills
 * its search words.
 */
export function scoutHrefForFacet(term: string, kind: "brand" | "category"): string {
  const params = new URLSearchParams({ tab: "scout" });
  params.set(kind === "brand" ? "brand" : "q", term);
  return `/dashboard/flipdesk/sourcing?${params.toString()}`;
}

/**
 * SRC-12: where a just-bought item lives. The item canvas is /items/<id>;
 * /inventory/<id> is not a route.
 */
export function inventoryItemHref(id: string): string {
  return `/dashboard/flipdesk/items/${encodeURIComponent(id)}`;
}

/** SRC-13: what a Scout row hands to Buy decision. */
export interface BuyPrefill {
  q?: string;
  brand?: string;
  size?: string;
  cat?: string;
  /** What the seller would pay, in cents. */
  costCents?: number | null;
  sourceId?: string;
}

/** SRC-13: Buy decision, prefilled. Every value rides in the URL, so it is a link. */
export function scoutBuyHref(p: BuyPrefill): string {
  const params = new URLSearchParams({ tab: "buy" });
  if (p.q?.trim()) params.set("q", p.q.trim().slice(0, 200));
  if (p.brand?.trim()) params.set("brand", p.brand.trim());
  if (p.size?.trim()) params.set("size", p.size.trim());
  if (p.cat?.trim()) params.set("cat", p.cat.trim());
  if (p.costCents != null && p.costCents > 0) params.set("cost", String(Math.round(p.costCents)));
  if (p.sourceId) params.set("sourceId", p.sourceId);
  return `/dashboard/flipdesk/sourcing?${params.toString()}`;
}

/** SRC-13: ?cost= is cents; the cost field is dollars. */
export function costFieldFromCents(raw: string | null): string {
  if (!raw || !/^\d{1,9}$/.test(raw)) return "";
  return (Number(raw) / 100).toFixed(2);
}

/**
 * SRC-13: only a real eBay https page becomes a link or a saved listing URL.
 * The row's URL is another seller's listing as eBay returned it, and a value
 * like javascript:alert(1) must render as nothing at all.
 */
export function isEbayListingUrl(url: string | null | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /(^|\.)ebay\.[a-z.]{2,6}$/i.test(u.hostname);
  } catch {
    return false;
  }
}

// ── SRC-13: the Source a seller buys from, remembered per workspace ─────────
//
// A convenience only: it lives in this browser and can come back empty or throw
// (private window, blocked storage), so every access is wrapped and a missing
// value just means "no source picked".

function lastSourceKey(ownerId: string): string {
  return `gt.scout.lastSourceId.${ownerId}`;
}

export function readLastSourceId(ownerId: string | null | undefined): string | null {
  if (!ownerId) return null;
  try {
    return window.localStorage.getItem(lastSourceKey(ownerId));
  } catch {
    return null;
  }
}

export function writeLastSourceId(ownerId: string | null | undefined, sourceId: string | null): void {
  if (!ownerId) return;
  try {
    if (sourceId) window.localStorage.setItem(lastSourceKey(ownerId), sourceId);
    else window.localStorage.removeItem(lastSourceKey(ownerId));
  } catch {
    // Storage unavailable; the picker just will not remember.
  }
}
