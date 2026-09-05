// US-1808: extension-fed marketplace listing ingestion — the PURE half.
//
// A buyer browsing Poshmark sees an item that is obviously theirs; their saved
// searches never hear about it, because the alerts engine (condition-alerts.ts)
// only ever matches PUBLIC GRADETHREAD CERTIFICATES. Everything a buyer actually
// shops is outside that universe. This module is the bridge: the extension hands
// one listing the buyer is looking at RIGHT NOW to the edge, it gets graded, and
// it is evaluated against that buyer's own saved searches.
//
// ── WHY THE MARKETPLACE ALLOWLIST IS THE ToS BOUNDARY ────────────────────────
//
// Marketplace terms permit a shopper reading a page they opened; they do not
// permit building a crawl of a catalogue. The difference is not a promise in a
// comment — it is enforced mechanically here and in the route:
//
//   • ONE listing per request. There is no array form, so no request shape can
//     express "ingest this whole results page".
//   • The listing URL must be a page on a marketplace the extension actually
//     runs on (INGEST_MARKETPLACE_HOSTS). A URL for anywhere else is refused, so
//     the endpoint cannot be repurposed as a generic fetch-and-grade crawler.
//   • The SERVER NEVER FETCHES THE LISTING PAGE. Only the image URLs the buyer's
//     own browser already loaded are fetched (through safeFetch's SSRF guard
//     inside quickGrade). We never see, request, or store the page's HTML.
//   • The `marketplace` is derived FROM THE URL, never trusted from the body —
//     a caller cannot label an arbitrary host as "poshmark" to get past the gate.
//   • Rows are private to the ingesting buyer and pruned (INGEST_RETENTION_DAYS),
//     so the table is a buyer's own recent browsing, not an accumulating corpus.
//
// The remaining halves live where they need I/O: the route
// (routes/public-grading.ts POST /ingest-listing) owns auth, rate limiting,
// quota metering and persistence; matching reuses `matchesSearch` from
// condition-alerts.ts so an ingested listing is judged by exactly the same
// predicate as an on-platform certificate.

import { parseListingImageUrls } from "./extension-image-urls.ts";
import { parsePriceCents } from "./price-fairness.ts";

/**
 * Marketplaces the extension runs on, keyed by registrable host suffix. LOCKSTEP
 * with the adapter keys in extension-unified/lister/selectors.js and with
 * SELECTOR_HEALTH_ADAPTERS in routes/public-grading.ts — a marketplace the
 * extension cannot read is a marketplace nobody can ingest from.
 */
export const INGEST_MARKETPLACE_HOSTS: Record<string, string> = {
  "ebay.com": "ebay",
  "ebay.co.uk": "ebay",
  "ebay.ca": "ebay",
  "ebay.com.au": "ebay",
  "poshmark.com": "poshmark",
  "poshmark.ca": "poshmark",
  "grailed.com": "grailed",
  "mercari.com": "mercari",
  "depop.com": "depop",
  "vinted.com": "vinted",
  "vinted.co.uk": "vinted",
};

/**
 * SOURCING sites — where a reseller BUYS, not where a shopper buys from a
 * reseller (US-3067).
 *
 * ⚠ DELIBERATELY A SEPARATE MAP, AND THE SEPARATION IS THE POINT.
 * INGEST_MARKETPLACE_HOSTS above feeds condition-alerts: a listing ingested
 * through it can surface in a BUYER's alert feed. A ShopGoodwill lot must never
 * do that. It is a charity's photograph of a donation with no seller making a
 * condition claim, and putting one in front of a buyer looking for a graded
 * garment would be presenting a thrift bin as a resale listing.
 *
 * So a sourcing host resolves for the scout's own metric label and for nothing
 * else, and listing-ingest_test.ts asserts the two maps stay disjoint.
 */
export const SOURCING_MARKETPLACE_HOSTS: Record<string, string> = {
  "shopgoodwill.com": "shopgoodwill",
};

/**
 * The marketplace key for a SOURCING host, or null.
 *
 * Same label-boundary walk as resolveIngestMarketplace, for the same reason: a
 * bare endsWith would resolve `shopgoodwill.com.evil.example`.
 */
export function resolveSourcingMarketplace(host: string): string | null {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (!h) return null;
  const labels = h.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    const key = SOURCING_MARKETPLACE_HOSTS[labels.slice(i).join(".")];
    if (key) return key;
  }
  return null;
}

/**
 * Normalize whatever the extension called the marketplace into a BOUNDED label.
 *
 * The scout used to put `body.marketplace` on a metric after a 24-character
 * slice and nothing else, which is unbounded cardinality on a caller-supplied
 * string. Anything not recognised now reads "unknown", which is the honest
 * label for a value we did not put in either map.
 */
export function normalizeScoutMarketplace(raw: unknown): string {
  if (typeof raw !== "string") return "unknown";
  const key = raw.trim().toLowerCase();
  if (!key) return "unknown";
  const known = new Set<string>([
    ...Object.values(INGEST_MARKETPLACE_HOSTS),
    ...Object.values(SOURCING_MARKETPLACE_HOSTS),
  ]);
  return known.has(key) ? key : "unknown";
}

/** Longest normalized listing URL we will store (and therefore index). */
export const MAX_LISTING_URL_LENGTH = 512;

/** How long an ingested listing is kept before the next ingest prunes it. */
export const INGEST_RETENTION_DAYS = 90;

