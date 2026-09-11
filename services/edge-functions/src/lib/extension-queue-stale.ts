// US-3198 AC4: decide whether a seller should be told their extension queue is
// sitting there.
//
// Pure on purpose. The three things that are wrong in production about a notice
// like this are the threshold, the window arithmetic and the wording, and none
// of them is testable through a web-push transport. The cron in
// routes/jobs-extension-queue-stale.ts does the reads; every judgement lives
// here.
//
// WHAT THIS NOTICE SAYS, AND WHAT IT MUST NEVER SAY. It reports that work has
// NOT happened. So the copy may not claim a queued job ran (the US-2481 honesty
// rule, AC5), and it may not imply either that the seller did something wrong or
// that GradeThread failed. Neither is known, and the usual cause is a closed
// laptop. See `staleQueueNotice` for the wording that follows from that.

import { EXTENSION_DELIST_PLATFORMS } from "./cross-listing-sale.ts";

/**
 * How many jobs must be waiting before this is worth a buzz.
 *
 * DERIVED, NOT PICKED. One garment can produce at most one queue row per
 * extension channel, and there are exactly five of those (poshmark, mercari,
 * grailed, vinted, facebook). So `channels + 1` is the smallest count that
 * cannot come from a single garment: at this number, at least two items are
 * stranded, which is a backlog rather than a Tuesday.
 *
 * Both wrong answers are cheap to picture at this product's size (a few hundred
 * pageviews a month). A threshold of 3 fires when a seller cross-lists one shirt
 * to three channels and opens their laptop after dinner, which trains them to
 * swipe the notice away. A threshold of 25 describes a seller this product does
 * not have yet, so the notice would never fire at all and the AC would be
 * satisfied only on paper.
 *
 * It moves on its own when a channel is added, which is the intent. The test
 * pins today's value at 6 so that move is visible in a diff rather than silent.
 */
export const STALE_QUEUE_THRESHOLD = EXTENSION_DELIST_PLATFORMS.size + 1;

/** AC4's window: no drain in this long. */
export const DRAIN_SILENCE_HOURS = 24;

/**
 * How wide the notice window is, and therefore the whole repeat-suppression
 * mechanism.
 *
 * There is no per-seller "last notified" column to write and this story may not
 * add one, so the throttle has to fall out of the arithmetic. It does: the job
 * fires only while the silence is inside [24h, 48h), and the job runs once a
 * day. Run times are spaced exactly one period apart, so exactly one run can
 * ever land inside a half-open window one period wide. One notice per stale
 * spell, no state.
 *
 * KEEP THIS EQUAL TO THE CRON PERIOD in CRON_REGISTRY ("extension-queue-stale",
 * daily). Make the window wider than the period and a seller gets a buzz every
 * morning until they open their laptop; make it narrower and most sellers fall
 * through the gap and are never told at all.
 *
 * What it deliberately does not cover: a queue that crosses the threshold on day
 * four of a silence gets no notice, because the one eligible run already went
 * by. That is the honest cost of having no state, and it errs toward silence,
 * which is the right direction for a notification that interrupts someone.
 */
export const NOTICE_WINDOW_HOURS = 24;

const HOUR_MS = 3_600_000;

export interface StaleQueueInput {
  /** Live rows (queued + claimed, not expired) this seller has waiting. */
  pendingCount: number;
  /** max(claimed_at) across every row this seller has ever queued, or null. */
  lastDrainedAt: string | null;
  /**
   * Has this seller already had a `delist_needed` notice (US-3144) inside the
   * silence window? See `shouldNotifyStaleQueue` for why that silences this one.
   */
  recentDelistNotice: boolean;
  now: Date;
}

export type StaleQueueSkipReason =
  /** No row has ever been claimed, so no extension has ever run here. */
  | "never_drained"
  /** Fewer than STALE_QUEUE_THRESHOLD jobs waiting. */
  | "below_threshold"
  /** A drain happened inside the last DRAIN_SILENCE_HOURS. */
  | "drained_recently"
  /** The silence is older than the window, so an earlier run already said so. */
  | "already_told"
  /** US-3144 already told them about this same pile today. */
  | "told_by_delist_notice";

