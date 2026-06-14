// US-893: pure divergence-detection tests for the Stripe reconciliation console.
// These mirror what the scheduled billing-reconciliation job feeds the detector
// and are DB-less (no supabase / Stripe import), like revenue-window_test.ts.

import { assert, assertEquals } from "@std/assert";
import {
  detectDivergence,
  deriveExpectedState,
} from "../lib/billing-reconciliation.ts";

Deno.test("deriveExpectedState: event type drives status for unambiguous events", () => {
  assertEquals(
    deriveExpectedState({ eventType: "customer.subscription.deleted", toPlan: "pro", rawStatus: "canceled" }),
    { status: "canceled", plan: "free" },
  );
  assertEquals(
    deriveExpectedState({ eventType: "invoice.payment_failed", toPlan: "pro", rawStatus: "past_due" }),
    { status: "past_due", plan: "pro" },
  );
  assertEquals(
    deriveExpectedState({ eventType: "invoice.payment_succeeded", toPlan: "pro", rawStatus: "active" }),
    { status: "active", plan: "pro" },
  );
  assertEquals(
    deriveExpectedState({ eventType: "customer.subscription.paused", toPlan: "pro", rawStatus: "active" }),
    { status: "paused", plan: "pro" },
  );
});

Deno.test("deriveExpectedState: create/update fall back to the recorded raw Stripe status", () => {
  assertEquals(
    deriveExpectedState({ eventType: "customer.subscription.updated", toPlan: "starter", rawStatus: "active" }),
    { status: "active", plan: "starter" },
  );
  // unpaid folds to past_due (mirrors webhooks.mapSubscriptionStatus)
  assertEquals(
    deriveExpectedState({ eventType: "customer.subscription.updated", toPlan: "pro", rawStatus: "unpaid" }),
    { status: "past_due", plan: "pro" },
  );
  // unknown raw status fails closed to null status (no false divergence)
  assertEquals(
    deriveExpectedState({ eventType: "customer.subscription.updated", toPlan: "pro", rawStatus: "weird_future" }),
    { status: null, plan: "pro" },
  );
});

Deno.test("detectDivergence: matching cached state is not divergent", () => {
  const r = detectDivergence(
    { status: "active", plan: "pro" },
    { eventType: "customer.subscription.updated", toPlan: "pro", rawStatus: "active" },
  );
  assert(!r.diverged);
  assertEquals(r.reasons.length, 0);
});

Deno.test("detectDivergence: a deleted event but still-active cache is flagged (missed webhook)", () => {
  const r = detectDivergence(
    { status: "active", plan: "pro" },
    { eventType: "customer.subscription.deleted", toPlan: "pro", rawStatus: "canceled" },
  );
  assert(r.diverged);
  assert(r.statusDiverged);
  assert(r.planDiverged); // expected free, cached pro, and canceled isn't lenient
});

Deno.test("detectDivergence: past_due grace keeps the paid plan — only status can diverge", () => {
  // Cached plan still 'pro' on a past_due sub is legitimate (dunning grace), so
  // the plan must NOT be flagged; the status here already matches → no divergence.
  const ok = detectDivergence(
    { status: "past_due", plan: "pro" },
    { eventType: "invoice.payment_failed", toPlan: "pro", rawStatus: "past_due" },
  );
  assert(!ok.diverged);

  // But a status mismatch on the same event IS flagged (cache says active).
  const bad = detectDivergence(
    { status: "active", plan: "pro" },
    { eventType: "invoice.payment_failed", toPlan: "pro", rawStatus: "past_due" },
  );
  assert(bad.diverged);
  assert(bad.statusDiverged);
  assert(!bad.planDiverged); // plan stays lenient under past_due
});

Deno.test("detectDivergence: unknown/null implied status does not produce a status flag", () => {
  const r = detectDivergence(
    { status: "active", plan: "pro" },
    { eventType: "customer.subscription.updated", toPlan: "pro", rawStatus: "weird_future" },
  );
  assert(!r.diverged); // status null (skip) + plan matches
});

Deno.test("detectDivergence: null expected plan is never a plan divergence", () => {
  const r = detectDivergence(
    { status: "active", plan: "pro" },
    { eventType: "customer.subscription.updated", toPlan: null, rawStatus: "active" },
  );
  assert(!r.diverged);
});

Deno.test("detectDivergence: plan-only mismatch on an active sub is flagged", () => {
  const r = detectDivergence(
    { status: "active", plan: "starter" },
    { eventType: "customer.subscription.updated", toPlan: "pro", rawStatus: "active" },
  );
  assert(r.diverged);
  assert(!r.statusDiverged);
  assert(r.planDiverged);
});
