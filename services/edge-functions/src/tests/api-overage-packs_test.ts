// US-1792: API overage credit packs — pack catalog + validation. The grant/debit
// RPCs (00415) are SQL, covered by the verify:db lane; here we guard the pure
// constants (volume-discount monotonicity + price↔env mapping) that the checkout
// + webhook read.
import { assertEquals } from "@std/assert";
import { API_OVERAGE_PACKS, isApiOveragePackKey } from "../lib/api-overage-packs.ts";

Deno.test("isApiOveragePackKey accepts only the four packs", () => {
  for (const k of ["10", "50", "100", "200"]) assertEquals(isApiOveragePackKey(k), true);
  for (const k of ["5", "1000", "", "guard", 10]) assertEquals(isApiOveragePackKey(k), false);
});

Deno.test("packs: credits scale with volume discount (more $ → cheaper per credit)", () => {
  const keys = ["10", "50", "100", "200"] as const;
  const perCredit = keys.map((k) => API_OVERAGE_PACKS[k].priceCents / API_OVERAGE_PACKS[k].credits);
  // Strictly decreasing $/credit as the pack grows = a real volume discount.
  for (let i = 1; i < perCredit.length; i++) {
    assertEquals(perCredit[i] < perCredit[i - 1], true, `pack ${keys[i]} must be cheaper per credit than ${keys[i - 1]}`);
  }
  // Prices match the dollar keys.
  assertEquals(API_OVERAGE_PACKS["10"].priceCents, 1000);
  assertEquals(API_OVERAGE_PACKS["200"].priceCents, 20000);
});

Deno.test("packs: each carries a distinct Stripe price env var", () => {
  const envs = Object.values(API_OVERAGE_PACKS).map((p) => p.priceEnv);
  assertEquals(new Set(envs).size, envs.length);
  assertEquals(API_OVERAGE_PACKS["100"].priceEnv, "STRIPE_PRICE_API_OVERAGE_100");
});
