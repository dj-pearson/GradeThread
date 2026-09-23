// Credits back when the charge call failed but the charge may have landed.
//
// Owner's decision, 2026-09-23: "credits should be back if failed".
//
// runPaymentPrecedence() debits credits through the debit_grade_credits RPC.
// When that call comes back as an error it is AMBIGUOUS: a timeout, a 5xx from
// the proxy in front of PostgREST or a dropped connection can all arrive after
// the transaction committed. Every grading entry point then treated the error
// as "nothing was charged" and either deleted the submission (public API, batch
// worker) or left it unpaid (web flow, FlipDesk bulk). If the debit had landed,
// the seller lost the credits and got no grade, and nothing recorded it.
//
// This module answers the question from the LEDGER instead of from the error:
// is there a `grade_debit` row for this submission on this account? That row is
// written inside the same transaction that moves the balance (00516 / 00615), so
// it exists if and only if the debit committed.
//
//   no row           -> nothing was charged; the caller cleans up as before.
//   row              -> refund exactly that amount through refund_grade, the
//                       same RPC the grading pipeline uses for a failed grade.
//   can't tell       -> keep the submission (so the ledger row keeps its link)
//                       and report it for a person to look at.
//
// WHY refund_grade AND NOT A NEW RPC. refund_grade already refunds exactly the
// latest `grade_debit` delta for the submission, claims the refund under a row
// lock and stamps submissions.refunded_at, so a second call returns
// 'already_refunded' and moves nothing. It only takes the credits branch when
// payment_status reads 'credits', and on this path the paid-flip never ran, so
// the flip is done here first -- and ONLY after the ledger row was seen, so a
// debit that did not land can never be refunded.
//
// WHY THE SUBMISSION IS KEPT WHEN MONEY MOVED. grade_credit_transactions has
// `submission_id ... ON DELETE SET NULL`. Deleting the submission would leave a
// debit row and a refund row that point at nothing, and support could no
// longer tell which request they belonged to. Kept as status 'failed' with
// refunded_at set, it looks exactly like a pipeline failure that was refunded,
// which is the shape support already reads: the submission, its debit row and
// its refund row, all linked.

import { captureException } from "./observability.ts";

export type AmbiguousDebitOutcome =
  /** No debit row: nothing was charged. Safe to clean up as before. */
  | { kind: "not_charged" }
  /**
   * A debit landed and has been refunded (now, or by an earlier call).
   * `credits` is the debited amount the ledger shows.
   */
  | { kind: "refunded"; credits: number; alreadyRefunded: boolean }
  /**
   * A debit is on the ledger, but the submission was already marked paid with
   * credits by ANOTHER call (a concurrent /pay replaying the same
   * `grade_pay:<id>` key). That debit is what paid for the grade now running,
   * so it is not refunded and the submission is left alone.
   */
  | { kind: "paid" }
  /** Could not establish the answer, or the refund did not complete. */
  | { kind: "unknown"; error: string };

export interface AmbiguousDebitIO {
  /**
   * The `grade_debit` ledger row for this submission ON THIS ACCOUNT. Returns
   * the positive number of credits debited, null when there is no row, or
   * `{ error }` when the read failed (which is NOT the same as "no row").
   */
  findDebit: (
    userId: string,
    submissionId: string,
  ) => Promise<{ credits: number | null } | { error: string }>;
  /**
   * Record the truth on the submission: it WAS paid with credits. Scoped to
   * the charged account and to a still-unpaid row, so it never overwrites an
   * included or Stripe payment.
   */
  markPaidWithCredits: (
    userId: string,
    submissionId: string,
  ) => Promise<{ error: string | null; flipped: boolean }>;
  /**
   * The submission's payment state, read when the flip matched nothing, so
   * "someone else already paid it" and "we already refunded it" can be told
   * apart. Scoped to the charged account.
   */
  readPayment: (
    userId: string,
    submissionId: string,
  ) => Promise<
    { paymentStatus: string | null; refundedAt: string | null } | { error: string }
  >;
  /** refund_grade(p_submission_id). Returns its text result. */
  refundGrade: (
    submissionId: string,
  ) => Promise<{ result: string | null; error: string | null }>;
  /**
   * Park the submission as failed so nothing grades or re-pays it. With
   * `onlyIfUnpaid` it touches the row only while it still reads 'unpaid', so a
   * submission a concurrent call has just paid for (and started grading) is
   * never parked by this one's failure.
   */
  markFailed: (
    userId: string,
    submissionId: string,
    opts?: { onlyIfUnpaid?: boolean },
  ) => Promise<void>;
  /** Report something a person has to look at. Never throws. */
  report: (err: unknown, tags: Record<string, string>) => void;
  /** One structured line for the log. */
  log: (line: string) => void;
}

