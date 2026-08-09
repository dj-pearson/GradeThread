// US-2345 AC1: the payment precedence sequence, driven for real.
//
// These replace four SOURCE SCANS that pinned the same properties by reading
// grade-billing.ts as text. The scans were the right thing while the sequence
// was inline and unreachable; now that it takes an IO seam, driving it is
// strictly better — a source scan proves a line exists, this proves the money
// moves the way the line claims.
//
// Every case below is a way to charge the wrong person or the wrong amount.

import "./_env.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  DebitFailedError,
  performPaymentPrecedence,
  type PrecedenceIO,
  type PrecedenceUser,
} from "../lib/grade-precedence.ts";

const USER: PrecedenceUser = {
  role: "user",
  grades_used_this_month: 0,
  grade_credit_balance: 0,
  included_grades_this_period: null,
};

const PRICING = {
  tierPriceCents: 299,
  tierCreditCost: 1,
  packs: [{ credits: 10, priceCents: 2499 }, { credits: 25, priceCents: 5999 }],
};

/** Records every side effect so a test can assert what did NOT happen too. */
function spy(over: Partial<PrecedenceIO> = {}) {
  const calls = {
    markPaid: [] as string[],
    grants: [] as string[],
    claims: [] as number[],
    debits: [] as number[],
    discountLookups: 0,
  };
  const io: PrecedenceIO = {
    markPaid: (status) => {
      calls.markPaid.push(status);
      return Promise.resolve();
    },
    recordGrant: (notes) => {
      calls.grants.push(notes);
      return Promise.resolve();
    },
    claimIncluded: (cap) => {
      calls.claims.push(cap);
      return Promise.resolve({ claimed: true, newUsed: 1 });
    },
    debitCredits: (cost) => {
      calls.debits.push(cost);
      return Promise.resolve({ ok: true as const, newBalance: 41 });
    },
    loadDiscount: () => {
      calls.discountLookups++;
      return Promise.resolve(null);
    },
    discountedCents: (cents, pct) => Math.round(cents * (100 - pct) / 100),
    ...over,
  };
  return { calls, io };
}

const run = (
  user: Partial<PrecedenceUser>,
  io: PrecedenceIO,
  over: {
    tier?: "standard" | "premium";
    liveCap?: number;
    rolledOver?: boolean;
  } = {},
) =>
  performPaymentPrecedence({
    user: { ...USER, ...user },
    tier: (over.tier ?? "standard") as "standard",
    rolledOver: over.rolledOver ?? false,
    liveCap: over.liveCap ?? 3,
    effectivePlan: "starter",
    pricing: PRICING,
  }, io);

// ── The order IS the pricing policy ────────────────────────────────────────

Deno.test("US-207: an included grade is taken before credits are touched", async () => {
  // Included grades are already bought. Reaching for credits first would charge
  // a seller twice for the same grade — and it would fail no branch test,
  // because the credits branch would still work perfectly.
  const s = spy();
  const out = await run({ grade_credit_balance: 99 }, s.io);
  assertEquals(out, { paid: true, method: "included", newIncludedUsed: 1 });
  assertEquals(s.calls.markPaid, ["included"]);
  assertEquals(
    s.calls.debits,
    [],
    "credits were debited despite an included grade being available",
  );
});

Deno.test("US-207: credits are taken before checkout", async () => {
  const s = spy({
    claimIncluded: () => Promise.resolve({ claimed: false, newUsed: 3 }),
  });
  const out = await run({ grade_credit_balance: 42 }, s.io);
  assertEquals(out, { paid: true, method: "credits", newBalance: 41 });
  assertEquals(s.calls.markPaid, ["credits"]);
  assertEquals(
    s.calls.discountLookups,
    0,
    "a checkout quote was built for a paid grade",
  );
});

Deno.test("US-207: with no allowance and no credits, checkout is required", async () => {
  const s = spy({
    claimIncluded: () => Promise.resolve({ claimed: false, newUsed: 3 }),
  });
  const out = await run({ grade_credit_balance: 0 }, s.io);
  assert(!out.paid && out.checkoutRequired);
  assertEquals(
    s.calls.markPaid,
    [],
    "a submission was marked paid without payment",
  );
  assertEquals(s.calls.debits, [], "a debit was attempted with a zero balance");
});

Deno.test("US-207: only STANDARD may draw on the included allowance", async () => {
  // Premium and Express always cost money. Letting them draw on the allowance
  // would sell a $12.99 grade for a $2.99 one.
  const s = spy();
  const out = await run({ grade_credit_balance: 0 }, s.io, { tier: "premium" });
  assert(!out.paid, "a premium grade consumed an included Standard grade");
  assertEquals(
    s.calls.claims,
    [],
    "the included claim was attempted for a premium tier",
  );
});

// ── The super-admin comp ───────────────────────────────────────────────────