export type StaleQueueVerdict =
  | { notify: true; pendingCount: number }
  | { notify: false; reason: StaleQueueSkipReason };

/**
 * Should this seller be pushed?
 *
 * NEVER-DRAINED IS EXCLUDED, AND IT IS THE FIRST CHECK ON PURPOSE.
 *
 * "No drain in 24h" and "something is wrong" are not the same sentence, and the
 * gap between them is a whole class of seller: somebody who queued work from
 * their phone and has not installed the desktop extension at all. Telling that
 * person their queue is stale is worse than telling them nothing. It names a
 * machine they have never had as the thing that let them down, and the fix it
 * implies (open your browser, it will run) is one they cannot perform.
 *
 * US-3198 AC2 already drew that line on screen: the tray says "Your extension
 * has never run any of this" instead of rendering a blank panel, and undoing it
 * here would put the two surfaces back into disagreement. `lastDrainedAt` is
 * null for exactly this seller, and null is a skip.
 *
 * A seller who queues on Friday and opens their desktop on Monday is also not
 * broken, which is why the notice fires once and stops (see NOTICE_WINDOW_HOURS)
 * rather than nagging for the length of a weekend.
 */
export function shouldNotifyStaleQueue(input: StaleQueueInput): StaleQueueVerdict {
  const drainedMs = input.lastDrainedAt === null
    ? Number.NaN
    : Date.parse(input.lastDrainedAt);
  // An unparseable timestamp reads as never-drained rather than as a fresh
  // drain: the quiet answer is the safe one for a notification.
  if (!Number.isFinite(drainedMs)) return { notify: false, reason: "never_drained" };

  if (input.pendingCount < STALE_QUEUE_THRESHOLD) {
    return { notify: false, reason: "below_threshold" };
  }

  const silenceMs = input.now.getTime() - drainedMs;
  if (silenceMs < DRAIN_SILENCE_HOURS * HOUR_MS) {
    return { notify: false, reason: "drained_recently" };
  }
  if (silenceMs >= (DRAIN_SILENCE_HOURS + NOTICE_WINDOW_HOURS) * HOUR_MS) {
    return { notify: false, reason: "already_told" };
  }

  // US-3144 fires at the moment of a sale and says "an item sold and its
  // listings are still live". This one says "jobs are waiting for your desktop".
  // A seller whose queue was already stale when a sale landed would get both
  // inside a day, about one pile of work, from one company. The older notice
  // wins: it is more specific (it names the garment) and it arrived first.
  if (input.recentDelistNotice) {
    return { notify: false, reason: "told_by_delist_notice" };
  }

  return { notify: true, pendingCount: input.pendingCount };
}

/** The preference category this push is gated on. Mirrors the frontend key in
 *  src/lib/notification-preferences.ts, pinned by src/test/extension-queue-stale-pref.test.ts. */
export const EXTENSION_QUEUE_PREF_KEY = "extension_queue_reminders";

/** Where the tray lives (US-3198 AC1/AC2), so the tap lands on the counts. */
export const STALE_QUEUE_LINK = "/dashboard/flipdesk/marketplaces";

export interface StaleQueueNotice {
  title: string;
  body: string;
  url: string;
}

/**
 * The wording, kept here so a test can hold it.
 *
 * Three things it is not allowed to do, each of which the obvious draft does:
 *
 *   1. Claim the work happened. "Nothing has run yet" is the first clause for
 *      that reason: a seller who reads only the title has to be left knowing
 *      the queue is still a queue.
 *   2. Blame the seller. The subject of the verb is the extension, not "you".
 *      "You have not opened your laptop" is both an accusation and a guess.
 *   3. Claim GradeThread broke. It did not, as far as anything here knows. The
 *      commonest cause by a distance is a shut laptop, and "something went
 *      wrong" would send a working seller to support.
 */
export function staleQueueNotice(pendingCount: number): StaleQueueNotice {
  return {
    title: `${pendingCount} queued jobs are waiting for your desktop`,
    body: "Nothing has run yet. Your Lister extension has not drained the queue " +
      "for over a day, and it will as soon as you open the browser it is installed in.",
    url: STALE_QUEUE_LINK,
  };
}
