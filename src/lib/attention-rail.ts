// US-3079: what the attention rail says, decided here rather than in JSX.
//
// The rail is one line above both overviews answering "how many things need me,
// and which is due first". Before it, the aging and stale badges sat inside
// their own cards and the eBay queues were on another page, so the answer took
// a scroll and a navigation.
//
// The ORDER is the product decision and it is fixed, not sorted by count. A
// seller with 40 aging items and one return due in two hours has one urgent
// problem and 40 slow ones; ranking by size would bury the return. So the order
// is by consequence of ignoring it: a marketplace deadline you can miss, then
// work you have queued, then inventory that is merely getting older.
//
// Pure and exported so the ordering, the zero-count rule and the all-clear case
// are tested as data rather than asserted against rendered markup.

/** A surface the rail can render on. Mirrors DashboardSurface. */
export type AttentionSurface = "grading" | "flipdesk";

export interface AttentionChip {
  /** Stable id, used as the React key and in tests. */
  id: string;
  /** The chip's own words, without the count. */
  label: string;
  count: number;
  href: string;
  /**
   * A short qualifier shown after the label, e.g. "due in 3 hours" for the
   * soonest needs-you deadline. Null when there is nothing to add — never a
   * placeholder, because "due —" reads as a missing value rather than as no
   * deadline.
   */
  hint: string | null;
}

export interface FlipdeskAttentionInput {
  /** Open post-sale work: returns, cases, disputes, inquiries, cancellations, offers. */
  needsYouCount: number;
  /**
   * Wording for the soonest deadline among those, already produced by
   * deadlineLabel so the rail and the post-sale page cannot word it differently.
   * Null when nothing carries a deadline.
   */
  needsYouDeadlineLabel: string | null;
  draftsToReview: number;
  syncConflicts: number;
  extensionJobsPending: number;
  agingCount: number;
  staleCount: number;
}

export interface GradingAttentionInput {
  inReview: number;
  failed: number;
  disputed: number;
}

export interface AttentionInputs {
  surface: AttentionSurface;
  flipdesk?: FlipdeskAttentionInput | null;
  grading?: GradingAttentionInput | null;
}

/**
 * Where each chip goes. Every one is a route that exists in
 * src/routes/index.tsx; a chip that links nowhere is worse than no chip,
 * because it costs a click to learn that.
 */
export const ATTENTION_HREF = {
  needsYou: "/dashboard/flipdesk/post-sale",
  draftsToReview: "/dashboard/flipdesk/autolister?view=drafts",
  syncConflicts: "/dashboard/flipdesk/marketplaces",
  extensionJobs: "/dashboard/flipdesk/marketplaces",
  aging: "/dashboard/flipdesk/inventory",
  stale: "/dashboard/flipdesk/inventory",
  inReview: "/dashboard/submissions?status=pending_review",
  failed: "/dashboard/submissions?status=failed",
  disputed: "/dashboard/submissions?status=disputed",
} as const;

/** What the rail says when every count is zero. */
export const ALL_CLEAR = "All clear";

/**
 * The chips, in fixed urgency order, with zero counts omitted.
 *
 * A count that could not be READ is the caller's problem, not this function's:
 * pass 0 for "nothing waiting" and the chip disappears, which is right. A
 * failed query must not be turned into 0 here — that renders "All clear" over
 * an unknown, and the component keeps its own loading and error states for it.
 */
export function buildAttentionChips(inputs: AttentionInputs): AttentionChip[] {
  const out: AttentionChip[] = [];
  const push = (
    id: string,
    label: string,
    count: number,
    href: string,
    hint: string | null = null,
  ) => {
    if (count > 0) out.push({ id, label, count, href, hint });
  };

  const f = inputs.flipdesk;
  if (inputs.surface === "flipdesk" && f) {
    push(
      "needs-you",
      "needs you",
      f.needsYouCount,
      ATTENTION_HREF.needsYou,
      f.needsYouDeadlineLabel,
    );
    push("drafts", "drafts to review", f.draftsToReview, ATTENTION_HREF.draftsToReview);
    push("conflicts", "sync conflicts", f.syncConflicts, ATTENTION_HREF.syncConflicts);
    push(
      "extension",
      "extension jobs pending",
      f.extensionJobsPending,
      ATTENTION_HREF.extensionJobs,
    );
    push("aging", "aging items", f.agingCount, ATTENTION_HREF.aging);
    push("stale", "stale listings", f.staleCount, ATTENTION_HREF.stale);
  }

  const g = inputs.grading;
  if (inputs.surface === "grading" && g) {
    push("in-review", "in review", g.inReview, ATTENTION_HREF.inReview);
    push("failed", "failed", g.failed, ATTENTION_HREF.failed);
    push("disputed", "disputed", g.disputed, ATTENTION_HREF.disputed);
  }

  return out;
}

/**
 * The oldest `dataUpdatedAt` across the board's queries — the age of the
 * STALEST thing on screen.
 *
 * Oldest rather than newest on purpose. "Updated 2 seconds ago" next to a
 * widget whose data is an hour old is a lie the seller cannot see; the rail
 * should be no fresher than its worst number. Zero and negative timestamps are
 * ignored: TanStack Query uses 0 for a query that has never resolved, and
 * treating that as 1970 would pin the whole rail to "56 years ago".
 */
export function oldestUpdatedAt(stamps: readonly number[]): number | null {
  const real = stamps.filter((n) => Number.isFinite(n) && n > 0);
  if (real.length === 0) return null;
  return Math.min(...real);
}
