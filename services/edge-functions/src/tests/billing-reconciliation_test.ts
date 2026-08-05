// US-893: pure divergence-detection tests for the Stripe reconciliation console.
// These mirror what the scheduled billing-reconciliation job feeds the detector
// and are DB-less (no supabase / Stripe import), like revenue-window_test.ts.

import { assert, assertEquals } from "@std/assert";
import {
  detectDivergence,
  deriveExpectedState,
  detectStripeDivergence,
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

Deno.test("US-2398: a comped account is not a divergence", () => {
  // The realistic comp: a seller whose subscription was canceled, then granted
  // a tier by hand. The last event on file is the cancellation, so every check
  // below would fire — cached 'comp' vs expected 'canceled', cached 'pro' vs
  // expected 'free' — and the account would sit in the reconciliation queue
  // permanently with nothing to reconcile. A queue of already-correct rows is a
  // queue that stops getting read.
  const r = detectDivergence(
    { status: "comp", plan: "pro" },
    { eventType: "customer.subscription.deleted", toPlan: "pro", rawStatus: "canceled" },
  );
  assert(!r.diverged);
  assert(!r.statusDiverged);
  assert(!r.planDiverged);
  assertEquals(r.reasons.length, 0);

  // A comp on an account that never had Stripe at all, for the same reason.
  const fresh = detectDivergence(
    { status: "comp", plan: "business" },
    { eventType: "customer.subscription.updated", toPlan: "free", rawStatus: "canceled" },
  );
  assert(!fresh.diverged);
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

// ── US-2295: the divergence the job could never see ─────────────────────────
//
// detectDivergence compares our CACHED state against the latest webhook event
// WE RECORDED. Both sides come out of our own database, so it answers "did we
// receive an event and fail to apply it?" — and is structurally blind to "did
// Stripe change something we never heard about?".
//
// A missed webhook writes no event row. The candidate loop then hit
// `if (!row.latest_event_type) continue;` and skipped the account in silence.
// That is exactly the drift the job exists to catch, and it was the one case
// guaranteed to be invisible — the job returned green regardless.
//
// detectStripeDivergence is the other side of the comparison. Status only:
// status is where the revenue leaks, and mapping a Stripe price back to a plan
// tier needs a mapping this module does not own.

Deno.test("US-2295: agreement with Stripe is silent", () => {
  const r = detectStripeDivergence(
    { status: "active", plan: "pro" },
    { id: "sub_1", status: "active" },
  );
  assertEquals(r.diverged, false);
});

Deno.test("US-2295: Stripe canceled while we serve active — the expensive one", () => {
  // A customer being served a paid plan for free, indefinitely, with no event
  // row anywhere to notice it by.
  const r = detectStripeDivergence(
    { status: "active", plan: "pro" },
    { id: "sub_1", status: "canceled" },
  );
  assertEquals(r.diverged, true);
  assert(r.reasons[0]?.includes("sub_1"));
  assert(r.reasons[0]?.includes("cached 'active'"));
});

Deno.test("US-2295: Stripe active while we say canceled — the other direction", () => {
  // Cheaper for us, worse for them: a paying customer locked out of what they
  // are paying for.
  assertEquals(
    detectStripeDivergence(
      { status: "canceled", plan: "free" },
      { id: "sub_1", status: "active" },
    ).diverged,
    true,
  );
});

Deno.test("US-2295: an account we never heard a webhook for still diverges", () => {
  // The whole point. A null cached status is what a missed-from-the-start
  // account looks like, and the old loop skipped it before anything compared.
  const r = detectStripeDivergence(
    { status: null, plan: null },
    { id: "sub_9", status: "active" },
  );
  assertEquals(r.diverged, true);
  assert(r.reasons[0]?.includes("cached '—'"));
});

Deno.test("US-2295: an unmapped Stripe status fails CLOSED", () => {
  // Stripe adding a state must not fill the queue with flags. A noisy
  // reconciliation queue is an ignored one, which returns us to where we
  // started.
  for (const status of [null, "", "some_future_status"]) {
    const r = detectStripeDivergence({ status: "active", plan: "pro" }, {
      id: "sub_1",
      status,
    });
    assertEquals(r.diverged, false, `${status} must not flag`);
    assertEquals(r.expectedStatus, null);
  }
});

Deno.test("US-2295: the job actually calls Stripe and reports whether it did", async () => {
  // A source assertion because the defect was an ABSENT call — there is no
  // wrong value to catch. It also pins the two things that make the result
  // honest: the Stripe check runs BEFORE the latest_event_type guard that hid
  // it, and the response says whether the Stripe half ran at all, so an
  // unreachable Stripe is not reported as a clean bill of health.
  const src = await Deno.readTextFile(
    new URL("../routes/jobs-billing-reconciliation.ts", import.meta.url),
  );
  assert(src.includes("getStripe"), "the job must talk to Stripe");
  assert(src.includes("detectStripeDivergence"));
  assert(src.includes('status: "all"'), "canceled subs must be listed, or the worst case is filtered out");
  assert(src.includes("stripeChecked"), "the response must say whether Stripe was reached");
  assert(
    src.indexOf("detectStripeDivergence") < src.indexOf("if (!row.latest_event_type) continue;"),
    "the Stripe check must run BEFORE the guard that made a missed webhook invisible",
  );
});