export const defaultAmbiguousDebitIO: AmbiguousDebitIO = {
  findDebit: async (userId, submissionId) => {
    // Lazy import keeps this module loadable in tests with no database env.
    const { supabaseAdmin } = await import("./supabase.ts");
    const { data, error } = await supabaseAdmin
      .from("grade_credit_transactions")
      .select("delta")
      .eq("submission_id", submissionId)
      // US-268: the ledger is multi-tenant. The submission id is ours, but the
      // account scope is what makes "this seller was charged" a statement about
      // this seller.
      .eq("user_id", userId)
      .eq("reason", "grade_debit")
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) return { error: error.message ?? String(error) };
    const row = (data ?? [])[0] as { delta: number } | undefined;
    if (!row) return { credits: null };
    return { credits: Math.abs(Number(row.delta)) };
  },
  markPaidWithCredits: async (userId, submissionId) => {
    const { supabaseAdmin } = await import("./supabase.ts");
    const { data, error } = await supabaseAdmin
      .from("submissions")
      .update({ payment_status: "credits", paid_at: new Date().toISOString() })
      .eq("id", submissionId)
      .eq("user_id", userId)
      .eq("payment_status", "unpaid")
      .select("id");
    return {
      error: error ? (error.message ?? String(error)) : null,
      flipped: Array.isArray(data) && data.length > 0,
    };
  },
  readPayment: async (userId, submissionId) => {
    const { supabaseAdmin } = await import("./supabase.ts");
    const { data, error } = await supabaseAdmin
      .from("submissions")
      .select("payment_status, refunded_at")
      .eq("id", submissionId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) return { error: error.message ?? String(error) };
    if (!data) return { error: "submission not found" };
    const row = data as { payment_status: string | null; refunded_at: string | null };
    return { paymentStatus: row.payment_status, refundedAt: row.refunded_at };
  },
  refundGrade: async (submissionId) => {
    const { supabaseAdmin } = await import("./supabase.ts");
    const { data, error } = await supabaseAdmin.rpc("refund_grade", {
      p_submission_id: submissionId,
    });
    return {
      result: typeof data === "string" ? data : null,
      error: error ? (error.message ?? String(error)) : null,
    };
  },
  markFailed: async (userId, submissionId, opts) => {
    const { supabaseAdmin } = await import("./supabase.ts");
    let q = supabaseAdmin
      .from("submissions")
      .update({ status: "failed" })
      .eq("id", submissionId)
      .eq("user_id", userId);
    if (opts?.onlyIfUnpaid) q = q.eq("payment_status", "unpaid");
    await q;
  },
  report: (err, tags) => {
    captureException(err, { route: "ambiguous-debit-refund", tags });
  },
  log: (line) => console.log(line),
};

/**
 * Call this from the catch around runPaymentPrecedence, BEFORE deleting the
 * submission. Never throws: the caller is already on a failure path and must
 * be able to answer it.
 *
 * Only `not_charged` licenses the caller to delete the submission. Both other
 * outcomes mean money moved (or might have), and the submission is the only
 * thing tying the ledger rows to the request.
 */
