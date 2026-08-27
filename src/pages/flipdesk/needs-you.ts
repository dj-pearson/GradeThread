// US-2934: one ranked list of everything eBay is waiting on.
//
// A seller had six queues — returns, cancellations, inquiries, cases, payment
// disputes, expiring offers — and no single place that said what runs out
// first. Every one of them carries a clock the seller loses by default, and the
// order they appear in on their own cards is eBay's order, not urgency.
//
// ── THE RANK IS DEADLINE, THEN MONEY ────────────────────────────────────────
//
// Deadline first because that is the only thing that can be lost by waiting: a
// $200 dispute due next week is genuinely less urgent than a $12 return due
// today, and every "sort by value" version of this screen gets that backwards.
// Money breaks the tie, because between two things due today the expensive one
// is the one to open.
//
// An item with NO deadline sorts last, not first. eBay is running no clock on
// it, so it is genuinely less urgent than anything that has one — the opposite
// of the usual "unknown is scary" default, and the same rule byDeadline uses.
//
// Pure, so the ordering is testable without rendering anything.

export type NeedsYouKind =
  | "case"
  | "inquiry"
  | "dispute"
  | "return"
  | "cancellation"
  | "offer";

export interface NeedsYouItem {
  kind: NeedsYouKind;
  /** The eBay-side id, unique within its kind. */
  id: string;
  /** What it is about — the garment, or the order when we cannot name one. */
  subject: string;
  /** ISO deadline, or null when there is none we can read. */
  deadline: string | null;
  /** What is at stake, in cents. Null when unknown. */
  amountCents: number | null;
  /** The single most likely next action, as a verb the seller reads. */
  action: string;
}

/** What each queue is called in a sentence, and how urgent it is by nature. */
export const KIND_LABEL: Record<NeedsYouKind, string> = {
  case: "eBay case",
  inquiry: "Item not received",
  dispute: "Payment dispute",
  return: "Return",
  cancellation: "Cancellation",
  offer: "Offer",
};

function deadlineKey(iso: string | null): number {
  const t = iso ? Date.parse(iso) : Number.NaN;
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

/**
 * Rank the merged queue. Pure, stable, and does not mutate its input.
 *
 * Deadline ascending, undated last; then amount descending, unknown amounts
 * last within their deadline group. `kind` is deliberately NOT part of the
 * rank: a case is more damaging than a return, but a case due in six days is
 * still not more urgent than a return due in three hours, and encoding a
 * severity order here would quietly override the clock.
 */
export function rankNeedsYou(items: readonly NeedsYouItem[]): NeedsYouItem[] {
  return [...items].sort((a, b) => {
    const da = deadlineKey(a.deadline);
    const db = deadlineKey(b.deadline);
    if (da !== db) return da - db;
    const ma = a.amountCents ?? -1;
    const mb = b.amountCents ?? -1;
    if (ma !== mb) return mb - ma;
    // Last resort so the order is stable across renders rather than depending
    // on which query resolved first.
    return `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`);
  });
}

/** A stable key for React, unique across the six queues. */
export function needsYouKey(item: NeedsYouItem): string {
  return `${item.kind}:${item.id}`;
}