Deno.test("US-207: super_admin grades free, uncapped, and still audited", async () => {
  const s = spy();
  const out = await run(
    {
      role: "super_admin",
      grades_used_this_month: 900,
      grade_credit_balance: 0,
    },
    s.io,
    { liveCap: 3 },
  );
  // Uncapped: 900 used against a cap of 3 and it still passes.
  assertEquals(out, { paid: true, method: "included", newIncludedUsed: 900 });
  assertEquals(s.calls.claims, [], "the comp consumed a claim slot");
  assertEquals(s.calls.debits, []);
  // Audited: a free grade is still a grade someone has to be able to account for.
  assertEquals(s.calls.grants.length, 1);
  assert(s.calls.grants[0].includes("super_admin"));
});

Deno.test("US-207: the comp reports the UNCHANGED counter", async () => {
  // Reporting an incremented value would make a free grade look like it ate one
  // of the seller's included allowance.
  const s = spy();
  const out = await run(
    { role: "super_admin", grades_used_this_month: 2 },
    s.io,
  );
  assert(out.paid && out.method === "included");
  assertEquals(out.newIncludedUsed, 2);
});

Deno.test("US-207: an ordinary admin pays like anyone else", async () => {
  // Scoped strictly to super_admin. `admin` and `reviewer` are staff roles, not
  // billing roles, and conflating them comps every operator's personal account.
  const s = spy({
    claimIncluded: () => Promise.resolve({ claimed: false, newUsed: 3 }),
  });
  const out = await run({ role: "admin", grade_credit_balance: 0 }, s.io);
  assert(!out.paid, "an ordinary admin was comped");
});

// ── The credit-race fall-through ───────────────────────────────────────────

Deno.test("US-207: INSUFFICIENT_CREDITS falls through to checkout", async () => {
  // The race: the balance read said there was enough, another debit landed
  // first. Falling through is correct here.
  const s = spy({
    claimIncluded: () => Promise.resolve({ claimed: false, newUsed: 3 }),
    debitCredits: () =>
      Promise.resolve({
        ok: false as const,
        insufficient: true,
        message: "INSUFFICIENT_CREDITS",
      }),
  });
  const out = await run({ grade_credit_balance: 5 }, s.io);
  assert(!out.paid && out.checkoutRequired);
  assertEquals(
    s.calls.markPaid,
    [],
    "the submission was marked paid on a failed debit",
  );
});

Deno.test("US-207: a BROKEN LEDGER throws instead of charging a card", async () => {
  // THE ONE THAT COSTS REAL MONEY. If any debit failure fell through, a database
  // blip would charge a card while the seller still held credits — they pay
  // twice, and it looks like an ordinary checkout to everyone including them.
  const s = spy({
    claimIncluded: () => Promise.resolve({ claimed: false, newUsed: 3 }),
    debitCredits: () =>
      Promise.resolve({
        ok: false as const,
        insufficient: false,
        message: "connection reset",
      }),
  });
  await assertRejects(
    () => run({ grade_credit_balance: 5 }, s.io),
    DebitFailedError,
    "connection reset",
  );
  assertEquals(s.calls.markPaid, []);
  assertEquals(
    s.calls.discountLookups,
    0,
    "it fell through to a checkout quote anyway",
  );
});

Deno.test("US-207: a balance below the cost never attempts a debit", async () => {
  const s = spy({
    claimIncluded: () => Promise.resolve({ claimed: false, newUsed: 3 }),
  });
  await run({ grade_credit_balance: 0 }, s.io);
  assertEquals(s.calls.debits, []);
});

Deno.test("US-2289: the RPC's balance wins over the local subtraction", async () => {
  // The local arithmetic is only a fallback for a driver that returned nothing.
  // Preferring it would report a stale balance whenever a concurrent grant
  // landed — and on an idempotent replay it would subtract a cost that was
  // never charged.
  const s = spy({
    claimIncluded: () => Promise.resolve({ claimed: false, newUsed: 3 }),
    debitCredits: () => Promise.resolve({ ok: true as const, newBalance: 7 }),
  });
  const out = await run({ grade_credit_balance: 100 }, s.io);
  assert(out.paid && out.method === "credits");
  assertEquals(out.newBalance, 7);
});

Deno.test("US-2289: a null balance from the driver falls back to the subtraction", async () => {
  const s = spy({
    claimIncluded: () => Promise.resolve({ claimed: false, newUsed: 3 }),
    debitCredits: () =>
      Promise.resolve({ ok: true as const, newBalance: null }),
  });
  const out = await run({ grade_credit_balance: 10 }, s.io);
  assert(out.paid && out.method === "credits");
  assertEquals(out.newBalance, 9);
});

// ── The checkout quote ─────────────────────────────────────────────────────

Deno.test("US-1853: a reward discount applies at checkout, with the list price beside it", async () => {
  const s = spy({
    claimIncluded: () => Promise.resolve({ claimed: false, newUsed: 3 }),
    loadDiscount: () =>
      Promise.resolve({ percentOff: 25, milestoneKey: "first_ten" }),
  });
  const out = await run({}, s.io);
  assert(!out.paid);
  assertEquals(out.tierPriceCents, 224); // 299 - 25%
  assertEquals(out.listPriceCents, 299);
  assertEquals(out.rewardDiscountPercent, 25);
  assertEquals(out.rewardMilestoneKey, "first_ten");
});

