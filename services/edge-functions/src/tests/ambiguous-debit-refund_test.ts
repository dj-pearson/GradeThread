// Owner's decision 2026-09-23: "credits should be back if failed".
//
// When the charge call errors, the debit may still have committed. These tests
// drive refundAmbiguousDebit against a fake that behaves like the three pieces
// of the database it touches: the ledger (grade_credit_transactions), the
// submission row, and refund_grade's claim-under-lock (00536).

import { assert, assertEquals } from "@std/assert";
import {
  type AmbiguousDebitIO,
  debitKeyAfterRefund,
  paymentErrorBody,
  refundAmbiguousDebit,
} from "../lib/ambiguous-debit-refund.ts";

interface LedgerRow {
  user_id: string;
  submission_id: string;
  delta: number;
  reason: "grade_debit" | "refund";
}

function fakeDb(opts: {
  debitLanded: boolean;
  credits?: number;
  debitUser?: string;
  ledgerReadFails?: boolean;
  refundFails?: boolean;
}) {
  const SUB = "sub-1";
  const state = {
    balance: 10,
    ledger: [] as LedgerRow[],
    submission: {
      id: SUB,
      user_id: "owner-a",
      payment_status: "unpaid" as string,
      refunded_at: null as string | null,
      status: "pending",
    },
    reports: [] as string[],
  };
  const credits = opts.credits ?? 2;
  if (opts.debitLanded) {
    state.balance -= credits;
    state.ledger.push({
      user_id: opts.debitUser ?? "owner-a",
      submission_id: SUB,
      delta: -credits,
      reason: "grade_debit",
    });
  }

  const io: AmbiguousDebitIO = {
    findDebit: (userId, submissionId) => {
      if (opts.ledgerReadFails) return Promise.resolve({ error: "connection reset" });
      const row = state.ledger.find((r) =>
        r.submission_id === submissionId && r.user_id === userId && r.reason === "grade_debit"
      );
      return Promise.resolve({ credits: row ? Math.abs(row.delta) : null });
    },
    markPaidWithCredits: (userId, submissionId) => {
      const s = state.submission;
      if (s.id === submissionId && s.user_id === userId && s.payment_status === "unpaid") {
        s.payment_status = "credits";
      }
      return Promise.resolve({ error: null });
    },
    // refund_grade, as 00536 writes it.
    refundGrade: (submissionId) => {
      if (opts.refundFails) return Promise.resolve({ result: null, error: "timeout" });
      const s = state.submission;
      if (s.refunded_at) return Promise.resolve({ result: "already_refunded", error: null });
      if (s.payment_status !== "credits") {
        return Promise.resolve({ result: `no_refund_${s.payment_status}`, error: null });
      }
      const debit = [...state.ledger].reverse().find((r) =>
        r.submission_id === submissionId && r.reason === "grade_debit"
      );
      if (debit) {
        state.balance += -debit.delta;
        state.ledger.push({
          user_id: s.user_id,
          submission_id: submissionId,
          delta: -debit.delta,
          reason: "refund",
        });
      }
      s.refunded_at = "now";
      return Promise.resolve({ result: "refunded_credits", error: null });
    },
    markFailed: (_userId, _submissionId) => {
      state.submission.status = "failed";
      return Promise.resolve();
    },
    report: (err) => {
      state.reports.push(err instanceof Error ? err.message : String(err));
    },
    log: () => {},
  };
  return { state, io, SUB };
}

const refunds = (rows: LedgerRow[]) => rows.filter((r) => r.reason === "refund");

Deno.test("(a) the debit landed, then the call errored: refunded exactly once, for exactly the debited amount", async () => {
  const { state, io, SUB } = fakeDb({ debitLanded: true, credits: 3 });
  assertEquals(state.balance, 7);

  const out = await refundAmbiguousDebit("owner-a", SUB, "test", io);

  assertEquals(out, { kind: "refunded", credits: 3, alreadyRefunded: false });
  assertEquals(state.balance, 10, "the seller did not get their credits back");
  assertEquals(refunds(state.ledger).length, 1);
  assertEquals(refunds(state.ledger)[0].delta, 3);
  // Kept, not deleted: the ledger rows stay linked for support.
  assertEquals(state.submission.status, "failed");
  assertEquals(state.submission.payment_status, "credits");
  assert(state.submission.refunded_at);
  assertEquals(state.reports, []);
});

