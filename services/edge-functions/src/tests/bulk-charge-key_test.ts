// US-2564: a retried FlipDesk bulk batch charges once per garment.
//
// The property under test is not "the key looks right", it is "running the
// charge twice with the same batch_key debits once". performPaymentPrecedence
// takes its IO as an argument, so that can be exercised end-to-end against a
// fake ledger that models what debit_grade_credits actually does with a
// duplicate idempotency_key — which is the thing the route relies on and which
// no unit test previously covered from this direction.

import { assert, assertEquals } from "@std/assert";
// Imported from grade-pricing.ts, not grade-billing.ts: the latter constructs
// the service-role client at import time, which throws without SUPABASE_URL.
// grade-billing re-exports this symbol for route callers.
import { bulkChargeKey } from "../lib/grade-pricing.ts";
import {
  performPaymentPrecedence,
  type PrecedenceIO,
} from "../lib/grade-precedence.ts";

const ITEM_A = "11111111-1111-4111-8111-111111111111";
const ITEM_B = "22222222-2222-4222-8222-222222222222";

Deno.test("the key is stable for the same batch + item, and unique per item", () => {
  assertEquals(bulkChargeKey("batch-1", ITEM_A), bulkChargeKey("batch-1", ITEM_A));
  assert(bulkChargeKey("batch-1", ITEM_A) !== bulkChargeKey("batch-1", ITEM_B));
  assert(bulkChargeKey("batch-1", ITEM_A) !== bulkChargeKey("batch-2", ITEM_A));
});

Deno.test("an absent batch_key yields NULL, never an empty-string key", () => {
  // This is the whole reason bulkChargeKey is a function rather than a template
  // literal at the call site. "" is a REAL key that every keyless caller would
  // share, so the first such charge in the product would suppress every later
  // one — a global outage of billing, arriving as silence.
  assertEquals(bulkChargeKey(undefined, ITEM_A), null);
  assertEquals(bulkChargeKey(null, ITEM_A), null);
  assertEquals(bulkChargeKey("", ITEM_A), null);
  assertEquals(bulkChargeKey("   ", ITEM_A), null);
});

Deno.test("surrounding whitespace does not mint a second key", () => {
  assertEquals(bulkChargeKey(" batch-1 ", ITEM_A), bulkChargeKey("batch-1", ITEM_A));
});

// ── The behaviour AC4 asks for: run the charge twice, debit once ────────────

/**
 * A fake wallet that models the part of `debit_grade_credits` this story leans
 * on: a repeated idempotency_key performs the debit ONCE and reports success
 * with the CURRENT balance (migration 00516). Getting this wrong in either
 * direction is the bug — raising on the replay would push the caller into a
 * checkout it does not need, and debiting again is the double charge.
 */
function fakeWallet(startingBalance: number) {
  const ledger: Array<{ key: string | null; cost: number }> = [];
  let balance = startingBalance;
  return {
    ledger,
    balanceNow: () => balance,
    debit(cost: number, key: string | null) {
      if (key !== null && ledger.some((row) => row.key === key)) {
        return { ok: true as const, newBalance: balance };
      }
      if (balance < cost) {
        return { ok: false as const, insufficient: true, message: "INSUFFICIENT_CREDITS" };
      }
      balance -= cost;
      ledger.push({ key, cost });
      return { ok: true as const, newBalance: balance };
    },
  };
}

function io(wallet: ReturnType<typeof fakeWallet>, key: string | null): PrecedenceIO {
  return {
    markPaid: () => Promise.resolve(),
    recordGrant: () => Promise.resolve(),
    // Free plan, no included grades — force the credits branch, which is the
    // one that spends money and the one the key protects.
    claimIncluded: () => Promise.resolve({ claimed: false, newUsed: 0 }),
    debitCredits: (cost) => Promise.resolve(wallet.debit(cost, key)),
    loadDiscount: () => Promise.resolve(null),
    discountedCents: (cents) => cents,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    user: {
      role: "user",
      grades_used_this_month: 0,
      grade_credit_balance: 10,
      included_grades_this_period: null,
    },
    tier: "standard" as const,
    rolledOver: false,
    liveCap: 0,
    effectivePlan: "free",
    pricing: {
      tierPriceCents: 299,
      tierCreditCost: 1,
      packs: [{ credits: 10, priceCents: 2490 }],
    },
    ...overrides,
  };
}

