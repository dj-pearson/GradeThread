import { SUBMISSION_STATUSES } from "@/lib/constants";

// US-3075: the pure half of the two new grading widgets.
//
// The queue widget and the attention widget both answer "what should I do
// next", and everything that decides the answer lives here with no React and
// no Supabase, so each rule is a plain unit test: the tally, the two links, the
// age string, and the seed the submissions list reads out of its own URL.

/**
 * The statuses the queue reports on.
 *
 * SUBMISSION_STATUSES, not the database enum: `SubmissionStatus` also carries
 * `needs_photos` and the retired-checkout values, which are pipeline states the
 * submissions list has never offered as a filter. A tile that links to a filter
 * the list cannot apply is a dead end.
 */
export type QueueStatus = (typeof SUBMISSION_STATUSES)[number];

/** One count per submission status. Every status is present, zero included. */
export type QueueCounts = Record<QueueStatus, number>;

/** A zeroed tally, so a status with no rows still renders its tile. */
export function emptyQueueCounts(): QueueCounts {
  return Object.fromEntries(SUBMISSION_STATUSES.map((s) => [s, 0])) as QueueCounts;
}

/**
 * Tally one grouped read into a count per status.
 *
 * THE READ IS ONE REQUEST, not one per status. Six head counts would be six
 * round trips for six numbers off the same rows, and they could not agree with
 * each other: a submission that finishes grading between the third and fourth
 * request is counted in neither `processing` nor `completed`. PostgREST's
 * `count()` aggregate would push the grouping into Postgres, but self-hosted
 * PostgREST ships with `db-aggregates-enabled` off and turning it on is a
 * server change this story does not get to make; an RPC would need a migration,
 * which this story also does not have. So the read selects the one column it
 * groups by and the tally happens here, over rows RLS has already scoped to the
 * signed-in account.
 *
 * A status the enum does not know about is ignored rather than added, so a new
 * database enum value cannot render a tile with no label and no link.
 */
export function tallySubmissionStatuses(
  rows: readonly { status: string | null }[],
): QueueCounts {
  const counts = emptyQueueCounts();
  for (const row of rows) {
    const status = row.status;
    if (status && status in counts) counts[status as QueueStatus] += 1;
  }
  return counts;
}

/** The submissions list, filtered to one status. */
export function submissionsStatusHref(status: QueueStatus): string {
  return `/dashboard/submissions?status=${status}`;
}

/** One submission's own page. */
export function submissionHref(id: string): string {
  return `/dashboard/submissions/${id}`;
}

/**
 * The statuses the attention widget shows, in the order it prefers them.
 *
 * `pending` and `processing` are deliberately absent: they are the pipeline
 * working, and nothing is waiting on the seller. `completed` is done. These
 * three are the only ones where a person has to act.
 */
export const ATTENTION_STATUSES = [
  "pending_review",
  "failed",
  "disputed",
] as const satisfies readonly QueueStatus[];

/** The quiet state, spelled once so the widget and its test cannot drift. */
export const ATTENTION_QUIET_STATE = "Nothing waiting on you";

/** `pending_review` -> `Pending Review`. */
export function formatStatusLabel(status: string): string {
  return status
    .split(/[-_]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * How long a submission has been sitting, as a person would say it.
 *
 * Coarse on purpose. The number is there to sort the seller's attention, not
 * to time anything, and "waiting 3 days" reads as a problem in a way that a
 * timestamp does not. A future date (clock skew between the browser and the
 * database) reads as "just now" rather than as a negative age.
 */
export function formatAge(createdAt: string, now: Date = new Date()): string {
  const then = new Date(createdAt).getTime();
  if (!Number.isFinite(then)) return "";
  const minutes = Math.floor((now.getTime() - then) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 31) return `${days} day${days === 1 ? "" : "s"} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

/** What the submissions list uses when no status is pinned. */
export const ALL_STATUSES_FILTER = "all";

/**
 * The status filter the submissions list should open on, read from its own URL.
 *
 * The queue widget's tiles are the only thing that writes this parameter, and
 * before US-3075 the list ignored it entirely: every tile landed on the same
 * unfiltered table and the seller had to re-pick the status they had just
 * clicked. Anything that is not a known status resolves to "all", so a hand
 * edited or stale link opens a working page rather than an empty one.
 */
export function statusFilterFromSearch(
  params: URLSearchParams | string,
): string {
  const search =
    typeof params === "string" ? new URLSearchParams(params) : params;
  const value = search.get("status");
  return value && (SUBMISSION_STATUSES as readonly string[]).includes(value)
    ? value
    : ALL_STATUSES_FILTER;
}