Deno.test("US-1853: no discount means no discount FIELDS, not zeroed ones", async () => {
  // A `rewardDiscountPercent: 0` would render as "0% off applied" on a quote.
  // Absent is the honest shape.
  const s = spy({
    claimIncluded: () => Promise.resolve({ claimed: false, newUsed: 3 }),
  });
  const out = await run({}, s.io);
  assert(!out.paid);
  assertEquals(out.tierPriceCents, 299);
  assertEquals(out.listPriceCents, undefined);
  assertEquals(out.rewardDiscountPercent, undefined);
});

Deno.test("US-1853: a discount NEVER reaches an included or credit grade", async () => {
  // It bites only on the money path. Included grades are already free, and
  // shaving the credit cost would make a discount worth LESS the more credits
  // someone holds — the opposite of a reward.
  const withDiscount = {
    loadDiscount: () => Promise.resolve({ percentOff: 50, milestoneKey: "m" }),
  };
  const included = spy(withDiscount);
  await run({}, included.io);
  assertEquals(included.calls.discountLookups, 0);

  const credits = spy({
    ...withDiscount,
    claimIncluded: () => Promise.resolve({ claimed: false, newUsed: 3 }),
  });
  await run({ grade_credit_balance: 9 }, credits.io);
  assertEquals(credits.calls.discountLookups, 0);
});

// ── The adapter in grade-billing.ts ────────────────────────────────────────
//
// The cases above drive the sequence. That proves nothing if the caller grew a
// second path around it, or if the adapter dropped the tenant scoping the
// sequence cannot enforce for it.

Deno.test("US-2345: runPaymentPrecedence goes through the shared sequence", () => {
  const src = Deno.readTextFileSync(
    new URL("../lib/grade-billing.ts", import.meta.url),
  ).replace(/\s+/g, " ");
  assert(
    src.includes("return await performPaymentPrecedence({"),
    "the charging chokepoint no longer goes through the tested sequence",
  );
  // Exactly one of each write. A second would be a payment path the branch
  // order above never runs.
  assertEquals(
    [...src.matchAll(/payment_status: status/g)].length,
    1,
    "more than one paid-flip in the adapter — one bypasses the precedence order",
  );
  assertEquals(
    [...src.matchAll(/debit_grade_credits/g)].length,
    1,
    "more than one credit debit in the adapter",
  );
});

Deno.test("US-1638/US-2033: the adapter scopes the paid-flip to the charged account", () => {
  // The sequence CANNOT enforce this — it says "mark paid" and the adapter picks
  // the rows. The failure is user A's credits being debited to mark user B's
  // submission paid, and the credits branch was missed once already by the pass
  // that added this scoping to the other two.
  const src = Deno.readTextFileSync(
    new URL("../lib/grade-billing.ts", import.meta.url),
  ).replace(/\s+/g, " ");
  const at = src.indexOf("markPaid: async (status)");
  assert(at > -1, "the markPaid adapter is gone");
  const body = src.slice(at, src.indexOf("recordGrant:", at));
  assert(
    body.includes('.eq("id", submissionId)') &&
      body.includes('.eq("user_id", userId)'),
    "the paid-flip is not scoped to BOTH the submission and the charged account, " +
      "so a submission id from the request could mark another tenant's row paid",
  );
});

Deno.test("US-398: the grant adapter records a NULL balance, never a snapshot", () => {
  // Snapshotting the balance was a non-atomic read that drifted whenever a
  // concurrent debit landed between read and insert. A balance that is sometimes
  // a stale guess is worse than one honestly absent — reconciliation trusts it.
  const src = Deno.readTextFileSync(
    new URL("../lib/grade-billing.ts", import.meta.url),
  ).replace(/\s+/g, " ");
  const at = src.indexOf("recordGrant: async (notes)");
  assert(at > -1, "the recordGrant adapter is gone");
  const body = src.slice(at, src.indexOf("claimIncluded:", at));
  assert(
    body.includes("balance_after: null"),
    "an included_grant row carries a balance again",
  );
});

// ── The per-period cap reaches the claim ───────────────────────────────────

Deno.test("US-885: the claim is offered the SNAPSHOT cap, not the live one", async () => {
  // Mid-period, the snapshot governs. Passing the live cap would let an admin's
  // edit retroactively bill grades a seller was told were included.
  const s = spy();
  await run({ included_grades_this_period: 3 }, s.io, { liveCap: 1 });
  assertEquals(s.calls.claims, [3]);
});

Deno.test("US-885: at the reset boundary the LIVE cap is offered instead", async () => {
  const s = spy();
  await run({ included_grades_this_period: 3 }, s.io, {
    liveCap: 10,
    rolledOver: true,
  });
  assertEquals(s.calls.claims, [10]);
});

Deno.test("US-885: a rolled-over user claims even when the stale counter is at the cap", async () => {
  const s = spy();
  const out = await run(
    { grades_used_this_month: 3, included_grades_this_period: 3 },
    s.io,
    { liveCap: 3, rolledOver: true },
  );
  assert(
    out.paid && out.method === "included",
    "a new month did not reset the allowance",
  );
});
