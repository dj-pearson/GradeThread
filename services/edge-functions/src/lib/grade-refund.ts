// US-771: per-grade Stripe auto-refund.
//
// runPaymentPrecedence charges the customer BEFORE grading. When a paid_stripe
// submission ends up ungraded, refund_grade() returns 'no_refund_paid_stripe'
// (real money — can't be reversed by minting credits). This issues exactly one
// Stripe refund, or queues an operator follow-up (public.pending_refunds) when
// it can't.
//
// The policy is split from its side-effects via injectable deps so it is
// deno-testable without a DB or live Stripe. The default deps import
// supabaseAdmin LAZILY so this module stays import-safe in tests (mirrors
// middleware/rate-limit.ts).

import { captureException } from "./observability.ts";
import { getStripe } from "./stripe-client.ts";

export interface StripeRefundDeps {
  /**
   * Atomically claim the refund: flip submissions.refunded_at from NULL to now
   * and return the row, or null if it was already claimed/refunded (so a
   * retried/concurrent call issues AT MOST one refund — US-771 AC5).
   */
  claim(
    submissionId: string,
  ): Promise<{ userId: string; paymentIntentId: string | null } | null>;
  /** Issue the Stripe refund; returns the refund id or throws on failure. */
  issueRefund(
    paymentIntentId: string,
    submissionId: string,
    reason: string,
  ): Promise<string>;
  /** Persist the successful refund id on the submission. */
  persistRefundId(submissionId: string, refundId: string): Promise<void>;
  /** Queue an operator follow-up when the auto-refund couldn't complete. */
  recordPending(
    submissionId: string,
    userId: string,
    paymentIntentId: string | null,
    reason: string,
    error: string,
  ): Promise<void>;
}

export const defaultStripeRefundDeps: StripeRefundDeps = {
  async claim(submissionId) {
    const { supabaseAdmin } = await import("./supabase.ts");
    const { data } = await supabaseAdmin
      .from("submissions")
      .update({ refunded_at: new Date().toISOString() })
      .eq("id", submissionId)
      .is("refunded_at", null)
      .select("user_id, stripe_payment_intent_id")
      .maybeSingle();
    if (!data) return null;
    const row = data as { user_id: string; stripe_payment_intent_id: string | null };
    return { userId: row.user_id, paymentIntentId: row.stripe_payment_intent_id };
  },
  async issueRefund(paymentIntentId, submissionId, reason) {
    const stripe = getStripe();
    if (!stripe) throw new Error("Stripe not configured (STRIPE_SECRET_KEY)");
    const refund = await stripe.refunds.create(
      {
        payment_intent: paymentIntentId,
        reason: "requested_by_customer",
        metadata: { submission_id: submissionId, refund_reason: reason },
      },
      // Keyed on the submission so a retry/double-call never double-refunds.
      { idempotencyKey: `grade-refund:${submissionId}` },
    );
    return refund.id;
  },
  async persistRefundId(submissionId, refundId) {
    const { supabaseAdmin } = await import("./supabase.ts");
    await supabaseAdmin
      .from("submissions")
      .update({ stripe_refund_id: refundId })
      .eq("id", submissionId);
  },
  async recordPending(submissionId, userId, paymentIntentId, reason, error) {
    const { supabaseAdmin } = await import("./supabase.ts");
    const payload = {
      submission_id: submissionId,
      user_id: userId,
      payment_intent_id: paymentIntentId,
      reason,
      last_error: error.slice(0, 1000),
      status: "pending",
    };
    const { error: insertErr } = await supabaseAdmin
      .from("pending_refunds")
      .insert(payload);
    // A prior failed attempt left an open row (partial unique index) — update it.
    if (insertErr && (insertErr as { code?: string }).code === "23505") {
      await supabaseAdmin
        .from("pending_refunds")
        .update({
          payment_intent_id: paymentIntentId,
          reason,
          last_error: error.slice(0, 1000),
        })
        .eq("submission_id", submissionId)
        .eq("status", "pending");
    } else if (insertErr) {
      console.error(
        `[refund] failed to write pending_refunds for ${submissionId}:`,
        insertErr.message,
      );
    }
  },
};

