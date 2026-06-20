// US-925: durable segmented marketing send — PURE audience resolution.
//
// A broadcast's email audience is the target segment (segments.ts
// iterateSegmentUsers) UNION the confirmed newsletter subscribers
// (email_subscribers), de-duped by normalized email. The segment is streamed
// page-by-page by the send engine; this module folds the confirmed-subscriber
// list onto the set of emails the segment already covered, so a recipient who is
// BOTH in the segment and a subscriber is mailed exactly once.
//
// Dependency-free (no supabase / env / network) so it is unit-testable without a
// DB and the dedup logic has one source of truth.

/** Trim + lowercase so dedup uses one canonical email form (mirrors
 * email-suppression.normalizeEmail without importing its supabase-bound module). */
export function normalizeBroadcastEmail(email: string): string {
  return (email ?? "").trim().toLowerCase();
}

export interface ConfirmedSubscriber {
  email: string;
  /** Null when the subscriber never linked an account (a standalone lead). */
  user_id: string | null;
}

export interface ExtraSubscriber {
  userId: string;
  email: string;
}

export interface SubscriberPartition {
  /** Confirmed subscribers NOT already covered by the segment, with a linked
   * account — these get an additional email send + a campaign_recipients row. */
  extras: ExtraSubscriber[];
  /** Confirmed subscribers with no linked account: they can't be consent-checked
   * or recorded in campaign_recipients (user_id is NOT NULL), so they're skipped. */
  skippedNoAccount: number;
  /** Subscribers whose email the segment (or an earlier subscriber) already covered. */
  duplicates: number;
}

/**
 * Fold the confirmed-subscriber list onto the emails the segment already
 * covered. `seenEmails` is the set of NORMALIZED emails the segment pass mailed
 * (mutated here so a duplicate email appearing twice among subscribers is only
 * counted once). Returns the additional sends + the skip tallies. Pure.
 */
export function partitionExtraSubscribers(
  subscribers: ConfirmedSubscriber[],
  seenEmails: Set<string>,
): SubscriberPartition {
  const extras: ExtraSubscriber[] = [];
  let skippedNoAccount = 0;
  let duplicates = 0;

  for (const sub of subscribers) {
    const email = normalizeBroadcastEmail(sub.email);
    if (!email) continue; // unusable address — nothing to record or send

    if (seenEmails.has(email)) {
      duplicates++;
      continue;
    }
    seenEmails.add(email);

    if (!sub.user_id) {
      skippedNoAccount++;
      continue;
    }
    extras.push({ userId: sub.user_id, email });
  }

  return { extras, skippedNoAccount, duplicates };
}
