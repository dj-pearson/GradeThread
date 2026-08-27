// US-2943: the once-a-day nudge about watchers worth an offer.
//
// ── WHY THIS IS NOT A NEW CRON ──────────────────────────────────────────────
//
// Same argument as the deadline reminders (post-sale-reminders.ts): the
// marketplace-events sweep already runs every 15 minutes, already holds the job
// lock, already has the connected-seller list, and is already in the cron
// ledger. What makes a 15-minute sweep send something ONCE A DAY is the claim
// key: `digest:YYYY-MM-DD`, so the first tick after midnight sends and the
// other ninety-five do nothing.
//
// ── AND ONLY WHEN THERE IS SOMETHING TO SAY ─────────────────────────────────
//
// A digest that arrives every morning reading "0 items" is one people mute
// inside a week, and muting the offers category takes the real offer
// notifications with it. Zero candidates sends nothing and claims nothing, so
// the day it does have something the digest still goes out.

import type { MarketplaceEventKind } from "./marketplace-event-notify.ts";
import type { OfferCandidate } from "./offer-candidates.ts";

export interface DigestDeps {
  /** Today's ranked candidates, cooldown already applied. */
  loadCandidates: (ownerId: string) => Promise<OfferCandidate[]>;
  claim: (
    ownerId: string,
    kind: MarketplaceEventKind,
    externalId: string,
    status: string,
    notificationType: string,
  ) => Promise<boolean>;
  release?: (
    ownerId: string,
    kind: MarketplaceEventKind,
    externalId: string,
    status: string,
  ) => Promise<void>;
  notify: (ev: { userId: string; count: number; watchers: number }) => Promise<void>;
  /** The day stamp, injected so the once-a-day rule is testable. */
  today: () => string;
}

/**
 * Send today's digest if it has not gone yet and there is something in it.
 * Returns 1 when it sent, 0 otherwise. Never throws.
 */
export async function sendOfferDigestForUser(
  ownerId: string,
  deps: DigestDeps,
): Promise<number> {
  let candidates: OfferCandidate[];
  try {
    candidates = await deps.loadCandidates(ownerId);
  } catch (err) {
    console.error(
      "[offer-digest] load failed:",
      err instanceof Error ? err.message : String(err),
    );
    return 0;
  }
  // Nothing to say: send nothing AND claim nothing, so a seller whose first
  // candidate appears at 4pm still gets the digest that day.
  if (candidates.length === 0) return 0;

  const key = `digest:${deps.today()}`;
  const fresh = await deps.claim(ownerId, "offer", key, "sent", "offer_candidate_digest");
  if (!fresh) return 0;

  try {
    await deps.notify({
      userId: ownerId,
      count: candidates.length,
      watchers: candidates.reduce((sum, c) => sum + (c.watchers || 0), 0),
    });
    return 1;
  } catch (err) {
    // Hand the claim back so a later tick today retries — the same rule every
    // other notifier here follows.
    await deps.release?.(ownerId, "offer", key, "sent");
    console.error(
      "[offer-digest] notify failed:",
      err instanceof Error ? err.message : String(err),
    );
    return 0;
  }
}

/** UTC day stamp. One digest per calendar day, whatever the sweep's cadence. */
export function utcDayStamp(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}
