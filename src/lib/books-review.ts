import { supabase } from "@/lib/supabase";

// US-2992 — books health.
//
// The queue is computed in Postgres (migration 00699). This file holds the
// copy: what each issue MEANS in money, which is the difference between a list
// a seller works through and a list they close.

export type IssueKind =
  | "no_cost_basis"
  | "uncategorised"
  | "sale_without_fees"
  | "unmatched_payout"
  | "missing_receipt"
  | "no_inventory_snapshot"
  | "archived_no_reason";

export interface ReviewIssue {
  kind: IssueKind;
  subject_id: string;
  title: string;
  happened_on: string;
  /** Exact cost of leaving it, where that is knowable. */
  impact_cents: number | null;
  /** Derived from the seller's OWN median cost ratio, where the true figure was never recorded. */
  estimated_impact_cents: number | null;
  severity: number;
  fix_kind: "item" | "expense" | "sale" | "payout" | "snapshot";
}

type Rpc = {
  rpc: ((
    fn: "books_review_queue",
    args: { p_from: string; p_to: string },
  ) => Promise<{ data: ReviewIssue[] | null; error: { message: string } | null }>) &
    ((
      fn: "books_review_count",
      args: { p_from: string; p_to: string },
    ) => Promise<{ data: number | null; error: { message: string } | null }>);
};

export async function fetchReviewQueue(
  from: string,
  to: string,
): Promise<ReviewIssue[]> {
  const client = supabase as unknown as Rpc;
  const { data, error } = await client.rpc("books_review_queue", {
    p_from: from,
    p_to: to,
  });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function fetchReviewCount(
  from: string,
  to: string,
): Promise<number> {
  const client = supabase as unknown as Rpc;
  const { data, error } = await client.rpc("books_review_count", {
    p_from: from,
    p_to: to,
  });
  if (error) throw new Error(error.message);
  return data ?? 0;
}

export async function dismissIssue(
  userId: string,
  kind: IssueKind,
  subjectId: string,
  reason: string,
): Promise<void> {
  const { error } = await supabase
    .from("books_review_dismissals")
    .insert({
      user_id: userId,
      issue_kind: kind,
      subject_id: subjectId,
      reason,
    } as never);
  if (error) throw error;
}

export async function undismissIssue(
  kind: IssueKind,
  subjectId: string,
): Promise<void> {
  const { error } = await supabase
    .from("books_review_dismissals")
    .delete()
    .eq("issue_kind", kind)
    .eq("subject_id", subjectId);
  if (error) throw error;
}

export interface DismissedIssue {
  id: string;
  issue_kind: string;
  subject_id: string;
  reason: string;
  dismissed_at: string;
}

export async function fetchDismissals(): Promise<DismissedIssue[]> {
  const { data, error } = await supabase
    .from("books_review_dismissals")
    .select("id, issue_kind, subject_id, reason, dismissed_at")
    .order("dismissed_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as DismissedIssue[];
}

// ── What each issue means ──────────────────────────────────────────────────

interface IssueCopy {
  heading: string;
  /** What it costs, in real terms. AC3. */
  consequence: string;
  action: string;
}

const COPY: Record<IssueKind, IssueCopy> = {
  archived_no_reason: {
    heading: "Archived, but we do not know why",
    consequence:
      "An archived item still counts as stock you are holding, so your ending inventory is too high, your cost of goods sold is too low, and you are taxed on profit you did not make. The answer also decides where it goes: something you kept reduces purchases, something lost or donated reduces inventory.",
    action: "Say what happened to it",
  },
  no_cost_basis: {
    heading: "Sold, but we do not know what it cost you",
    consequence:
      "Your profit is too high by whatever you paid for it, and you are taxed on that. It is also missing from cost of goods sold.",
    action: "Add what you paid",
  },
  uncategorised: {
    heading: "Not sorted into anything",
    consequence:
      "Nothing filed under Other reaches your tax return, so this is a deduction you are entitled to and are not taking.",
    action: "Give it a category",
  },
  sale_without_fees: {
    heading: "A sale with no fees recorded",
    consequence:
      "Every marketplace charges something, so a zero is almost always an import that dropped them. Your profit looks higher than it was and you lose the deduction.",
    action: "Add the fees",
  },
  unmatched_payout: {
    heading: "Money arrived against no sale",
    consequence:
      "Either a sale is missing from your books, or this payout is being counted twice. Both change your numbers and neither is visible anywhere else.",
    action: "Match it up",
  },
  missing_receipt: {
    heading: "No receipt for a sizeable expense",
    consequence:
      "The deduction is not wrong, but it is the one you could not defend if anyone asked. Above $75 the IRS expects you to have kept something.",
    action: "Attach the receipt",
  },
  no_inventory_snapshot: {
    heading: "Inventory was never counted",
    consequence:
      "Schedule C Part III asks what you were holding at the start and end of the year, and we cannot answer either. It gets worse with time: once you edit an item's cost, that year's figure is gone for good.",
    action: "Count it now",
  },
};

export function issueCopy(kind: IssueKind): IssueCopy {
  return COPY[kind];
}

/**
 * The money line for one issue.
 *
 * Three shapes, and the third is the point: where the true figure was never
 * recorded, saying so beats inventing one. The estimate is derived from the
 * seller's own history and is labelled as an estimate every time it appears.
 */
export function impactLabel(issue: ReviewIssue): string {
  if (issue.impact_cents !== null) {
    return `$${(issue.impact_cents / 100).toFixed(2)}`;
  }
  if (issue.estimated_impact_cents !== null) {
    return `about $${(issue.estimated_impact_cents / 100).toFixed(2)}`;
  }
  return "unknown";
}

/** Longer form, for the row body. Says WHERE an estimate came from. */
export function impactExplanation(issue: ReviewIssue): string | null {
  if (issue.impact_cents !== null) return null;
  if (issue.estimated_impact_cents !== null) {
    return "Estimated from what your other items typically cost against what they sold for. Your real figure could be very different.";
  }
  return "We cannot put a number on this one.";
}

/**
 * Total exposure, counting estimates.
 *
 * Returns the two separately, because adding a guess to a set of exact figures
 * and printing one total would make the whole thing look measured.
 */
export function totalImpact(issues: readonly ReviewIssue[]): {
  exactCents: number;
  estimatedCents: number;
  unknownCount: number;
} {
  let exactCents = 0;
  let estimatedCents = 0;
  let unknownCount = 0;
  for (const i of issues) {
    if (i.impact_cents !== null) exactCents += i.impact_cents;
    else if (i.estimated_impact_cents !== null)
      estimatedCents += i.estimated_impact_cents;
    else unknownCount++;
  }
  return { exactCents, estimatedCents, unknownCount };
}
