// US-1919: a partial credit-pack refund / partial lost dispute must claw back
// only the refunded fraction of the pack, not the whole thing. Stripe fires
// charge.refunded for PARTIAL refunds (the Dashboard path), so a $10 refund on a
// $50 / 50-credit pack must revoke 10 credits, not 50. This pins the pure
// scaling helper both webhook paths route through. webhooks.ts inits the
// service-role supabase client at module load, so set dummy env before import.
import { assertEquals, assertNotEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { proportionalClawback, resolveRefundClawback } = await import(
  "../routes/webhooks.ts"
);

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

// ── US-2033: the SEQUENTIAL-PARTIAL-REFUND case ──────────────────────────
//
// The arithmetic below was always right; the BUG was that the ledger write was
// keyed per CHARGE while the amount was CUMULATIVE, so the second refund
// computed the correct total and then skipped the write because the key was
// already claimed. These pin the incremental interpretation the fix depends on.

Deno.test("sequential partial refunds sum to the full grant (incremental amounts)", () => {
  // $50 / 50-credit pack. Refund $10, then the remaining $40.
  const first = proportionalClawback(50, 1000, 5000); // 10 credits
  const second = proportionalClawback(50, 4000, 5000); // 40 credits
  assertEquals(first, 10);
  assertEquals(second, 40);
  assertEquals(
    first + second,
    50,
    "two partial refunds must claw back the whole pack between them — under the " +
      "old per-charge key the second write no-opped and the customer kept 40 " +
      "credits AND all their money",
  );
});

Deno.test("the CUMULATIVE reading is what made the second refund wrong", () => {
  // If the caller passes the cumulative amount for the second event (the old
  // behaviour), it asks to revoke the FULL 50 — correct as a running total, but
  // catastrophic if it were ever to actually land after the first 10 already
  // did. The fix is to pass the increment; this documents why.
  assertEquals(proportionalClawback(50, 5000, 5000), 50);
  assertEquals(
    proportionalClawback(50, 1000, 5000) + proportionalClawback(50, 5000, 5000),
    60,
    "cumulative + cumulative over-claws (10 + 50 = 60 of a 50-credit pack) — " +
      "which is why the amount passed per event must be the increment",
  );
});

Deno.test("many small refunds still cannot exceed the grant", () => {
  // Rounding must not let five $10 refunds on a $50 pack exceed 50 credits.
  const total = [1000, 1000, 1000, 1000, 1000]
    .map((amt) => proportionalClawback(50, amt, 5000))
    .reduce((a, b) => a + b, 0);
  assertEquals(total, 50);
});

Deno.test("a refund larger than the charge is clamped to the grant", () => {
  assertEquals(proportionalClawback(50, 9999, 5000), 50);
});

// ── US-2040: the KEYING decision, which is where US-2033's bug actually lived ──
//
// Everything above tests proportionalClawback — the pure arithmetic that was
// never broken. The real defect was that the AMOUNT was cumulative while the
// KEY was per-charge, so a second partial refund computed the right number and
// then skipped the write. That logic was unreachable from a test until
// resolveRefundClawback was extracted; reverting the key to charge.id would
// have left every suite green while a customer kept credits and money both.


Deno.test("US-2040: two partial refunds produce TWO DISTINCT keys", () => {
  // First refund: $10 of a $50 charge.
  const first = resolveRefundClawback({
    id: "ch_1",
    amount_refunded: 1000,
    refunds: { data: [{ id: "re_1", amount: 1000, created: 100 }] },
  });
  // Second refund: the remaining $40. amount_refunded is now CUMULATIVE (5000).
  const second = resolveRefundClawback({
    id: "ch_1",
    amount_refunded: 5000,
    refunds: {
      data: [
        { id: "re_1", amount: 1000, created: 100 },
        { id: "re_2", amount: 4000, created: 200 },
      ],
    },
  });

  assertEquals(first.idempotencyKey, "pack-refund:re_1");
  assertEquals(second.idempotencyKey, "pack-refund:re_2");
  assertNotEquals(
    first.idempotencyKey,
    second.idempotencyKey,
    "each refund must claim its OWN key — a shared per-charge key is exactly " +
      "what made the second clawback silently no-op",
  );

  // And the amounts are INCREMENTAL, not cumulative.
  assertEquals(first.incremental, 1000);
  assertEquals(second.incremental, 4000, "must be this refund's amount, not 5000");

  // End to end: the two increments claw back the whole 50-credit pack.
  assertEquals(
    proportionalClawback(50, first.incremental, 5000) +
      proportionalClawback(50, second.incremental, 5000),
    50,
  );
});

Deno.test("US-2040: the newest refund is picked by `created`, not list order", () => {
  // Stripe does not guarantee ordering, so a reducer that trusted position
  // would pick the wrong refund and claw the wrong increment.
  const outOfOrder = resolveRefundClawback({
    id: "ch_2",
    amount_refunded: 5000,
    refunds: {
      data: [
        { id: "re_new", amount: 4000, created: 900 },
        { id: "re_old", amount: 1000, created: 100 },
      ],
    },
  });
  assertEquals(outOfOrder.refundId, "re_new");
  assertEquals(outOfOrder.incremental, 4000);
});

Deno.test("US-2040: same-timestamp refunds resolve DETERMINISTICALLY", () => {
  // Redeliveries of the same event must land on the same refund, or the key
  // flaps and the clawback double-applies under two different keys.
  const a = resolveRefundClawback({
    id: "ch_3",
    amount_refunded: 2000,
    refunds: {
      data: [
        { id: "re_aaa", amount: 1000, created: 500 },
        { id: "re_bbb", amount: 1000, created: 500 },
      ],
    },
  });
  const b = resolveRefundClawback({
    id: "ch_3",
    amount_refunded: 2000,
    // Same set, opposite order — a redelivery could serialize either way.
    refunds: {
      data: [
        { id: "re_bbb", amount: 1000, created: 500 },
        { id: "re_aaa", amount: 1000, created: 500 },
      ],
    },
  });
  assertEquals(a.idempotencyKey, b.idempotencyKey);
  assertEquals(a.refundId, "re_bbb", "id tie-break: the greater id wins");
});

Deno.test("US-2040: a missing refunds list still claws back (degrades, never skips)", () => {
  for (const refunds of [undefined, null, { data: [] }, { data: undefined }]) {
    const r = resolveRefundClawback({
      id: "ch_4",
      amount_refunded: 2500,
      refunds: refunds as never,
    });
    // Falls back to the cumulative amount + the per-charge key. That UNDER-claws
    // a multi-refund charge — the pre-existing bug — but clawing something is
    // strictly better than clawing nothing.
    assertEquals(r.incremental, 2500);
    assertEquals(r.idempotencyKey, "pack-refund:ch_4");
    assertEquals(r.refundId, null, "null refundId is what triggers the warn log");
  }
});
