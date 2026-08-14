// US-2562: what has to happen to the financial record before an account is erased.
//
// Until migration 00595, `grade_credit_transactions.user_id` and
// `flipdesk_subscription_events.user_id` were both ON DELETE CASCADE to
// public.users, which cascades from auth.users. So the deleteUser call at the
// end of POST /api/account/delete erased the entire ledger for that account, and
// the compliance row that survived recorded three booleans and no money. A
// chargeback filed inside the 120-day dispute window had nothing to represent
// the charge with.
//
// 00595 drops those foreign keys, so the rows now survive on their own. This
// module owns the two things that still have to happen explicitly, and the ORDER
// they happen in:
//
//   1. COUNT what is being retained, so the deletion log can prove it rather
//      than assert it.
//   2. REDACT the PII the cascade used to take away. flipdesk_subscription_events
//      .raw_payload is the verbatim Stripe object and carries customer email and
//      billing address; keeping the row means explicitly stripping that column.
//
// WHY THIS IS A MODULE AND NOT SIX LINES IN THE HANDLER. routes/account.ts
// reaches supabaseAdmin directly at every step, so the branch that matters most
// here — redaction FAILING — can only be exercised with a live database, and is
// therefore the branch nothing would cover. Injecting the two effects is what
// makes the fail-closed decision testable. Same idiom as
// lib/account-email-purge.ts (US-2005) and lib/grade-precedence.ts (US-2345).
//
// See vault/20-domain/credit-ledger-durability.md for the retention contract
// and why the rows are kept in place rather than copied to an archive table.

/** The two effects this sequence needs, and its error channel. */
export interface FinancialRetentionIO {
  /**
   * How many grade_credit_transactions rows this account owns. Counted BEFORE
   * erasure because afterwards there is no account to scope the query by — the
   * number is the whole proof.
   */
  countLedgerRows: (userId: string) => Promise<{ count: number | null; error: string | null }>;
  /**
   * Strip raw_payload from the user's subscription events, keeping the audit
   * fields. Returns how many rows were rewritten.
   */
  redactSubscriptionEvents: (
    userId: string,
  ) => Promise<{ redacted: number | null; error: string | null }>;
  /** Report a failure to the tracker + console. Never throws. */
  report: (message: string, err?: unknown) => void;
}

export type FinancialRetentionResult =
  | {
    ok: true;
    /** COUNT of retained ledger rows, or null when the count itself failed. */
    ledgerRowsRetained: number | null;
    subscriptionEventsRedacted: number;
  }
  | {
    ok: false;
    /** Why erasure must not proceed. Operator-facing, never shown to the user. */
    reason: string;
  };

/**
 * Prepare an account's financial record for erasure.
 *
 * ⚠ CALL THIS BEFORE ANY DESTRUCTIVE STEP, not just before deleteUser.
 * `ok: false` means "do not erase", and that is only a safe answer while the
 * account is still whole. Run it after the storage purge or the Stripe customer
 * delete and a refusal leaves a half-erased account, which is worse than either
 * completing or not starting.
 *
 * THE TWO FAILURES ARE NOT THE SAME, and treating them alike was the tempting
 * mistake:
 *
 *  • A COUNT failure is bookkeeping. The rows are safe either way — nothing in
 *    this function moves them — so refusing to erase over an unavailable number
 *    would block a data subject's erasure right to protect an audit field. It
 *    logs, returns null for the count, and proceeds.
 *
 *  • A REDACTION failure leaves customer email and billing address sitting in
 *    flipdesk_subscription_events.raw_payload on rows that no longer cascade
 *    away. Before 00595 the cascade removed them; if this step is skipped, 00595
 *    has quietly turned an erasure into a retention. So it fails CLOSED. The
 *    caller answers 503 and the user retries against an untouched account.
 */
export async function retainFinancialRecords(
  userId: string,
  io: FinancialRetentionIO,
): Promise<FinancialRetentionResult> {
  let ledgerRowsRetained: number | null = null;
  try {
    const counted = await io.countLedgerRows(userId);
    if (counted.error) {
      io.report(
        `[financial-retention] ledger count failed for ${userId}: ${counted.error} — ` +
          `proceeding with erasure; the deletion log will record an unknown count.`,
      );
    } else {
      ledgerRowsRetained = counted.count;
    }
  } catch (err) {
    // A THROW is reported too. supabase-js resolves with { error } for a refused
    // read but can still throw on a transport failure, and an unreported throw
    // here is indistinguishable from a zero-row account.
    io.report(`[financial-retention] ledger count threw for ${userId}`, err);
  }

  let subscriptionEventsRedacted: number;
  try {
    const redaction = await io.redactSubscriptionEvents(userId);
    if (redaction.error) {
      io.report(
        `[financial-retention] subscription-event redaction FAILED for ${userId}: ` +
          `${redaction.error} — refusing to erase.`,
      );
      return { ok: false, reason: `redaction failed: ${redaction.error}` };
    }
    // A null count from a successful call means the RPC answered without a
    // number. Treat it as zero for the log rather than inventing one; the
    // redaction itself succeeded, which is what gates erasure.
    subscriptionEventsRedacted = redaction.redacted ?? 0;
  } catch (err) {
    io.report(`[financial-retention] subscription-event redaction threw for ${userId}`, err);
    return {
      ok: false,
      reason: `redaction threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return { ok: true, ledgerRowsRetained, subscriptionEventsRedacted };
}