Deno.test("(b) the debit did not land: nothing is refunded and the caller may clean up", async () => {
  const { state, io, SUB } = fakeDb({ debitLanded: false });

  const out = await refundAmbiguousDebit("owner-a", SUB, "test", io);

  assertEquals(out, { kind: "not_charged" });
  assertEquals(state.balance, 10, "credits were minted for a debit that never happened");
  assertEquals(refunds(state.ledger).length, 0);
  assertEquals(state.submission.payment_status, "unpaid", "an unpaid row was marked paid");
  assertEquals(state.submission.refunded_at, null);
});

Deno.test("(c) a retry or replay of the same failure never refunds twice", async () => {
  const { state, io, SUB } = fakeDb({ debitLanded: true, credits: 2 });

  const first = await refundAmbiguousDebit("owner-a", SUB, "test", io);
  const second = await refundAmbiguousDebit("owner-a", SUB, "test", io);
  const third = await refundAmbiguousDebit("owner-a", SUB, "test", io);

  assertEquals(first.kind, "refunded");
  assertEquals(second, { kind: "refunded", credits: 2, alreadyRefunded: true });
  assertEquals(third, { kind: "refunded", credits: 2, alreadyRefunded: true });
  assertEquals(state.balance, 10, "the balance moved more than once");
  assertEquals(refunds(state.ledger).length, 1, "a second refund row was written");
});

Deno.test("a debit on ANOTHER account for this submission id is not ours to refund", async () => {
  // US-268: the ledger read is scoped to the charged account.
  const { state, io, SUB } = fakeDb({ debitLanded: true, debitUser: "someone-else" });
  const out = await refundAmbiguousDebit("owner-a", SUB, "test", io);
  assertEquals(out, { kind: "not_charged" });
  assertEquals(refunds(state.ledger).length, 0);
});

Deno.test("a failed ledger read is NOT 'not charged': the submission is kept and reported", async () => {
  const { state, io, SUB } = fakeDb({ debitLanded: true, ledgerReadFails: true });
  const out = await refundAmbiguousDebit("owner-a", SUB, "test", io);
  assertEquals(out.kind, "unknown", "a guess of not_charged would let the caller delete the evidence");
  assertEquals(state.submission.status, "failed");
  assertEquals(state.reports.length, 1);
  assertEquals(refunds(state.ledger).length, 0);
});

Deno.test("a refund that errors is reported as unknown, never as refunded", async () => {
  const { state, io, SUB } = fakeDb({ debitLanded: true, refundFails: true });
  const out = await refundAmbiguousDebit("owner-a", SUB, "test", io);
  assertEquals(out.kind, "unknown");
  assertEquals(state.reports.length, 1);
  assertEquals(state.balance, 8);
});

Deno.test("refund_grade answering 'no_refund_*' is not a refund: reported, and the row is not claimed paid", async () => {
  // The flip only matches an UNPAID row. If the submission already carries
  // another payment (here a Stripe one), refund_grade declines with no error,
  // and reading that as success would tell the seller credits came back.
  const { state, io, SUB } = fakeDb({ debitLanded: true });
  state.submission.payment_status = "paid_stripe";
  const out = await refundAmbiguousDebit("owner-a", SUB, "test", io);
  assertEquals(out.kind, "unknown");
  assertEquals(state.submission.payment_status, "paid_stripe", "the flip overwrote another payment");
  assertEquals(state.reports.length, 1);
  assertEquals(refunds(state.ledger).length, 0);
});

Deno.test("never throws, even when the IO does", async () => {
  const { io, SUB } = fakeDb({ debitLanded: true });
  io.findDebit = () => Promise.reject(new Error("boom"));
  const reports: string[] = [];
  io.report = (e) => reports.push(String(e));
  const out = await refundAmbiguousDebit("owner-a", SUB, "test", io);
  assertEquals(out.kind, "unknown");
  assertEquals(reports.length, 1);
});

// ── A refunded debit's idempotency key is spent ──────────────────────────────

Deno.test("key: a replay onto the SAME submission keeps its key (the case the key exists for)", () => {
  assertEquals(
    debitKeyAfterRefund("grade-batch-job:J", { submissionId: "s1", refunded: false }, "s1"),
    "grade-batch-job:J",
  );
});

Deno.test("key: a live debit on another submission keeps the key, so the replay debits nothing", () => {
  assertEquals(
    debitKeyAfterRefund("fd-bulk:b:i", { submissionId: "s1", refunded: false }, "s2"),
    "fd-bulk:b:i",
  );
});