/**
 * The marketplace key for a listing URL, or null when the host isn't one the
 * extension supports. Matches on the registrable suffix so `www.` and locale
 * subdomains (`www.ebay.com`, `m.poshmark.com`) resolve, while a lookalike
 * (`ebay.com.evil.example`) does NOT — the check walks label boundaries, never
 * a bare `endsWith` on the string.
 */
export function resolveIngestMarketplace(host: string): string | null {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (!h) return null;
  const labels = h.split(".");
  // Try the longest suffixes first so ebay.co.uk beats a hypothetical co.uk.
  for (let i = 0; i < labels.length - 1; i++) {
    const suffix = labels.slice(i).join(".");
    const key = INGEST_MARKETPLACE_HOSTS[suffix];
    if (key) return key;
  }
  return null;
}

/**
 * Canonical form of a listing URL: https/http only, host lowercased with a
 * leading `www.` dropped, query string and fragment REMOVED, trailing slash
 * trimmed. The query is dropped because marketplace listing URLs carry tracking
 * and session parameters that differ on every visit — keeping them would make
 * the same item ingest as a new row each time the buyer arrived from a different
 * link, defeating the dedupe. Returns null for anything unusable.
 */
export function normalizeListingUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (!host) return null;
  let path = url.pathname.replace(/\/+$/, "");
  if (path === "") path = "/";
  const normalized = `${url.protocol}//${host}${path}`;
  return normalized.length <= MAX_LISTING_URL_LENGTH ? normalized : null;
}

/** One listing the buyer asked us to check, after validation. */
export interface IngestListingInput {
  /** Derived from the URL — never taken from the request body. */
  marketplace: string;
  /** Canonical URL; also the per-buyer dedupe key. */
  listingUrl: string;
  imageUrls: string[];
  title: string | null;
  brand: string | null;
  /** The seller's own condition wording, verbatim (scored later). */
  claimedCondition: string | null;
  priceCents: number | null;
  /** Buyer asked to also add this to their watchlist. */
  watch: boolean;
}

export type IngestParseResult =
  | { ok: true; listing: IngestListingInput }
  | { ok: false; error: string };

function text(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().slice(0, max);
  return t.length > 0 ? t : null;
}

/**
 * Validate ONE browsed listing. PURE — the SSRF defence for the image URLs is
 * safeFetch inside quickGrade (a pure function cannot resolve DNS); this rejects
 * shape problems before anything opens a socket or reserves a metered action.
 */
export function parseIngestBody(body: unknown, maxImages: number): IngestParseResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Send one listing to check." };
  }
  const b = body as Record<string, unknown>;

  const listingUrl = normalizeListingUrl(b.url ?? b.listingUrl);
  if (!listingUrl) {
    return { ok: false, error: "Provide the listing's web address." };
  }
  const marketplace = resolveIngestMarketplace(new URL(listingUrl).hostname);
  if (!marketplace) {
    // Deliberately names the constraint rather than hiding it: the buyer sees
    // "we only read pages you're browsing on a marketplace we support", which is
    // the honest description of what this endpoint is for.
    return {
      ok: false,
      error: "GradeThread can only check listings on a marketplace it supports.",
    };
  }

  const images = parseListingImageUrls(b.imageUrls ?? b.imageUrl, maxImages, {
    malformed: "Each photo must be a valid URL.",
    scheme: "Photo URLs must be http(s).",
    empty: "This listing has no photos we can read.",
  });
  if (!images.ok) return { ok: false, error: images.error };

  return {
    ok: true,
    listing: {
      marketplace,
      listingUrl,
      imageUrls: images.urls,
      title: text(b.title, 200),
      brand: text(b.brand, 80),
      claimedCondition: text(
        typeof b.condition === "number" ? String(b.condition) : b.condition,
        80,
      ),
      priceCents: parsePriceCents(b.price),
      watch: b.watch === true,
    },
  };
}

/**
 * Does an ingested listing's ASKING price clear a saved search's ceiling?
 *
 * Note this is a stronger test than the one the certificate path can make. A
 * public certificate has no sale price, so condition-alerts.ts has to compare
 * the search's ceiling against a MODELLED fair value and skip the gate whenever
 * no confident curve resolves. A browsed listing carries the real number, so the
 * ceiling means what the buyer thought it meant. An unreadable price still
 * includes rather than suppresses — a missing price is not evidence of a dear one.
 */
export function priceWithinCeiling(
  priceCents: number | null,
  maxPriceCents: number | null,
): boolean {
  if (maxPriceCents == null) return true;
  if (priceCents == null) return true;
  return priceCents <= maxPriceCents;
}

/**
 * The notification body for an ingested match. Says WHERE the item is, because
 * unlike a certificate alert this one sends the buyer to another site — leaving
 * the marketplace unnamed would make the alert read like a GradeThread listing.
 */
export function buildIngestAlertBody(
  listing: Pick<IngestListingInput, "marketplace" | "title" | "brand" | "priceCents">,
  grade: number,
): string {
  const who = [listing.brand, listing.title ?? "Listing"].filter(Boolean).join(" ");
  const price = listing.priceCents != null
    ? ` at $${(listing.priceCents / 100).toFixed(0)}`
    : "";
  const where = listing.marketplace.charAt(0).toUpperCase() + listing.marketplace.slice(1);
  return `${who} on ${where}${price} — we graded it ${grade.toFixed(1)}/10.`;
}
