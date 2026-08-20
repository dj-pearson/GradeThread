// Sold-sync observation planner (US-2697) — the PURE decision over what the
// browser extension saw on a seller's own marketplace pages.
//
// WHY THIS IS PURE, AND WHY THE EXTENSION DOES NOT DECIDE.
//
// The extension reads the seller's own Sold page and closet and reports rows.
// It never concludes that something sold. This module does, and it is the only
// thing that does, for two reasons stated in
// docs/superpowers/specs/2026-08-19-extension-sold-sync-design.md:
//
//   1. A selector regression then produces a bad OBSERVATION rather than a bad
//      delist. Everything below is what stands between a Poshmark redesign and
//      a seller's catalogue being pulled off four other channels.
//   2. This ships with an edge deploy. Extension logic waits days for store
//      review. The dangerous half belongs where it can be fixed in minutes.
//
// The impure half (persisting rows, writing the sale, handing off to
// cross-listings.ts) lives in the route. Same split as cross-listing-sale.ts,
// for the same reason: the semantics that matter are unit-testable with no DB.

/** A listing GradeThread published and still believes is live. */
export interface KnownListing {
  id: string;
  itemId: string;
  platform: string;
  listingUrl: string | null;
  title: string | null;
  priceCents: number | null;
  listingStatus: string;
}

/** One row read off the seller's own Sold / Orders page. */
export interface SoldObservation {
  listingUrl: string | null;
  title: string | null;
  soldPriceCents: number | null;
  soldAt: string | null;
  /** The platform's own order id, when it prints one. The best dedupe key. */
  orderRef: string | null;
  thumbAssetId: string | null;
}

/**
 * What the active closet looked like, and HOW MUCH of it was actually read.
 *
 * `reachedEnd` is not a detail. A poll that read page 1 of 8 makes pages 2
 * through 8 look vanished, and treating that as evidence would report a mass
 * delisting every time pagination changed.
 */
export interface ClosetObservation {
  listingUrls: string[];
  pagesRead: number;
  reachedEnd: boolean;
}

export interface ObservationBatch {
  platform: string;
  observedAt: string;
  /** False when the read hit a login wall. Nothing is inferred from it. */
  signedIn: boolean;
  sold: SoldObservation[];
  /** Null when the closet was not read this batch — absence proves nothing. */
  closet: ClosetObservation | null;
}

export interface PlanInput {
  batch: ObservationBatch;
  known: readonly KnownListing[];
  /** Dedupe keys already recorded for this tenant+platform. */
  seenKeys: ReadonlySet<string>;
}

export interface ConfirmedSale {
  listingId: string;
  itemId: string;
  soldPriceCents: number | null;
  soldAt: string | null;
  dedupeKey: string;
}

export type ReviewReason =
  | "probable_match"
  | "unexplained_absence"
  | "count_gap"
  | "circuit_breaker";

export interface ReviewRow {
  reason: ReviewReason;
  listingId: string | null;
  itemId: string | null;
  listingUrl: string | null;
  title: string | null;
  soldPriceCents: number | null;
  soldAt: string | null;
  dedupeKey: string | null;
  /** Set on count_gap: live listings that vanished with no sale explaining it. */
  unexplained?: number;
  /** Set on circuit_breaker: how many sales the batch claimed, and the cap. */
  claimed?: number;
  limit?: number;
}

export interface UnmatchedSale {
  listingUrl: string | null;
  title: string | null;
  soldPriceCents: number | null;
  soldAt: string | null;
  dedupeKey: string;
}

export type ChannelStatus = "ok" | "failing" | "not_signed_in";

export interface ObservationPlan {
  channelStatus: ChannelStatus;
  confirmed: ConfirmedSale[];
  review: ReviewRow[];
  unmatched: UnmatchedSale[];
  breakerTripped: boolean;
  /** Human-readable why, when the channel is not ok. */
  failureReason: string | null;
}