Deno.test("key: a REFUNDED debit on another submission is re-derived, so the new grade is paid for", () => {
  // Without this, a reclaimed batch job or a same-batch_key FlipDesk retry is
  // told "already paid" by debit_grade_credits and grades for free.
  const k = debitKeyAfterRefund("grade-batch-job:J", { submissionId: "s1", refunded: true }, "s2");
  assertEquals(k, "grade-batch-job:J:rebill:s2");
  // And it is stable for s2, so a replay of THAT charge is still a no-op.
  assertEquals(k, debitKeyAfterRefund("grade-batch-job:J", { submissionId: "s1", refunded: true }, "s2"));
});

Deno.test("key: no key, no prior row, or an unlinked prior row pass through unchanged", () => {
  assertEquals(debitKeyAfterRefund(null, null, "s"), null);
  assertEquals(debitKeyAfterRefund("k", null, "s"), "k");
  assertEquals(debitKeyAfterRefund("k", { submissionId: null, refunded: true }, "s"), "k");
});

// ── Wiring: every caller of runPaymentPrecedence consults the ledger ────────

const read = (rel: string) =>
  Deno.readTextFileSync(new URL(rel, import.meta.url)).replace(/\r\n/g, "\n");

function catchAfter(src: string, marker: string): string {
  const at = src.indexOf(marker);
  assert(at !== -1, `marker not found: ${marker}`);
  const c = src.indexOf("catch (err)", at);
  return src.slice(c, c + 900);
}

Deno.test("wiring: every precedence catch refunds a landed debit before any delete", () => {
  const sites: Array<[string, string, string]> = [
    ["../routes/api-v1.ts", "precedence = await runPaymentPrecedence(userId, submissionId, tier);", "api-v1.grades"],
    ["../lib/grading-batch-worker.ts", "`grade-batch-job:${jobId}`", "grading-batch.job"],
    ["../routes/grade.ts", "Same derived key as the /pay retry below", "grade.submit"],
    ["../routes/grade.ts", "US-2298 AC1: one credit debit per submission", "grade.pay"],
  ];
  for (const [file, marker, route] of sites) {
    const block = catchAfter(read(file), marker);
    const refundAt = block.indexOf(`refundAmbiguousDebit(`);
    assert(refundAt !== -1, `${file} (${route}): the precedence catch no longer checks the ledger`);
    assert(block.includes(`"${route}"`), `${file}: route tag ${route} missing`);
    const delAt = block.indexOf(`.delete()`);
    if (delAt !== -1) {
      assert(refundAt < delAt, `${file}: the submission is deleted before the ledger is read`);
      assert(
        /if \(debit\.kind === "not_charged"\)/.test(block.slice(refundAt, delAt)),
        `${file}: the delete is no longer gated on not_charged`,
      );
    }
  }
  const bulk = read("../lib/grading-submit.ts");
  assert(/chargeAttempted = true;\s*const precedence = await runPaymentPrecedence\(/.test(bulk));
  assert(bulk.includes(`refundAmbiguousDebit(ownerId, submissionId, "flipdesk-grading.bulk")`));
});

Deno.test("wiring: the debit adapter re-derives a spent key; a refunded submission never resumes or re-pays", () => {
  const billing = read("../lib/grade-billing.ts");
  const adapter = billing.slice(billing.indexOf("debitCredits: async"));
  const resolveAt = adapter.indexOf("resolveDebitKey(userId, submissionId, idempotencyKey)");
  assert(resolveAt !== -1 && resolveAt < adapter.indexOf('"debit_grade_credits"'));

  const worker = read("../lib/grading-batch-worker.ts");
  assert(/if \(row\.refunded_at\) return false;/.test(worker), "a refunded submission can be resumed");

  const grade = read("../routes/grade.ts");
  assert(grade.includes(`code: "SUBMISSION_REFUNDED"`), "/pay answers 'paid' for a refunded submission");
});

Deno.test("paymentErrorBody: unchanged when nothing moved, names the refund when one happened", () => {
  assertEquals(paymentErrorBody({ kind: "not_charged" }, "s"), { error: "Payment processing error" });
  const r = paymentErrorBody({ kind: "refunded", credits: 1, alreadyRefunded: false }, "s");
  assertEquals(r.creditsRefunded, 1);
  assertEquals(r.submissionId, "s");
  assert(r.error.includes("1 credit taken"));
  assertEquals(paymentErrorBody({ kind: "unknown", error: "x" }, "s").submissionId, "s");
});
