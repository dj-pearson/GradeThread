// US-1443: charge.dispute.closed completes the dispute lifecycle. dispute.created
// only flags the submission for review (a dispute can still be won); on close we
// reconcile automatically. disputeClosedAction is the decision that routes a
// closed dispute to the reused refund clawback (lost) vs a flag-clear (won) vs no
// financial action (non-terminal close). The clawback + withhold mechanics
// themselves are pinned by credit-refund_test / per-grade-idempotency_test; this
// file pins the lifecycle routing for BOTH outcomes.
//
// webhooks.ts imports the service-role supabase client at module init, so set
// dummy env BEFORE the dynamic import (mirrors stripe-webhook-handler_test).
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { disputeClosedAction } = await import("../routes/webhooks.ts");

Deno.test("lost dispute → clawback (reuse the refund clawback path)", () => {
  assertEquals(disputeClosedAction("lost"), "clawback");
});

Deno.test("won dispute → clear the review flag", () => {
  assertEquals(disputeClosedAction("won"), "clear_flag");
});

Deno.test("non-terminal close → no financial action", () => {
  assertEquals(disputeClosedAction("warning_closed"), "none");
  assertEquals(disputeClosedAction("under_review"), "none");
  assertEquals(disputeClosedAction("needs_response"), "none");
});
