// US-1929: checkout.session.completed must not grant entitlement (credit packs,
// per-grade-to-paid, API overage) unless the funds actually settled. Today every
// checkout is card-only (synchronous) so `completed` implies paid, but the guard
// makes that an explicit invariant so enabling an async method can't grant on
// "unpaid"/"processing". This pins the pure predicate the handler early-returns
// on. webhooks.ts inits the service-role supabase client at module load, so set
// dummy env BEFORE the dynamic import.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { checkoutFundsSettled } = await import("../routes/webhooks.ts");

Deno.test("checkoutFundsSettled: 'paid' grants (settled)", () => {
  assertEquals(checkoutFundsSettled("paid"), true);
});

Deno.test("checkoutFundsSettled: 'no_payment_required' grants (100%-off)", () => {
  assertEquals(checkoutFundsSettled("no_payment_required"), true);
});

Deno.test("checkoutFundsSettled: 'unpaid' grants nothing", () => {
  assertEquals(checkoutFundsSettled("unpaid"), false);
});

Deno.test("checkoutFundsSettled: null / undefined grant nothing (fail-closed)", () => {
  assertEquals(checkoutFundsSettled(null), false);
  assertEquals(checkoutFundsSettled(undefined), false);
});
