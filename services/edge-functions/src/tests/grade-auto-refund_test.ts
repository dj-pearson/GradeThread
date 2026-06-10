// US-771: per-grade Stripe auto-refund policy. The pipeline charges before
// grading; when a paid_stripe submission ends up ungraded, refund_grade returns
// 'no_refund_paid_stripe' and autoRefundPaidStripe must issue exactly one Stripe
// refund — or, on failure / missing PaymentIntent, queue an operator follow-up.
// Driven through injectable deps so no DB or live Stripe is needed.
import { assert, assertEquals } from "@std/assert";
import {
  autoRefundPaidStripe,
  type StripeRefundDeps,
} from "../lib/grade-refund.ts";

interface Recorded {
  refundsIssued: string[]; // payment intents we issued refunds for
  persisted: Array<{ submissionId: string; refundId: string }>;
  pending: Array<{ submissionId: string; pi: string | null; error: string }>;
}

// Build deps over an in-memory submission whose refunded_at starts NULL. The
// claim flips it once (mirrors the conditional UPDATE ... WHERE refunded_at IS
// NULL), so a second call sees it claimed and returns null.
function makeDeps(opts: {
  paymentIntentId: string | null;
  refundThrows?: boolean;
}): { deps: StripeRefundDeps; rec: Recorded } {
  let claimed = false;
  const rec: Recorded = { refundsIssued: [], persisted: [], pending: [] };
  const deps: StripeRefundDeps = {
    claim(_submissionId) {
      if (claimed) return Promise.resolve(null);
      claimed = true;
      return Promise.resolve({ userId: "u1", paymentIntentId: opts.paymentIntentId });
    },
    issueRefund(paymentIntentId, _submissionId, _reason) {
      if (opts.refundThrows) return Promise.reject(new Error("card_declined"));
      rec.refundsIssued.push(paymentIntentId);
      return Promise.resolve("re_123");
    },
    persistRefundId(submissionId, refundId) {
      rec.persisted.push({ submissionId, refundId });
      return Promise.resolve();
    },
    recordPending(submissionId, _userId, pi, _reason, error) {
      rec.pending.push({ submissionId, pi, error });
      return Promise.resolve();
    },
  };
  return { deps, rec };
}

Deno.test("successful auto-refund issues one Stripe refund and persists the id", async () => {
  const { deps, rec } = makeDeps({ paymentIntentId: "pi_abc" });
  await autoRefundPaidStripe("sub1", "pipeline_failed", deps);
  assertEquals(rec.refundsIssued, ["pi_abc"]);
  assertEquals(rec.persisted, [{ submissionId: "sub1", refundId: "re_123" }]);
  assertEquals(rec.pending.length, 0);
});

Deno.test("a Stripe failure queues a pending_refunds row (no persisted refund)", async () => {
  const { deps, rec } = makeDeps({ paymentIntentId: "pi_abc", refundThrows: true });
  await autoRefundPaidStripe("sub2", "pipeline_failed", deps);
  assertEquals(rec.refundsIssued.length, 0);
  assertEquals(rec.persisted.length, 0);
  assertEquals(rec.pending.length, 1);
  assertEquals(rec.pending[0].submissionId, "sub2");
  assertEquals(rec.pending[0].pi, "pi_abc");
  assert(rec.pending[0].error.includes("card_declined"));
});

Deno.test("a missing PaymentIntent queues a pending row without calling Stripe", async () => {
  const { deps, rec } = makeDeps({ paymentIntentId: null });
  await autoRefundPaidStripe("sub3", "needs_photos", deps);
  assertEquals(rec.refundsIssued.length, 0);
  assertEquals(rec.pending.length, 1);
  assertEquals(rec.pending[0].pi, null);
  assert(rec.pending[0].error.toLowerCase().includes("payment_intent"));
});

Deno.test("a second call after a successful refund is a no-op (at most one refund)", async () => {
  const { deps, rec } = makeDeps({ paymentIntentId: "pi_abc" });
  await autoRefundPaidStripe("sub4", "pipeline_failed", deps); // claims + refunds
  await autoRefundPaidStripe("sub4", "pipeline_failed", deps); // claim returns null
  assertEquals(rec.refundsIssued, ["pi_abc"]); // still exactly one
  assertEquals(rec.persisted.length, 1);
});

Deno.test("a second call after a queued failure does not re-attempt the refund", async () => {
  const { deps, rec } = makeDeps({ paymentIntentId: "pi_abc", refundThrows: true });
  await autoRefundPaidStripe("sub5", "pipeline_failed", deps); // claims, fails, queues
  await autoRefundPaidStripe("sub5", "pipeline_failed", deps); // claim returns null
  assertEquals(rec.refundsIssued.length, 0);
  assertEquals(rec.pending.length, 1); // not re-queued
});