Deno.test("a retried batch debits ONCE per item, not once per attempt", async () => {
  const wallet = fakeWallet(10);
  const items = [ITEM_A, ITEM_B];
  const batchKey = "seller-clicked-once";

  // First attempt: both items charge.
  for (const item of items) {
    const key = bulkChargeKey(batchKey, item);
    const out = await performPaymentPrecedence(input(), io(wallet, key));
    assertEquals(out.paid, true);
  }
  assertEquals(wallet.ledger.length, 2);
  assertEquals(wallet.balanceNow(), 8);

  // The seller's connection dropped and they pressed Submit again. Same token,
  // so the same two keys — and nothing moves.
  for (const item of items) {
    const key = bulkChargeKey(batchKey, item);
    const out = await performPaymentPrecedence(input(), io(wallet, key));
    assertEquals(out.paid, true, "the replay must still report PAID");
  }
  assertEquals(
    wallet.ledger.length,
    2,
    "a retried batch must not append a second debit per item",
  );
  assertEquals(wallet.balanceNow(), 8);
});

Deno.test("WITHOUT a batch_key the same retry charges twice — the defect, pinned", async () => {
  // Kept deliberately. This is the pre-US-2564 behaviour, and it documents what
  // the token is buying: with a null key the fake wallet cannot dedupe, exactly
  // as debit_grade_credits cannot.
  const wallet = fakeWallet(10);
  for (let attempt = 0; attempt < 2; attempt++) {
    const key = bulkChargeKey(undefined, ITEM_A);
    assertEquals(key, null);
    await performPaymentPrecedence(input(), io(wallet, key));
  }
  assertEquals(wallet.ledger.length, 2);
  assertEquals(wallet.balanceNow(), 8);
});

Deno.test("a DIFFERENT batch of the same items still charges", async () => {
  // The token must not be so stable that a seller who genuinely re-grades an
  // item is refused. A new selection mints a new token, so the charge lands.
  const wallet = fakeWallet(10);
  await performPaymentPrecedence(input(), io(wallet, bulkChargeKey("batch-1", ITEM_A)));
  await performPaymentPrecedence(input(), io(wallet, bulkChargeKey("batch-2", ITEM_A)));
  assertEquals(wallet.ledger.length, 2);
});

Deno.test("the submit path passes the key — and passes null when none was sent", async () => {
  // US-9129: the charge moved to lib/grading-submit.ts and the request schema
  // stayed in the route, so this checks both halves where they now live. The
  // route also has to keep FORWARDING the parsed key: a schema that accepts
  // batch_key and a handler that drops it looks exactly like a working feature
  // and charges twice on every retry.
  const lib = await Deno.readTextFile(
    new URL("../lib/grading-submit.ts", import.meta.url),
  );
  const route = await Deno.readTextFile(
    new URL("../routes/flipdesk-grading.ts", import.meta.url),
  );
  assert(
    /runPaymentPrecedence\(\s*ownerId,\s*submissionId,\s*tier,\s*bulkChargeKey\(/.test(lib),
    "the bulk charge must pass bulkChargeKey(...) as runPaymentPrecedence's 4th " +
      "argument — without it the batch is keyless and a retry charges again",
  );
  assert(
    route.includes("batch_key: z.string()"),
    "submitBodySchema is .strict(), so batch_key must be declared or every " +
      "client sending it gets a 400",
  );
  assert(
    /submitItemsForGrading\([\s\S]{0,200}?parsed\.data\.batch_key/.test(route),
    "the route parses batch_key and must hand it to submitItemsForGrading; " +
      "dropping it there is invisible and re-charges every retried batch",
  );
});