/**
 * The circuit breaker.
 *
 * A batch claiming more sales than `max(FLOOR, SHARE * live listings)` is
 * refused whole. A seller genuinely selling fifteen items in an hour is rare; a
 * selector matching two hundred rows is what a broken page looks like, and a
 * per-item undo does nothing against that case because by the time anyone
 * notices, the siblings are already delisted on four channels.
 *
 * The FLOOR exists because 20% of a five-listing closet is one, and a seller
 * with a small closet having a good day is not a malfunction.
 */
export const BREAKER_FLOOR = 5;
export const BREAKER_SHARE = 0.2;

/** Statuses that mean we still believe the listing is live on the marketplace. */
const LIVE_STATUSES = new Set(["draft", "active"]);

/**
 * Canonical form of a marketplace listing URL.
 *
 * Query and fragment are stripped because a Sold row and a closet row link to
 * the same listing with different tracking parameters, and two spellings of one
 * URL would read as two different listings.
 */
export function canonicalUrl(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.protocol}//${u.host.toLowerCase()}${path}`.toLowerCase();
  } catch {
    return trimmed.toLowerCase().replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

/**
 * The identity of one sale, so re-reading the same Sold page is a no-op.
 *
 * The platform's own order reference wins when it exists: the SAME order
 * re-read a day later may print a different relative date ("yesterday"), and
 * keying on the date would book the sale twice.
 */
export function dedupeKeyFor(platform: string, obs: SoldObservation): string {
  if (obs.orderRef && obs.orderRef.trim()) {
    return `${platform}:ref:${obs.orderRef.trim()}`;
  }
  const url = canonicalUrl(obs.listingUrl);
  if (url) return `${platform}:url:${url}:${obs.soldAt ?? ""}`;
  return `${platform}:title:${(obs.title ?? "").trim().toLowerCase()}:${obs.soldAt ?? ""}`;
}

function emptyPlan(status: ChannelStatus, reason: string | null): ObservationPlan {
  return {
    channelStatus: status,
    confirmed: [],
    review: [],
    unmatched: [],
    breakerTripped: false,
    failureReason: reason,
  };
}

function unmatchedFrom(obs: SoldObservation, key: string): UnmatchedSale {
  return {
    listingUrl: obs.listingUrl,
    title: obs.title,
    soldPriceCents: obs.soldPriceCents,
    soldAt: obs.soldAt,
    dedupeKey: key,
  };
}

/**
 * Title+price match, used ONLY when no URL matched.
 *
 * Returns a listing when EXACTLY ONE live listing fits. Two candidates is not a
 * weaker match, it is no match: picking one would attribute a sale to the wrong
 * garment, and the wrong garment's siblings are the ones that get delisted.
 */
function probableMatch(
  obs: SoldObservation,
  liveListings: readonly KnownListing[],
): KnownListing | null {
  const title = (obs.title ?? "").trim().toLowerCase();
  if (!title) return null;
  const candidates = liveListings.filter((l) => {
    if ((l.title ?? "").trim().toLowerCase() !== title) return false;
    if (obs.soldPriceCents == null || l.priceCents == null) return true;
    return l.priceCents === obs.soldPriceCents;
  });
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}

export function planObservations(input: PlanInput): ObservationPlan {
  const { batch, known, seenKeys } = input;

  if (!batch.signedIn) {
    return emptyPlan(
      "not_signed_in",
      "The extension found a login wall instead of the seller's own pages.",
    );
  }

  const onPlatform = known.filter((l) => l.platform === batch.platform);
  const live = onPlatform.filter((l) => LIVE_STATUSES.has(l.listingStatus));

  // ── zero rows where many were expected ──────────────────────────────────
  //
  // A COMPLETE closet read returning nothing while we know listings are live
  // is a selector failure, and its failure mode is the dangerous kind: an empty
  // closet looks exactly like a seller who sold out. Nothing is written.
  //
  // Zero SOLD rows is NOT this. Most reads of most closets on most hours find
  // no sales, and treating that as a fault would mark every healthy channel
  // failing.
  if (batch.closet && batch.closet.reachedEnd && batch.closet.listingUrls.length === 0 && live.length > 0) {
    return emptyPlan(
      "failing",
      `The closet read returned no listings while ${live.length} are believed live. ` +
        "That is a selector failure, not an empty closet.",
    );
  }

  // ── the circuit breaker ─────────────────────────────────────────────────
  const limit = Math.max(BREAKER_FLOOR, Math.floor(live.length * BREAKER_SHARE));
  if (batch.sold.length > limit) {
    return {
      channelStatus: "ok",
      confirmed: [],
      review: [{
        reason: "circuit_breaker",
        listingId: null,
        itemId: null,
        listingUrl: null,
        title: null,
        soldPriceCents: null,
        soldAt: null,
        dedupeKey: null,
        claimed: batch.sold.length,
        limit,
      }],
      unmatched: [],
      breakerTripped: true,
      failureReason:
        `The read reported ${batch.sold.length} sales against ${live.length} live listings ` +
        `(cap ${limit}). Refused whole and sent for review.`,
    };
  }

  const byUrl = new Map<string, KnownListing>();
  for (const l of onPlatform) {
    const u = canonicalUrl(l.listingUrl);
    if (u && !byUrl.has(u)) byUrl.set(u, l);
  }

  const confirmed: ConfirmedSale[] = [];
  const review: ReviewRow[] = [];
  const unmatched: UnmatchedSale[] = [];
  /** Listing ids this batch's sold rows account for, for count reconciliation. */
  const explained = new Set<string>();

  for (const obs of batch.sold) {
    const key = dedupeKeyFor(batch.platform, obs);
    if (seenKeys.has(key)) continue; // already booked; a second sighting is free

    const url = canonicalUrl(obs.listingUrl);
    const exact = url ? byUrl.get(url) ?? null : null;

    if (exact) {
      explained.add(exact.id);
      // Already sold in our own records: nothing new happened.
      if (!LIVE_STATUSES.has(exact.listingStatus)) continue;
      confirmed.push({
        listingId: exact.id,
        itemId: exact.itemId,
        soldPriceCents: obs.soldPriceCents,
        soldAt: obs.soldAt,
        dedupeKey: key,
      });
      continue;
    }

    const probable = probableMatch(obs, live);
    if (probable) {
      explained.add(probable.id);
      review.push({
        reason: "probable_match",
        listingId: probable.id,
        itemId: probable.itemId,
        listingUrl: obs.listingUrl,
        title: obs.title,
        soldPriceCents: obs.soldPriceCents,
        soldAt: obs.soldAt,
        dedupeKey: key,
      });
      continue;
    }

    unmatched.push(unmatchedFrom(obs, key));
  }

  // ── absence, and only on complete coverage ──────────────────────────────
  if (batch.closet && batch.closet.reachedEnd) {
    const seenUrls = new Set<string>();
    for (const u of batch.closet.listingUrls) {
      const c = canonicalUrl(u);
      if (c) seenUrls.add(c);
    }

    const vanished = live.filter((l) => {
      const u = canonicalUrl(l.listingUrl);
      return u !== null && !seenUrls.has(u);
    });
    const unexplainedRows = vanished.filter((l) => !explained.has(l.id));

    for (const l of unexplainedRows) {
      review.push({
        reason: "unexplained_absence",
        listingId: l.id,
        itemId: l.itemId,
        listingUrl: l.listingUrl,
        title: l.title,
        soldPriceCents: null,
        soldAt: null,
        dedupeKey: null,
      });
    }

    // Count reconciliation. The breaker catches a read claiming TOO MANY sales
    // and is blind to one matching too few: a selector that silently finds 3 of
    // 15 sold rows clears every threshold above. The closet does not lie about
    // its own size, so a shrink the sales cannot account for is raised on its
    // own rather than waiting to be asked.
    //
    // Gated on the batch having read the Sold page at all: a closet-only read
    // has nothing to reconcile against, and its absences are already reported
    // per listing above.
    if (batch.sold.length > 0 && unexplainedRows.length > 0) {
      review.push({
        reason: "count_gap",
        listingId: null,
        itemId: null,
        listingUrl: null,
        title: null,
        soldPriceCents: null,
        soldAt: null,
        dedupeKey: null,
        unexplained: unexplainedRows.length,
      });
    }
  }

  return {
    channelStatus: "ok",
    confirmed,
    review,
    unmatched,
    breakerTripped: false,
    failureReason: null,
  };
}
