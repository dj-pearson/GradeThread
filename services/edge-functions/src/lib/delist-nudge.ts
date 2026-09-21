// US-3453: the no-drain nudge, decided here and only here.
//
// A garment sells while the seller's laptop is shut. autoEndCrossListings
// (US-3141) stamps the extension siblings, queues their delists and sends one
// notice (US-3144). Then nothing: the queue waits for a browser that may not
// open until tomorrow, and the listing stays live and purchasable the whole
// time. This is the second sentence, sent when a delist has waited past the
// threshold with no browser having drained anything since it was queued.
//
// EVERY JUDGEMENT IS HERE, as a pure function, and routes/jobs-delist-nudge.ts
// does the reads. The threshold, the repeat suppression and the wording are
// each a sentence a small change would make false, so each one is pinned in
// tests/delist-nudge_test.ts.
//
// NO NEW STATE. "At most one notice per hour" is answered by the seller's own
// notifications rows of type delist_needed (the sale-time notice counts as
// telling them), and "no browser has drained" by the queue's own claimed_at,
// the same read the queue tray and the stale-queue job use. The type stays
// delist_needed because notification_type is a Postgres enum, the category
// (delist_reminders) is the one a seller expects to switch this off with, and
// the iOS push category delist.needed already lands on the pending row.

/** How long a queued delist may wait before the seller is told again. */
export const NUDGE_AFTER_MINUTES = 30;

/** The floor between two delist notices to one seller. */
export const NUDGE_REPEAT_HOURS = 1;

/** The category the seller switches this off with; the same as the sale-time notice. */
export const DELIST_NUDGE_PREF_KEY = "delist_reminders";

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export interface NudgeQueueRow {
  id: string;
  user_id: string;
  platform: string;
  inventory_item_id: string | null;
  listing_id: string | null;
  created_at: string;
  expires_at: string;
}

export interface NudgeInput {
  /** This seller's delist rows still in status queued. */
  rows: readonly NudgeQueueRow[];
  /** When this seller's extension last claimed any row; null if never. */
  lastDrainedAt: string | null;
  /** The newest delist_needed notice already sent to this seller. */
  lastNoticeAt: string | null;
  now: Date;
}

export type NudgeSkipReason = "nothing_old_enough" | "drained_since" | "told_recently";

export type NudgeVerdict =
  | { notify: true; rows: NudgeQueueRow[] }
  | { notify: false; reason: NudgeSkipReason };

/**
 * Should this seller be told again, and about which rows?
 *
 * Order matters and each step is the cheap answer to the previous one's
 * question: is anything old enough; has a browser run since the oldest of
 * those was queued (if so the drain is alive and left the row, which the
 * queue tray already reports); has the seller been told inside the hour.
 */
export function shouldNudge(input: NudgeInput): NudgeVerdict {
  const nowMs = input.now.getTime();
  const cutoff = nowMs - NUDGE_AFTER_MINUTES * MINUTE_MS;
  const old = input.rows.filter((r) => {
    const created = Date.parse(r.created_at);
    const expires = Date.parse(r.expires_at);
    return Number.isFinite(created) && created <= cutoff && (!Number.isFinite(expires) || expires > nowMs);
  });
  if (old.length === 0) return { notify: false, reason: "nothing_old_enough" };

  const oldest = Math.min(...old.map((r) => Date.parse(r.created_at)));
  const drained = input.lastDrainedAt ? Date.parse(input.lastDrainedAt) : NaN;
  if (Number.isFinite(drained) && drained > oldest) return { notify: false, reason: "drained_since" };

  const told = input.lastNoticeAt ? Date.parse(input.lastNoticeAt) : NaN;
  if (Number.isFinite(told) && nowMs - told < NUDGE_REPEAT_HOURS * HOUR_MS) {
    return { notify: false, reason: "told_recently" };
  }
  return { notify: true, rows: old };
}

/** Rows grouped by seller. Pure, so the tenancy of the sweep is a tested fact. */
export function groupByOwner(rows: readonly NudgeQueueRow[]): Map<string, NudgeQueueRow[]> {
  const out = new Map<string, NudgeQueueRow[]>();
  for (const r of rows) {
    const arr = out.get(r.user_id) ?? [];
    arr.push(r);
    out.set(r.user_id, arr);
  }
  return out;
}

/** The seller's per-category channel switches, as users.notification_preferences holds them. */
export type NudgePrefs = Record<string, { in_app?: boolean; push?: boolean } | undefined> | null | undefined;

/**
 * Which channels this seller still has open for delist reminders. Default on;
 * only an explicit false closes a channel, the same reading notify.ts makes.
 * Both closed means the seller turned the category off and gets nothing,
 * which the job counts as opted out rather than as a send.
 */
export function nudgeChannels(prefs: NudgePrefs): { inApp: boolean; push: boolean } {
  const cat = prefs?.[DELIST_NUDGE_PREF_KEY];
  return { inApp: cat?.in_app !== false, push: cat?.push !== false };
}

export interface NudgeListing {
  platform: string;
  itemId: string | null;
  itemTitle: string | null;
  listingUrl: string | null;
}

export interface NudgeNotice {
  title: string;
  message: string;
  link: string;
}

function label(platform: string): string {
  return platform === "facebook" ? "Facebook Marketplace" : platform.charAt(0).toUpperCase() + platform.slice(1);
}

/**
 * The words. Names every listing by marketplace and garment, then the two
 * ways out, in that order, because the list is what the seller acts on and
 * the ways out are how.
 */
export function nudgeNotice(listings: readonly NudgeListing[]): NudgeNotice {
  const lines = listings.map((l) => {
    const what = l.itemTitle ? `"${l.itemTitle}"` : "an item";
    return `${what} on ${label(l.platform)}`;
  });
  const which = lines.length === 1
    ? lines[0]!
    : `${lines.slice(0, -1).join(", ")} and ${lines[lines.length - 1]}`;
  const itemIds = [...new Set(listings.map((l) => l.itemId).filter((id): id is string => !!id))];
  const link = itemIds.length === 1
    ? `/dashboard/flipdesk/inventory?item=${itemIds[0]}&pendingDelists=1`
    : "/dashboard/flipdesk/inventory?pendingDelists=1";
  return {
    title: lines.length === 1 ? "Still live: nothing has ended it" : `Still live: ${lines.length} listings`,
    message:
      `${which} sold elsewhere and ${lines.length === 1 ? "is" : "are"} still up, because no browser ` +
      "with the GradeThread extension has run since. Open your browser to let it end them, " +
      "or end them now on your phone.",
    link,
  };
}
