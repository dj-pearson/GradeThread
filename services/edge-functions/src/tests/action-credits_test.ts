// US-3138: Action Credit packs and spend rates.
//
// The wallet RPCs (00763) are SQL, proved by scripts/prove-action-credits.sql
// and the verify:db lane. What is guarded here is the pure pricing table, and
// one rule in particular that no type can express:
//
//   EVERY pack's per-credit price must be at or above the per-AI-action rate
//   the Pro plan already implies ($59 / 750 actions).
//
// If a pack ever prices below that, buying top-ups beats upgrading on the pure
// per-action metric and the plan ladder inverts. That is a pricing mistake a
// reviewer cannot see by reading four dollar amounts, so it is a test.
import "./_env.ts";
import { assertEquals } from "@std/assert";
import {
  ACTION_CREDIT_COSTS,
  ACTION_CREDIT_PACK_KEYS,
  ACTION_CREDIT_PACKS,
  isActionCreditPackKey,
  isLowBalance,
  LOW_BALANCE_THRESHOLD,
  PRO_AI_ACTIONS_PER_MONTH,
  PRO_IMPLIED_CENTS_PER_ACTION,
  pricePerCredit,
} from "../lib/action-credits.ts";
import { AI_ACTION_LIMITS } from "../lib/ai-quota.ts";

Deno.test("isActionCreditPackKey accepts only the four packs", () => {
  for (const k of ["50", "150", "400", "1000"]) {
    assertEquals(isActionCreditPackKey(k), true);
  }
  for (const k of ["25", "100", "", "boost", 50, null, undefined]) {
    assertEquals(isActionCreditPackKey(k), false);
  }
});

Deno.test("packs: the key is the credit count, and prices are the agreed ones", () => {
  assertEquals(ACTION_CREDIT_PACKS["50"].credits, 50);
  assertEquals(ACTION_CREDIT_PACKS["50"].priceCents, 499);
  assertEquals(ACTION_CREDIT_PACKS["150"].credits, 150);
  assertEquals(ACTION_CREDIT_PACKS["150"].priceCents, 1399);
  assertEquals(ACTION_CREDIT_PACKS["400"].credits, 400);
  assertEquals(ACTION_CREDIT_PACKS["400"].priceCents, 3499);
  assertEquals(ACTION_CREDIT_PACKS["1000"].credits, 1000);
  assertEquals(ACTION_CREDIT_PACKS["1000"].priceCents, 7999);
});

Deno.test("packs: a bigger pack is never worse value than a smaller one", () => {
  const perCredit = ACTION_CREDIT_PACK_KEYS.map((k) => pricePerCredit(ACTION_CREDIT_PACKS[k]));
  for (let i = 1; i < perCredit.length; i++) {
    assertEquals(
      perCredit[i]! < perCredit[i - 1]!,
      true,
      `pack ${ACTION_CREDIT_PACK_KEYS[i]} must be cheaper per credit than ${ACTION_CREDIT_PACK_KEYS[i - 1]}`,
    );
  }
});

Deno.test("packs: no pack undercuts Pro's implied per-action rate (the ladder must not invert)", () => {
  const proRate = PRO_IMPLIED_CENTS_PER_ACTION;
  for (const key of ACTION_CREDIT_PACK_KEYS) {
    const rate = pricePerCredit(ACTION_CREDIT_PACKS[key]);
    assertEquals(
      rate >= proRate,
      true,
      `pack ${key} is ${rate.toFixed(4)}c/credit, below Pro's implied ${proRate.toFixed(4)}c ` +
        `- topping up would beat upgrading and the plan ladder inverts`,
    );
  }
});

Deno.test("packs: the smallest pack is a genuine impulse price, under $10", () => {
  assertEquals(ACTION_CREDIT_PACKS["50"].priceCents < 1000, true);
});

Deno.test("packs: each carries its own STRIPE_PRICE_ACTION_CREDITS_* env var", () => {
  const seen = new Set<string>();
  for (const key of ACTION_CREDIT_PACK_KEYS) {
    const env = ACTION_CREDIT_PACKS[key].priceEnv;
    assertEquals(env, `STRIPE_PRICE_ACTION_CREDITS_${key}`);
    assertEquals(seen.has(env), false, `duplicate price env ${env}`);
    seen.add(env);
  }
  assertEquals(seen.size, 4);
});

Deno.test("packs: the record key always equals the pack's own key and credit count", () => {
  for (const key of ACTION_CREDIT_PACK_KEYS) {
    assertEquals(ACTION_CREDIT_PACKS[key].key, key);
    assertEquals(String(ACTION_CREDIT_PACKS[key].credits), key);
  }
});

Deno.test("spend rates: v1 is flat, one credit per action", () => {
  assertEquals(ACTION_CREDIT_COSTS.ai_action, 1);
  assertEquals(ACTION_CREDIT_COSTS.connector_action, 1);
});

Deno.test("spend rates: every rate is a positive whole number", () => {
  for (const [meter, cost] of Object.entries(ACTION_CREDIT_COSTS)) {
    assertEquals(Number.isInteger(cost) && cost > 0, true, `${meter} costs ${cost}`);
  }
});

Deno.test("low balance: the threshold is exclusive", () => {
  assertEquals(LOW_BALANCE_THRESHOLD, 20);
  assertEquals(isLowBalance(0), true);
  assertEquals(isLowBalance(19), true);
  assertEquals(isLowBalance(20), false);
  assertEquals(isLowBalance(1000), false);
});

Deno.test("the ladder guard's premise has not drifted from the plan matrix", () => {
  // action-credits.ts duplicates Pro's monthly action count to avoid an import
  // cycle. If the plan changes and this does not, the ladder guard silently
  // starts measuring against a rate nobody charges.
  assertEquals(PRO_AI_ACTIONS_PER_MONTH, AI_ACTION_LIMITS.pro);
});

Deno.test("the smallest pack is worth more than a Free plan's whole month", () => {
  // A top-up that buys less than the free tier hands out for nothing would be
  // an insulting offer. 50 > 25.
  assertEquals(ACTION_CREDIT_PACKS["50"].credits > AI_ACTION_LIMITS.free!, true);
});