export async function refundAmbiguousDebit(
  userId: string,
  submissionId: string,
  route: string,
  io: AmbiguousDebitIO = defaultAmbiguousDebitIO,
): Promise<AmbiguousDebitOutcome> {
  const tags = { route, submission: submissionId, user: userId };
  try {
    const found = await io.findDebit(userId, submissionId);
    if ("error" in found) {
      // A failed read is not "no debit". Deleting the submission on a guess
      // would orphan a debit that did land.
      io.report(new Error(`ambiguous debit: ledger read failed: ${found.error}`), tags);
      // Only while still unpaid: a concurrent /pay may have paid it and started
      // the grade, and this call's failure must not stop that one.
      await io.markFailed(userId, submissionId, { onlyIfUnpaid: true }).catch(() => {});
      return { kind: "unknown", error: found.error };
    }
    if (found.credits === null) return { kind: "not_charged" };

    const flip = await io.markPaidWithCredits(userId, submissionId);
    if (flip.error) {
      io.report(new Error(`ambiguous debit: paid-flip failed: ${flip.error}`), tags);
      await io.markFailed(userId, submissionId, { onlyIfUnpaid: true }).catch(() => {});
      return { kind: "unknown", error: flip.error };
    }

    // The flip matched nothing: the row was no longer 'unpaid' when this call
    // got here. refund_grade must NOT run then. It refunds the submission's
    // debit whoever made it, so on a submission a concurrent /pay has paid
    // (same `grade_pay:<id>` key, so the one debit row is THAT payment) it
    // would hand back the money for a grade that is running, and parking it
    // failed would stop the grade too. Read the row and answer from it.
    if (!flip.flipped) {
      const pay = await io.readPayment(userId, submissionId);
      if ("error" in pay) {
        io.report(new Error(`ambiguous debit: payment read failed: ${pay.error}`), tags);
        return { kind: "unknown", error: pay.error };
      }
      if (pay.refundedAt) {
        return { kind: "refunded", credits: found.credits, alreadyRefunded: true };
      }
      if (pay.paymentStatus === "credits") {
        io.log(
          `[ambiguous-debit] ${route}: submission ${submissionId} was paid with ` +
            `credits by another call; its debit stands and nothing is refunded`,
        );
        return { kind: "paid" };
      }
      // A credit debit on a row paid some other way (included, Stripe) is a
      // real double charge, and not one refund_grade can undo: it refunds by
      // payment_status. A person looks; the grade in flight is left alone.
      const msg = `debit on a submission paid as ${pay.paymentStatus}`;
      io.report(new Error(`ambiguous debit: ${msg}`), tags);
      return { kind: "unknown", error: msg };
    }

    const refund = await io.refundGrade(submissionId);
    if (
      refund.error ||
      (refund.result !== "refunded_credits" && refund.result !== "already_refunded")
    ) {
      // 'no_refund_unpaid' here would mean the flip above matched nothing, e.g.
      // the row was already included/Stripe-paid. Either way a person looks.
      const msg = refund.error ?? `unexpected refund_grade result: ${refund.result}`;
      io.report(new Error(`ambiguous debit: refund failed: ${msg}`), tags);
      await io.markFailed(userId, submissionId).catch(() => {});
      return { kind: "unknown", error: msg };
    }

    // The refund has happened; a failed status write must not turn this into
    // "unknown" and send a person after money that is already back.
    await io.markFailed(userId, submissionId).catch((err) => io.report(err, tags));
    const alreadyRefunded = refund.result === "already_refunded";
    io.log(
      `[ambiguous-debit] ${route}: submission ${submissionId} debit of ` +
        `${found.credits} credit(s) landed after a payment error; ` +
        (alreadyRefunded ? "already refunded" : "refunded"),
    );
    return { kind: "refunded", credits: found.credits, alreadyRefunded };
  } catch (err) {
    io.report(err, tags);
    return { kind: "unknown", error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Refunding a charge that is known to have landed ─────────────────────────
//
// FlipDesk bulk grading refunds a charged item whose photo copy failed. It
// called refund_grade inside a try/catch and nothing else, but supabase-js does
// not throw for a refused RPC: it returns `{ error }`. So a refused refund was
// silent, and the seller was out the credits with no report anywhere.

/**
 * refund_grade for a submission whose charge SUCCEEDED, with every answer that
 * is not a refund reported. 'no_refund_unpaid' means the paid-flip after the
 * debit did not stick (its write result is not checked), so the ledger is
 * consulted the same way as for a failed charge call. Never throws.
 */
export async function refundChargedGrade(
  userId: string,
  submissionId: string,
  route: string,
  io: AmbiguousDebitIO = defaultAmbiguousDebitIO,
): Promise<{ ok: boolean; result: string | null; error: string | null }> {
  const tags = { route, submission: submissionId, user: userId };
  try {
    const refund = await io.refundGrade(submissionId);
    if (refund.error) {
      io.report(new Error(`charged refund: refund_grade refused: ${refund.error}`), tags);
      return { ok: false, result: null, error: refund.error };
    }
    if (refund.result === "no_refund_unpaid") {
      const out = await refundAmbiguousDebit(userId, submissionId, route, io);
      if (out.kind === "refunded") return { ok: true, result: "refunded_credits", error: null };
      if (out.kind === "not_charged") {
        // An included grade whose paid-flip did not stick: nothing is on the
        // credit ledger, and nothing says which allowance it drew on.
        io.report(new Error("charged refund: unpaid row with no credit debit"), tags);
      }
      // Any other outcome was reported by refundAmbiguousDebit itself.
      return { ok: false, result: refund.result, error: out.kind };
    }
    if (
      refund.result === "already_refunded" ||
      (refund.result?.startsWith("refunded_") ?? false)
    ) {
      return { ok: true, result: refund.result, error: null };
    }
    const msg = `unexpected refund_grade result: ${refund.result}`;
    io.report(new Error(`charged refund: ${msg}`), tags);
    return { ok: false, result: refund.result, error: msg };
  } catch (err) {
    io.report(err, tags);
    return { ok: false, result: null, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── A refunded debit's key is spent ─────────────────────────────────────────
//
// debit_grade_credits treats a second call with the same p_idempotency_key as a
// replay: it debits nothing and reports success. That is right while the first
// debit still stands. Once it has been REFUNDED, the same rule gives a grade
// away: a batch job reclaimed after the refund, or a FlipDesk bulk retry with
// the same batch_key, creates a NEW submission, calls with the same key, is told
// "already paid", and the new submission is marked paid with no money behind it.
//
// So a key whose debit belongs to a DIFFERENT submission that has since been
// refunded is re-derived for this submission. A replay onto the SAME
// submission keeps its key, which is the case the key exists for.

export interface PriorKeyedDebit {
  submissionId: string | null;
  refunded: boolean;
}

/** Pure: the key to send given what the ledger holds under it. */
export function debitKeyAfterRefund(
  key: string | null | undefined,
  prior: PriorKeyedDebit | null,
  currentSubmissionId: string,
): string | null {
  if (!key) return null;
  if (!prior || !prior.submissionId) return key;
  if (prior.submissionId === currentSubmissionId) return key;
  return prior.refunded ? `${key}:rebill:${currentSubmissionId}` : key;
}

/** IO half of the above, bound to the service-role client. Fails open to `key`. */
export async function resolveDebitKey(
  userId: string,
  submissionId: string,
  key: string | null | undefined,
): Promise<string | null> {
  if (!key) return null;
  try {
    const { supabaseAdmin } = await import("./supabase.ts");
    const { data: row } = await supabaseAdmin
      .from("grade_credit_transactions")
      .select("submission_id")
      .eq("idempotency_key", key)
      .eq("user_id", userId)
      .eq("reason", "grade_debit")
      .limit(1)
      .maybeSingle();
    const priorSub = (row as { submission_id: string | null } | null)?.submission_id ?? null;
    if (!row || !priorSub || priorSub === submissionId) {
      return debitKeyAfterRefund(key, row ? { submissionId: priorSub, refunded: false } : null, submissionId);
    }
    const { data: sub } = await supabaseAdmin
      .from("submissions")
      .select("refunded_at")
      .eq("id", priorSub)
      .eq("user_id", userId)
      .maybeSingle();
    const refunded = !!(sub as { refunded_at: string | null } | null)?.refunded_at;
    return debitKeyAfterRefund(key, { submissionId: priorSub, refunded }, submissionId);
  } catch {
    // Failing open keeps the pre-existing behaviour (the key as given), which
    // can never double-charge; the cost is the free-grade case above.
    return key;
  }
}

/**
 * The web flow's 500 body for a payment error. Unchanged when nothing was
 * charged; otherwise it names the submission (support's handle on the ledger
 * rows) and, when the credits went back, says so.
 */
export function paymentErrorBody(
  debit: AmbiguousDebitOutcome,
  submissionId: string,
): { error: string; submissionId?: string; creditsRefunded?: number } {
  if (debit.kind === "not_charged") return { error: "Payment processing error" };
  if (debit.kind === "refunded") {
    return {
      error: `Payment processing error. The ${debit.credits} credit${
        debit.credits === 1 ? "" : "s"
      } taken for this grade were returned.`,
      submissionId,
      creditsRefunded: debit.credits,
    };
  }
  return { error: "Payment processing error", submissionId };
}
