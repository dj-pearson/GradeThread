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
  /**
   * What to print instead of `count` when the count is a floor rather than
   * the total, e.g. "500+" for a capped read. Absent when count is exact.
   */
  countLabel?: string;
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
  /** True when the drafts read hit its cap, so draftsToReview is a floor. */
  draftsTruncated?: boolean;
  syncConflicts: number;
  extensionJobsPending: number;
  /**
   * Extension jobs that failed or expired (the queue's needsAttention). A
   * failed delist is a double-sale risk, so this ranks right after needs-you.
   */
  extensionJobsFailed?: number;
  /** Finished extension runs that still want a human (finishedNeedsReview). */
  extensionJobsToReview?: number;
  agingCount: number;
  staleCount: number;
}

export interface GradingAttentionInput {
  /** needs_photos: the quality gate asked the SELLER for new photos. */
  needsPhotos?: number;
  /** pending_review: waiting on GradeThread staff, not the seller. */
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
/**
 * Where sync conflicts are resolved. Shared by the rail chip and the
 * flipdesk.sync-conflicts widget so the two cannot point at different pages;
 * /marketplaces renders no conflicts at all.
 */
export const SYNC_CONFLICTS_HREF =
  "/dashboard/flipdesk/money?view=reconcile&tab=cross-source";

export const ATTENTION_HREF = {
  needsYou: "/dashboard/flipdesk/post-sale",
  draftsToReview: "/dashboard/flipdesk/autolister?view=drafts",
  syncConflicts: SYNC_CONFLICTS_HREF,
  extensionJobs: "/dashboard/flipdesk/marketplaces#extension-queue",
  aging: "/dashboard/flipdesk/inventory",
  // Same destination as the flipdesk.stale widget's own "see all" link.
  stale: "/dashboard/flipdesk/analytics/performance",
  needsPhotos: "/dashboard/submissions?status=needs_photos",
  inReview: "/dashboard/submissions?status=pending_review",
  failed: "/dashboard/submissions?status=failed",
  disputed: "/dashboard/submissions?status=disputed",
} as const;

/**
 * The query-key prefixes the rail reads that are NOT registry widgets'. The
 * Refresh control unions these into its invalidations, or the rail's own
 * counts would be the one thing on the page it does not refresh.
 */
export const RAIL_QUERY_KEYS = ["attention-rail-grading"] as const;

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
    countLabel?: string,
  ) => {
    if (count > 0) {
      out.push(
        countLabel
          ? { id, label, count, countLabel, href, hint }
          : { id, label, count, href, hint },
      );
    }
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
    push(
      "extension-failed",
      "extension jobs failed",
      f.extensionJobsFailed ?? 0,
      ATTENTION_HREF.extensionJobs,
    );
    push(
      "drafts",
      "drafts to review",
      f.draftsToReview,
      ATTENTION_HREF.draftsToReview,
      null,
      f.draftsTruncated ? `${f.draftsToReview}+` : undefined,
    );
    push(
      "extension-review",
      "extension runs to check",
      f.extensionJobsToReview ?? 0,
      ATTENTION_HREF.extensionJobs,
    );
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
    // needs_photos first: it is the one grading status that waits on the
    // seller. pending_review waits on GradeThread staff, so it ranks last and
    // is worded as progress rather than as work.
    push("needs-photos", "need new photos", g.needsPhotos ?? 0, ATTENTION_HREF.needsPhotos);
    push("failed", "failed", g.failed, ATTENTION_HREF.failed);
    push("disputed", "disputed", g.disputed, ATTENTION_HREF.disputed);
    push("in-review", "being finalized", g.inReview, ATTENTION_HREF.inReview);
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

/** What the rail's chip area shows. */
export type RailState = "loading" | "all-clear" | "chips" | "error";

export interface RailStateInput {
  chips: readonly AttentionChip[];
  /** Names of the sources whose read failed. */
  failed: readonly string[];
  loading: boolean;
  /** A source answered with only part of its data (useNeedsYou.isPartial). */
  partial: boolean;
}

/**
 * Which of the four states the rail is in.
 *
 * The rule this exists for: "All clear" is a claim that every source was
 * checked and every count was zero. A failed or partial read is not zero, it
 * is unknown, so it can never produce 'all-clear'. With chips to show the rail
 * shows them and adds a "Could not check" chip; with none it is an error.
 */
export function railState(input: RailStateInput): RailState {
  if (input.loading) return "loading";
  const unsure = input.failed.length > 0 || input.partial;
  if (input.chips.length > 0) return "chips";
  return unsure ? "error" : "all-clear";
}

/**
 * True for an error that means "this account's plan does not include this
 * read" rather than "the read failed". A plan-gated source is not applicable,
 * so it must not count as a source the rail could not check.
 */
export function isPlanGateError(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return status === 402 || status === 403;
}