export async function autoRefundPaidStripe(
  submissionId: string,
  reason: string,
  deps: StripeRefundDeps = defaultStripeRefundDeps,
): Promise<void> {
  let claimed: { userId: string; paymentIntentId: string | null } | null;
  try {
    claimed = await deps.claim(submissionId);
  } catch (err) {
    // Couldn't even claim — don't risk a double refund; surface it.
    captureException(err, {
      route: "grade-refund.autoRefund",
      tags: { submissionId, phase: "claim" },
    });
    console.error(`[refund] claim failed for ${submissionId}:`, err);
    return;
  }
  if (!claimed) return; // already claimed/refunded — idempotent no-op.

  if (!claimed.paymentIntentId) {
    const msg = "No stripe_payment_intent_id stored on the submission";
    await deps.recordPending(submissionId, claimed.userId, null, reason, msg);
    captureException(new Error(`per-grade auto-refund: ${msg}`), {
      route: "grade-refund.autoRefund",
      tags: { submissionId },
    });
    return;
  }

  try {
    const refundId = await deps.issueRefund(
      claimed.paymentIntentId,
      submissionId,
      reason,
    );
    await deps.persistRefundId(submissionId, refundId);
    console.log(
      `[refund] Auto-refunded paid_stripe submission ${submissionId} (${reason}): ${refundId}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await deps.recordPending(
      submissionId,
      claimed.userId,
      claimed.paymentIntentId,
      reason,
      msg,
    );
    captureException(err, {
      route: "grade-refund.autoRefund",
      tags: { submissionId, phase: "stripe" },
    });
    console.error(
      `[refund] Auto-refund FAILED for ${submissionId} — queued for operator: ${msg}`,
    );
  }
}

// ── US-2345 AC1: the reserved-snap refund ───────────────────────────────────

/**
 * Give back the snap reserved for a quick-grade that then failed.
 *
 * WHY THIS IS A FUNCTION AND NOT FOUR LINES IN THE HANDLER. It lived inline in
 * routes/grade.ts, and US-2345 exists because that file's money paths have no
 * tests — not because nobody wanted them, but because everything in it reaches
 * the service-role client directly, so the FAILURE branch could only be
 * exercised with a database. The branch that matters most was therefore the one
 * nothing covered. Injecting the two effects is what makes it testable, and the
 * default `io` is exactly what the handler did before.
 *
 * ⚠ DELIBERATELY NON-BLOCKING AND DELIBERATELY NOT THROWING. The caller has
 * already decided to answer 502; the grade failed either way, and holding that
 * response on a second database call makes a bad path slower for no benefit. So
 * this never rejects — a caller must not have to wrap it, because a wrapper
 * someone forgets is how the original `.then(() => {}, () => {})` happened.
 *
 * What it does NOT do is stay quiet. That empty-callbacks version meant a refund
 * that never happened looked exactly like one that did: the seller's balance is
 * short and nobody can put it right, because nothing recorded that it was wrong.
 * Every failure — an RPC error OR a thrown one — is reported.
 */
export interface SnapRefundIO {
  refund: (userId: string) => Promise<{ error: { message: string } | null }>;
  report: (err: unknown, userId: string) => void;
}

export const defaultSnapRefundIO: SnapRefundIO = {
  refund: async (userId) => {
    // Imported lazily, like the Stripe deps above, so this module stays
    // import-safe in tests that never touch a database.
    const { supabaseAdmin } = await import("./supabase.ts");
    const { error } = await supabaseAdmin.rpc("refund_snap", { p_user_id: userId });
    return { error: error ? { message: error.message } : null };
  },
  report: (err, userId) => {
    captureException(err, { route: "grade.snap.refund", tags: { user: userId } });
  },
};

/** Returns whether the snap was actually given back — for callers that log it. */
export async function refundReservedSnap(
  userId: string,
  io: SnapRefundIO = defaultSnapRefundIO,
): Promise<boolean> {
  try {
    const { error } = await io.refund(userId);
    if (error) {
      io.report(error, userId);
      return false;
    }
    return true;
  } catch (err) {
    // A THROW is reported too, and this is the half the old code lost most
    // quietly: supabase-js resolves with { error } for a refused write, but the
    // client can still throw on a transport failure. The empty rejection
    // callback swallowed exactly this case.
    io.report(err, userId);
    return false;
  }
}
