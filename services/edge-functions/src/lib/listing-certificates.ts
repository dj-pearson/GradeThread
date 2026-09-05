// US-3060: the on-marketplace verified badge — PURE half.
//
// The extension asks "do any of these listing ids have a GradeThread
// certificate?" and gets back only what a badge needs. Extracted out of
// routes/public-grading.ts for the same reason lib/extension-scan.ts was: the
// route's dependency graph makes this logic testable only in CI.
//
// ── WHAT MAKES THIS SAFE TO EXPOSE UNAUTHENTICATED ───────────────────────────
//
// Nothing here is a new disclosure. A grade report with a `certificate_id` is
// already public (CLAUDE.md), the listing id in the request is one the caller
// is already looking at, and the response carries no user id, no listing URL,
// no price and no item title. The route accepts no user id either, so there is
// nothing to scope and nothing to leak by failing to scope it.
//
// The one thing that IS new is the JOIN: it tells an asker that a particular
// marketplace listing belongs to a GradeThread seller. That is the whole point
// of the badge and the seller can turn it off — see `listing_badge_opt_out`.
//
// ── ABSENCE IS NOT A CLAIM ───────────────────────────────────────────────────
//
// A miss returns nothing at all, never an "unverified" marker. Rendering a
// negative badge would turn every ungraded listing on the page into something
// our extension appears to have judged, which is both wrong and unkind to
// sellers who have never heard of us.

/**
 * Platforms a badge can appear on.
 *
 * NOT every listing platform: this is the set where the extension can read a
 * listing id off the page it is already on, without scraping. Adding one means
 * adding an id extractor to research/selectors.js, so the two lists move
 * together on purpose.
 */
export const BADGE_PLATFORMS = ["ebay", "poshmark", "mercari"] as const;
export type BadgePlatform = (typeof BADGE_PLATFORMS)[number];

/**
 * Ids accepted in one request. A scan-mode grid is 24 cards (MAX_SCAN_CARDS),
 * so this is one request per page rather than one per card — which is the
 * property that makes the badge affordable at all.
 */
export const MAX_BADGE_IDS = 24;

/** Longest platform listing id we will look up. eBay's are 12 digits. */
const MAX_ID_LENGTH = 64;

export function isBadgePlatform(v: unknown): v is BadgePlatform {
  return typeof v === "string" && (BADGE_PLATFORMS as readonly string[]).includes(v);
}

export type BadgeQueryError = "bad_platform" | "no_ids" | "too_many_ids";

export type BadgeQuery =
  | { ok: true; platform: BadgePlatform; ids: string[] }
  | { ok: false; code: BadgeQueryError; error: string };

/**
 * Validate the query string.
 *
 * Duplicates are collapsed BEFORE the cap is applied, so a grid that shows the
 * same item twice does not spend two of its 24 slots on it. Empty segments are
 * dropped rather than rejected: `ids=a,,b` is a trailing comma, not an attack,
 * and failing the whole page over one would be the wrong trade for a badge.
 */
export function parseBadgeQuery(platform: unknown, idsRaw: unknown): BadgeQuery {
  if (!isBadgePlatform(platform)) {
    return {
      ok: false,
      code: "bad_platform",
      error: `platform must be one of: ${BADGE_PLATFORMS.join(", ")}`,
    };
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  if (typeof idsRaw === "string") {
    for (const raw of idsRaw.split(",")) {
      const id = raw.trim();
      if (!id || id.length > MAX_ID_LENGTH) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  if (ids.length === 0) {
    return { ok: false, code: "no_ids", error: "Provide at least one listing id." };
  }
  if (ids.length > MAX_BADGE_IDS) {
    return {
      ok: false,
      code: "too_many_ids",
      error: `Ask for at most ${MAX_BADGE_IDS} ids in one request.`,
    };
  }
  return { ok: true, platform, ids };
}

/** Everything a badge renders, and nothing else. */
export interface ListingCertificate {
  /** The platform listing id the caller asked about, echoed for matching. */
  listingId: string;
  certificateId: string;
  /** 1.0-10.0, one decimal. */
  grade: number;
  tier: string;
  /** ISO timestamp of the grade, for "graded <date>". */
  gradedAt: string | null;
  /** Site-relative, so the caller builds the origin and the UTM itself. */
  path: string;
}

export function certificatePath(certificateId: string): string {
  return `/cert/${certificateId}`;
}

/** One row of the joined read, before it is narrowed for the response. */
export interface BadgeSourceRow {
  listingId: string;
  certificateId: string | null;
  overallScore: number | null;
  gradeTier: string | null;
  gradedAt: string | null;
  optedOut: boolean;
}

/**
 * Narrow the joined rows to the public shape.
 *
 * Four things drop a row, and each is a rule rather than a tidy-up:
 *   - no certificate_id: the grade is not public, so neither is its existence;
 *   - the seller opted out;
 *   - no score or tier: a badge with a blank grade is worse than no badge;
 *   - a duplicate listing id: the first wins, deterministically, so a listing
 *     that somehow carries two graded items cannot make the response depend on
 *     row order.
 *
 * Returned as an ARRAY rather than a map keyed by id: a map would tempt a
 * caller into `ids.map(id => byId[id])` and render `undefined` as a badge.
 */
export function shapeListingCertificates(rows: BadgeSourceRow[]): ListingCertificate[] {
  const out: ListingCertificate[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.certificateId) continue;
    if (row.optedOut) continue;
    if (typeof row.overallScore !== "number" || !Number.isFinite(row.overallScore)) continue;
    if (!row.gradeTier) continue;
    if (seen.has(row.listingId)) continue;
    seen.add(row.listingId);
    out.push({
      listingId: row.listingId,
      certificateId: row.certificateId,
      grade: Math.round(row.overallScore * 10) / 10,
      tier: row.gradeTier,
      gradedAt: row.gradedAt,
      path: certificatePath(row.certificateId),
    });
  }
  return out;
}

/**
 * The response body. `found` is the count so a caller can log a hit rate
 * without keeping the ids, which is what the telemetry counter needs (AC6).
 */
export interface BadgeResponse {
  platform: BadgePlatform;
  found: number;
  certificates: ListingCertificate[];
}

export function badgeResponse(
  platform: BadgePlatform,
  certificates: ListingCertificate[],
): BadgeResponse {
  return { platform, found: certificates.length, certificates };
}
