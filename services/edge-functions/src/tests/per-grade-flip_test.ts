// US-1640: a duplicate per-grade payment must be refunded, not silently kept.

import { assertEquals } from "@std/assert";
import { classifyPerGradeFlip } from "../lib/per-grade-flip.ts";

Deno.test("a claimed flip is 'paid' (proceed to grade)", () => {
  assertEquals(
    classifyPerGradeFlip({
      flipped: true,
      existing: null,
      currentPaymentIntentId: "pi_1",
    }),
    "paid",
  );
});

Deno.test("0-row flip on a submission already paid by ANOTHER charge is 'duplicate'", () => {
  assertEquals(
    classifyPerGradeFlip({
      flipped: false,
      existing: { payment_status: "paid_stripe", stripe_payment_intent_id: "pi_1" },
      currentPaymentIntentId: "pi_2", // a second, duplicate session
    }),
    "duplicate",
  );
});

Deno.test("0-row flip where the stored PI equals THIS PI is 'already' (no refund)", () => {
  // A stray re-process of the same charge — must NOT refund the legitimate payment.
  assertEquals(
    classifyPerGradeFlip({
      flipped: false,
      existing: { payment_status: "paid_stripe", stripe_payment_intent_id: "pi_1" },
      currentPaymentIntentId: "pi_1",
    }),
    "already",
  );
});

Deno.test("a Stripe per-grade charge landing on an already-'included' grade is a refundable duplicate", () => {
  // The grade was already satisfied via the plan's included allowance (no Stripe
  // charge). A later Stripe per-grade payment for the same submission is money
  // the user shouldn't have paid → refund it (stored PI is null ≠ this PI).
  assertEquals(
    classifyPerGradeFlip({
      flipped: false,
      existing: { payment_status: "included", stripe_payment_intent_id: null },
      currentPaymentIntentId: "pi_2",
    }),
    "duplicate",
  );
});

Deno.test("0-row flip with no submission row is 'missing'", () => {
  assertEquals(
    classifyPerGradeFlip({
      flipped: false,
      existing: null,
      currentPaymentIntentId: "pi_2",
    }),
    "missing",
  );
});
