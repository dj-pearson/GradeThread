// US-461: the reconciliation candidate-net estimate must account for the
// shipping label cost + buyer-paid shipping (not just sale_price - fees), and
// must flag estimated (unenriched) nets so they don't silently outrank
// ground-truth payout figures.

import { assertEquals } from "@std/assert";
import { saleNetEstimate, type SaleNetInput } from "../lib/reconciliation-scoring.ts";

function sale(overrides: Partial<SaleNetInput>): SaleNetInput {
  return {
    sale_price: null,
    payout_amount: null,
    platform_fees: null,
    shipping_collected: null,
    shipping_cost: null,
    payment_processing_fees: null,
    ...overrides,
  };
}

Deno.test("enriched payout_amount is used verbatim and not flagged", () => {
  const r = saleNetEstimate(sale({ payout_amount: 42.5, sale_price: 100 }));
  assertEquals(r, { net: 42.5, estimated: false });
});

Deno.test("free-shipping sale deducts the eBay label cost", () => {
  // $50 item, free shipping to buyer, $8 eBay label, $6.50 fees.
  const r = saleNetEstimate(
    sale({ sale_price: 50, platform_fees: 6.5, shipping_cost: 8, shipping_collected: 0 }),
  );
  assertEquals(r.estimated, true);
  assertEquals(r.net, 35.5); // 50 + 0 - 6.5 - 8 - 0
});

Deno.test("buyer-paid shipping is added to the net", () => {
  // $40 item + $9.99 buyer-paid shipping - $6 fees - $9 label - $0 proc.
  const r = saleNetEstimate(
    sale({
      sale_price: 40,
      shipping_collected: 9.99,
      platform_fees: 6,
      shipping_cost: 9,
    }),
  );
  assertEquals(Number(r.net?.toFixed(2)), 34.99);
});

Deno.test("payment processing fees are deducted", () => {
  const r = saleNetEstimate(
    sale({ sale_price: 100, platform_fees: 10, payment_processing_fees: 3 }),
  );
  assertEquals(r.net, 87);
});

Deno.test("missing sale_price yields a null net (unscoreable)", () => {
  assertEquals(saleNetEstimate(sale({})), { net: null, estimated: true });
});

Deno.test("old behavior (sale_price - fees) is no longer the estimate", () => {
  // Old code returned 50 - 6.5 = 43.5; the corrected estimate is lower because
  // it now subtracts the $8 label cost.
  const r = saleNetEstimate(sale({ sale_price: 50, platform_fees: 6.5, shipping_cost: 8 }));
  assertEquals(r.net !== 43.5, true);
  assertEquals(r.net, 35.5);
});
