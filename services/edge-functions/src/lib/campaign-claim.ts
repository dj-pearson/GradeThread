/**
 * US-2316 AC2: per-(campaign, recipient, channel) idempotency at the send layer,
 * so a duplicate broadcast is IMPOSSIBLE rather than merely capped.
 *
 * WHAT WAS THERE. `sendCampaignEmailDurable` reserved its ledger row with an
 * UPSERT to `status: 'pending'` and then sent. An upsert always succeeds, so two
 * workers on one recipient both "reserved" and both sent. The done-set loaded at
 * the start of a tick only holds rows already `sent` or `skipped`, so a `pending`
 * row — one claimed but not yet finalised — protected nobody. The only backstop
 * left was the platform-wide 1/day frequency cap, which is a policy control and
 * not an idempotency one.
 *
 * WHAT IT IS NOW. The reservation is an INSERT. The unique index on
 * (campaign_id, user_id, channel) is what decides the winner, in the database,
 * atomically — a loser gets 23505 and asks what the existing row means.
 *
 * ⚠ THE DELIBERATE TRADE, stated because it is a real cost and not a detail.
 * A row sitting at `pending` is NEVER re-sent by a later tick. That is what makes
 * a duplicate impossible, and it means a worker that dies between claiming a
 * recipient and enqueuing their email loses that recipient until someone requeues
 * them (set the row to `failed`; a retry then reclaims it).
 *
 * The alternative — reclaiming stale `pending` rows on a timer — was considered
 * and rejected here for a reason worth keeping: with only `created_at` on the
 * table there is no way to distinguish "claimed 40 minutes ago by a worker that
 * died" from "claimed 40 minutes ago by a worker still working", and a
 * pending→pending reclaim update cannot be made exclusive, so BOTH racers would
 * win it. That would reintroduce exactly the duplicate this exists to remove.
 * And the concurrency case is already covered upstream: US-2316 AC1 put a job
 * lock on the dispatch cron, so two ticks no longer overlap. What is left for
 * this layer is crash recovery, and there the conservative direction is right —
 * a `pending` row may well mean the email WAS enqueued and only the ledger write
 * was lost, since `coordinateMarketingSend` returns after the outbox accepts it.
 */

export type CampaignRecipientStatus = "pending" | "sent" | "skipped" | "failed";

/**
 * What to do about a row that ALREADY exists. There is no "send" here on
 * purpose: winning the insert is the only way to earn an unconditional send,
 * and giving this union a `send` arm would let a future edit hand one out from
 * a read.
 */
export type ClaimVerdict =
  /** Already finalised on an earlier tick. Count it, do not resend. */
  | { action: "already"; status: "sent" | "skipped" }
  /** A previous attempt failed. Try to take the claim back before sending. */
  | { action: "reclaim"; from: "failed" }
  /** Someone else holds it, or a dead worker left it held. Leave it alone. */
  | { action: "in_flight" };

/**
 * What an EXISTING ledger row means for this attempt.
 *
 * Pure: the whole point is that the decision can be read and tested without a
 * database, because it is the decision — not the SQL — that got this wrong.
 */
export function verdictForExistingRow(
  row: { status: string } | null,
): ClaimVerdict {
  if (!row) {
    // The insert conflicted but the row is gone — a concurrent delete, or a
    // read that raced the write. Not ours to send.
    return { action: "in_flight" };
  }
  if (row.status === "sent" || row.status === "skipped") {
    return { action: "already", status: row.status };
  }
  if (row.status === "failed") return { action: "reclaim", from: "failed" };
  // `pending`, and anything unrecognised. Unknown statuses fall here on purpose:
  // the safe answer to "what does this mean" is not to send.
  return { action: "in_flight" };
}

/** Postgres unique-violation, the signal that another worker won the claim. */
export function isUniqueViolation(err: { code?: string } | null): boolean {
  return err?.code === "23505";
}
