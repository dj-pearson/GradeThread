// US-1919: a partial credit-pack refund / partial lost dispute must claw back
// only the refunded fraction of the pack, not the whole thing. Stripe fires
// charge.refunded for PARTIAL refunds (the Dashboard path), so a $10 refund on a
// $50 / 50-credit pack must revoke 10 credits, not 50. This pins the pure
// scaling helper both webhook paths route through. webhooks.ts inits the
// service-role supabase client at module load, so set dummy env before import.
import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { proportionalClawback } = await import("../routes/webhooks.ts");

Deno.test("partial refund scales proportionally ($10 of $50, 50 credits → 10)", () => {
  assertEquals(proportionalClawback(50, 1000, 5000), 10);
});

Deno.test("full refund revokes the whole pack", () => {
  assertEquals(proportionalClawback(50, 5000, 5000), 50);
});

Deno.test("over-refund (amount_refunded > amount) clamps to the granted pack", () => {
  assertEquals(proportionalClawback(50, 6000, 5000), 50);
});

Deno.test("rounds half-up to whole credits ($33 of $50, 50 credits → 33)", () => {
  // 50 * 3300 / 5000 = 33.0
  assertEquals(proportionalClawback(50, 3300, 5000), 33);
  // 50 * 2500 / 5000 = 25.0 ; 3 credits * 2500/5000 = 1.5 → 2 (half-up)
  assertEquals(proportionalClawback(3, 2500, 5000), 2);
});

Deno.test("nothing refunded revokes nothing", () => {
  assertEquals(proportionalClawback(50, 0, 5000), 0);
});

Deno.test("$0 charge (amount 0) — no divide-by-zero; refunded 0 → 0", () => {
  assertEquals(proportionalClawback(50, 0, 0), 0);
});

Deno.test("defensive: refunded>0 with a 0 basis → full pack (never happens on Stripe)", () => {
  assertEquals(proportionalClawback(50, 100, 0), 50);
});

Deno.test("invalid granted → 0", () => {
  assertEquals(proportionalClawback(0, 1000, 5000), 0);
  assertEquals(proportionalClawback(Number.NaN, 1000, 5000), 0);
});
