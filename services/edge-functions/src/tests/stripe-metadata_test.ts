// US-1414 / US-1419: Checkout writes our metadata to the PaymentIntent, not the
// Charge, and a raw charge.dispute.created webhook carries an UNEXPANDED
// payment_intent string id. These tests pin the resolution that makes refund
// clawbacks, per-grade certificate withholding, and dispute flagging actually
// fire — the bug was reading charge.metadata / dispute.payment_intent.metadata
// directly and getting {} for every Checkout payment.

import { assert, assertEquals } from "@std/assert";
import type Stripe from "stripe";
import {
  hasAppMetadata,
  paymentIntentIdOf,
  resolveChargeMetadata,
  resolveDisputeMetadata,
} from "../lib/stripe-metadata.ts";

const PI_META: Record<string, string> = {
  user_id: "user-123",
  product: "credit_pack",
  credits: "50",
};

function piFetcher(meta: Record<string, string> | null) {
  let calls = 0;
  const fn = (_id: string) => {
    calls++;
    return Promise.resolve(meta);
  };
  return { fn, calls: () => calls };
}

Deno.test("resolveChargeMetadata falls back to the PaymentIntent when charge.metadata is empty", async () => {
  // Real Checkout shape: empty charge metadata, string payment_intent id.
  const charge = { metadata: {}, payment_intent: "pi_abc" } as unknown as
    Pick<Stripe.Charge, "metadata" | "payment_intent">;
  const f = piFetcher(PI_META);
  const meta = await resolveChargeMetadata(charge, f.fn);
  assertEquals(meta.user_id, "user-123");
  assertEquals(meta.product, "credit_pack");
  assertEquals(meta.credits, "50");
  assertEquals(f.calls(), 1, "must retrieve the PaymentIntent");
});

Deno.test("resolveChargeMetadata resolves per_grade submission_id from the PaymentIntent", async () => {
  const charge = { metadata: {}, payment_intent: "pi_pg" } as unknown as
    Pick<Stripe.Charge, "metadata" | "payment_intent">;
  const f = piFetcher({ user_id: "u9", product: "per_grade", submission_id: "sub-7" });
  const meta = await resolveChargeMetadata(charge, f.fn);
  assertEquals(meta.product, "per_grade");
  assertEquals(meta.submission_id, "sub-7");
});

Deno.test("resolveChargeMetadata prefers the charge's own metadata without a PI call", async () => {
  const charge = {
    metadata: { user_id: "u1", product: "credit_pack", credits: "10" },
    payment_intent: "pi_xyz",
  } as unknown as Pick<Stripe.Charge, "metadata" | "payment_intent">;
  const f = piFetcher(PI_META);
  const meta = await resolveChargeMetadata(charge, f.fn);
  assertEquals(meta.user_id, "u1");
  assertEquals(meta.credits, "10");
  assertEquals(f.calls(), 0, "own metadata present → no PaymentIntent retrieval");
});

Deno.test("resolveChargeMetadata returns own (empty) metadata when there is no PaymentIntent", async () => {
  const charge = { metadata: {}, payment_intent: null } as unknown as
    Pick<Stripe.Charge, "metadata" | "payment_intent">;
  const f = piFetcher(PI_META);
  const meta = await resolveChargeMetadata(charge, f.fn);
  assertEquals(meta.user_id, undefined);
  assertEquals(f.calls(), 0);
});

Deno.test("resolveDisputeMetadata retrieves the PI when payment_intent is an unexpanded string", async () => {
  const dispute = { payment_intent: "pi_dispute" } as unknown as
    Pick<Stripe.Dispute, "payment_intent">;
  const f = piFetcher({ user_id: "u2", product: "per_grade", submission_id: "sub-9" });
  const meta = await resolveDisputeMetadata(dispute, f.fn);
  assertEquals(meta.user_id, "u2");
  assertEquals(meta.submission_id, "sub-9");
  assertEquals(f.calls(), 1);
});

Deno.test("resolveDisputeMetadata uses an expanded PaymentIntent's metadata directly", async () => {
  const dispute = {
    payment_intent: { id: "pi_exp", metadata: { user_id: "u3", product: "per_grade" } },
  } as unknown as Pick<Stripe.Dispute, "payment_intent">;
  const f = piFetcher(null);
  const meta = await resolveDisputeMetadata(dispute, f.fn);
  assertEquals(meta.user_id, "u3");
  assertEquals(f.calls(), 0, "expanded PI metadata present → no extra retrieval");
});

Deno.test("resolveDisputeMetadata returns {} when nothing resolves", async () => {
  const dispute = { payment_intent: null } as unknown as
    Pick<Stripe.Dispute, "payment_intent">;
  const f = piFetcher(PI_META);
  assertEquals(await resolveDisputeMetadata(dispute, f.fn), {});
  assertEquals(f.calls(), 0);
});

Deno.test("helpers: hasAppMetadata + paymentIntentIdOf", () => {
  assert(hasAppMetadata({ user_id: "x" }));
  assert(!hasAppMetadata({}));
  assert(!hasAppMetadata(null));
  assert(!hasAppMetadata({ user_id: "" }));
  assertEquals(paymentIntentIdOf("pi_1"), "pi_1");
  assertEquals(paymentIntentIdOf({ id: "pi_2" }), "pi_2");
  assertEquals(paymentIntentIdOf(null), null);
  assertEquals(paymentIntentIdOf(""), null);
});
