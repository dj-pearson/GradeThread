// US-2345 AC1: the admin credit-pack refund path — the branches where money is
// already gone.
//
// This is the second of admin-billing.ts's two money paths (the first,
// admin-charge-refund_test.ts, only moves Stripe money). This one ALSO claws
// credits back out of the user's wallet, so its failure branches have a shape
// the other one does not: a half-completed refund where the charge is reversed
// and the wallet is still full.
//
// The cases below are chosen for what they PREVENT, not for coverage:
//
//   • the ownership gate is a tenant boundary and the charge id is user input;
//   • the Stripe key is per CHARGE and the ledger key is per REFUND, and swapping
//     either one re-opens a bug that already shipped;
//   • a ledger failure must still audit, because that row is the only record
//     that money left without the wallet moving.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type PackCharge,
  type PackRefundIO,
  performPackRefund,
} from "../lib/admin-pack-refund.ts";

const USER = "user-1";
const ADMIN = "admin-9";
const CHARGE = "ch_test_1";

function charge(over: Partial<PackCharge> = {}): PackCharge {
  return {
    refunded: false,
    customer: "cus_1",
    payment_intent: "pi_1",
    metadata: { user_id: USER, product: "credit_pack", credits: "25" },
    ...over,
  };
}

interface Calls {
  refunds: Parameters<PackRefundIO["createRefund"]>[0][];
  revokes: Parameters<PackRefundIO["revokeCredits"]>[0][];
  intentLookups: string[];
}

function io(
  over: Partial<PackRefundIO> = {},
): { io: PackRefundIO; calls: Calls } {
  const calls: Calls = { refunds: [], revokes: [], intentLookups: [] };
  const base: PackRefundIO = {
    loadUser: () => Promise.resolve({ id: USER, stripe_customer_id: "cus_1" }),
    retrieveCharge: () => Promise.resolve(charge()),
    retrieveIntentMetadata: (id) => {
      calls.intentLookups.push(id);
      return Promise.resolve(null);
    },
    createRefund: (args) => {
      calls.refunds.push(args);
      return Promise.resolve({ id: "re_1", amount: 2500 });
    },
    revokeCredits: (args) => {
      calls.revokes.push(args);
      return Promise.resolve({
        ok: true as const,
        result: { revoked: 25, shortfall: 0, balance_after: 3 },
      });
    },
  };
  // Wrap the overrides so their calls are still recorded.
  const merged: PackRefundIO = { ...base, ...over };
  if (over.createRefund) {
    merged.createRefund = (args) => {
      calls.refunds.push(args);
      return over.createRefund!(args);
    };
  }
  if (over.revokeCredits) {
    merged.revokeCredits = (args) => {
      calls.revokes.push(args);
      return over.revokeCredits!(args);
    };
  }
  return { io: merged, calls };
}

const REQ = {
  targetUserId: USER,
  adminId: ADMIN,
  chargeId: CHARGE,
  reasonNote: "",
};

// ── The tenant boundary ──────────────────────────────────────────────────────

Deno.test("a charge belonging to ANOTHER user is refused and no refund is attempted", async () => {
  // Neither proof holds: the metadata names someone else and the Stripe customer
  // is not this user's. Both victims matter — the wrong charge would be reversed
  // AND the wrong wallet debited.
  const { io: deps, calls } = io({
    retrieveCharge: () =>
      Promise.resolve(
        charge({
          customer: "cus_other",
          metadata: {
            user_id: "user-2",
            product: "credit_pack",
            credits: "25",
          },
        }),
      ),
  });
  const out = await performPackRefund(REQ, deps);
  assert(!out.ok);
  assertEquals(out.status, 403);
  assertEquals(
    calls.refunds.length,
    0,
    "no money may move on a failed ownership check",
  );
  assertEquals(calls.revokes.length, 0);
});

Deno.test("the Stripe customer alone proves ownership when the metadata does not", async () => {
  // Older packs predate the user_id stamp. The customer match is the fallback,
  // and dropping it would make those charges permanently unrefundable.
  const { io: deps } = io({
    retrieveCharge: () =>
      Promise.resolve(
        charge({ metadata: { product: "credit_pack", credits: "25" } }),
      ),
  });
  const out = await performPackRefund(REQ, deps);
  assert(out.ok);
});

Deno.test("an EMPTY stripe_customer_id does not match a charge with no customer", async () => {
  // The trap in an ownership check written as `a === b`: two nullish values are
  // equal, so a user with no Stripe customer would own every customerless charge.
  const { io: deps, calls } = io({
    loadUser: () => Promise.resolve({ id: USER, stripe_customer_id: null }),
    retrieveCharge: () =>
      Promise.resolve(
        charge({
          customer: null,
          metadata: { product: "credit_pack", credits: "25" },
        }),
      ),
  });
  const out = await performPackRefund(REQ, deps);
  assert(!out.ok);
  assertEquals(out.status, 403);
  assertEquals(calls.refunds.length, 0);
});

// ── Nothing is refunded on an unreadable or ineligible charge ───────────────

Deno.test("a charge that could not be READ is not refunded", async () => {
  // The credit count comes out of that read. Proceeding means clawing back a
  // number nobody supplied.
  const { io: deps, calls } = io({
    retrieveCharge: () => Promise.reject(new Error("No such charge")),
  });
  const out = await performPackRefund(REQ, deps);
  assert(!out.ok);
  assertEquals(out.status, 404);
  assertStringIncludes(out.message, "No such charge");
  assertEquals(calls.refunds.length, 0);
});

Deno.test("an already-refunded charge is refused rather than refunded twice", async () => {
  const { io: deps, calls } = io({
    retrieveCharge: () => Promise.resolve(charge({ refunded: true })),
  });
  const out = await performPackRefund(REQ, deps);
  assert(!out.ok);
  assertEquals(out.status, 409);
  assertEquals(calls.refunds.length, 0);
});

Deno.test("a non-pack charge is refused — this path revokes credits it never granted", async () => {
  const { io: deps, calls } = io({
    retrieveCharge: () =>
      Promise.resolve(
        charge({
          metadata: { user_id: USER, product: "grade", credits: "25" },
        }),
      ),
  });
  const out = await performPackRefund(REQ, deps);
  assert(!out.ok);
  assertEquals(out.status, 422);
  assertEquals(calls.refunds.length, 0);
});

Deno.test("a pack charge with an unparseable credit count is refused, not treated as zero", async () => {
  // NaN credits reaching revoke_grade_credits is a write with no defined effect.
  // Refusing keeps the money with us, where a human can still fix it.
  for (const credits of ["", "abc", "0", "-5"]) {
    const { io: deps, calls } = io({
      retrieveCharge: () =>
        Promise.resolve(
          charge({
            metadata: { user_id: USER, product: "credit_pack", credits },
          }),
        ),
    });
    const out = await performPackRefund(REQ, deps);
    assert(!out.ok, `credits=${JSON.stringify(credits)} should be refused`);
    assertEquals(out.status, 422);
    assertEquals(calls.refunds.length, 0);
  }
});

// ── US-1414: Checkout stamps the PaymentIntent, not the charge ──────────────

Deno.test("metadata is read through to the PaymentIntent for a Checkout charge", async () => {
  // Without the reach-through every Checkout-originated pack refund 403s or
  // 422s, because user_id/product/credits all read as undefined on the charge.
  const { io: deps, calls } = io({
    retrieveCharge: () =>
      Promise.resolve(charge({ customer: "cus_other", metadata: {} })),
    retrieveIntentMetadata: (id) => {
      calls.intentLookups.push(id);
      return Promise.resolve({
        user_id: USER,
        product: "credit_pack",
        credits: "50",
      });
    },
  });
  const out = await performPackRefund(REQ, deps);
  assert(out.ok);
  assertEquals(out.credits, 50);
  assertEquals(calls.revokes[0].credits, 50);
});

Deno.test("a FAILED intent lookup refuses the refund instead of guessing", async () => {
  // retrieveIntentMetadata returns null on failure, which must not be read as
  // "this charge has no owner and therefore isn't refundable-by-metadata" in a
  // way that lets the call proceed on some other footing. With no customer match
  // either, the only safe answer is 403.
  const { io: deps, calls } = io({
    retrieveCharge: () =>
      Promise.resolve(charge({ customer: "cus_other", metadata: {} })),
    retrieveIntentMetadata: () => Promise.resolve(null),
  });
  const out = await performPackRefund(REQ, deps);
  assert(!out.ok);
  assertEquals(out.status, 403);
  assertEquals(calls.refunds.length, 0);
});

// ── The two idempotency keys, which are keyed on different things ───────────

Deno.test("the Stripe key is per CHARGE and the ledger key is per REFUND", async () => {
  const { io: deps, calls } = io();
  const out = await performPackRefund(REQ, deps);
  assert(out.ok);
  // Per charge: a retried handler gets the SAME refund object back rather than
  // issuing a second one. Anything varying between attempts breaks that.
  assertEquals(calls.refunds[0].idempotencyKey, `pack-refund:${CHARGE}`);
  // Per REFUND (US-2033). Keyed per charge, a second partial refund on the same
  // charge found the key already claimed and skipped its ledger write — the
  // wallet kept credits the customer had been paid back for.
  assertEquals(calls.revokes[0].idempotencyKey, "pack-refund:re_1");
});

Deno.test("the refund carries the admin id and the pack product for attribution", async () => {
  // The Stripe object is the only record that survives outside our database.
  const { io: deps, calls } = io();
  await performPackRefund({ ...REQ, reasonNote: "duplicate purchase" }, deps);
  assertEquals(calls.refunds[0].metadata.admin_id, ADMIN);
  assertEquals(calls.refunds[0].metadata.product, "credit_pack");
  assertEquals(calls.refunds[0].metadata.admin_reason, "duplicate purchase");
});

Deno.test("an empty reason note is OMITTED rather than sent as an empty string", async () => {
  const { io: deps, calls } = io();
  await performPackRefund(REQ, deps);
  assert(!("admin_reason" in calls.refunds[0].metadata));
});

// ── The half-completed refund ───────────────────────────────────────────────

Deno.test("a failed ledger reversal reports the refund id and the money that moved", async () => {
  // The worst outcome this path has: Stripe refunded, wallet untouched. The
  // caller needs the refund id and the error to write the audit row that is the
  // only record a reconciliation is owed.
  const { io: deps } = io({
    revokeCredits: () =>
      Promise.resolve({ ok: false as const, message: "deadlock detected" }),
  });
  const out = await performPackRefund(REQ, deps);
  assert(!out.ok);
  assertEquals(out.stage, "ledger");
  assert(out.stage === "ledger");
  assertEquals(out.refundId, "re_1");
  assertEquals(out.credits, 25);
  assertStringIncludes(out.ledgerError, "deadlock");
  assertStringIncludes(out.message, "reconcile manually");
});

Deno.test("a ledger error is capped so one runaway message cannot bloat the audit row", async () => {
  const { io: deps } = io({
    revokeCredits: () =>
      Promise.resolve({ ok: false as const, message: "x".repeat(5000) }),
  });
  const out = await performPackRefund(REQ, deps);
  assert(!out.ok && out.stage === "ledger");
  assertEquals(out.ledgerError.length, 500);
});

Deno.test("a Stripe refund that THREW does not reach the ledger", async () => {
  // No money moved, so no credits may be revoked. Revoking here would leave the
  // user short with nothing refunded — the inverse of the ledger-failure case
  // and strictly worse, because the loss falls on the customer.
  const { io: deps, calls } = io({
    createRefund: () => Promise.reject(new Error("card_declined")),
  });
  const out = await performPackRefund(REQ, deps);
  assert(!out.ok);
  assertEquals(out.stage, "refund");
  assertEquals(out.status, 500);
  assertEquals(calls.revokes.length, 0);
});

Deno.test("a NON-Error rejection from Stripe still reports something actionable", async () => {
  // Stripe's SDK can reject with a plain object. Without the fallback the
  // operator sees an empty reason, which reads as our bug rather than a decline.
  const notAnError: unknown = { code: "charge_already_refunded" };
  const { io: deps } = io({
    createRefund: () => Promise.reject(notAnError),
  });
  const out = await performPackRefund(REQ, deps);
  assert(!out.ok && out.stage === "refund");
  assert(out.message.length > 0);
});

// ── The success shape ───────────────────────────────────────────────────────

Deno.test("credits reports the pack SIZE, separately from what the wallet could give back", async () => {
  // A shortfall means the user already spent some of the pack. Collapsing the
  // two numbers would hide precisely the case an operator is looking for.
  const { io: deps } = io({
    revokeCredits: () =>
      Promise.resolve({
        ok: true as const,
        result: { revoked: 10, shortfall: 15, balance_after: 0 },
      }),
  });
  const out = await performPackRefund(REQ, deps);
  assert(out.ok);
  assertEquals(out.credits, 25, "the pack sold 25");
  assertEquals(out.result.revoked, 10, "only 10 were left to take back");
  assertEquals(out.result.shortfall, 15);
});

Deno.test("the ledger reversal is scoped to the target user and the charge's intent", async () => {
  const { io: deps, calls } = io();
  await performPackRefund(REQ, deps);
  assertEquals(calls.revokes[0].userId, USER);
  assertEquals(calls.revokes[0].paymentIntentId, "pi_1");
  assertStringIncludes(calls.revokes[0].notes, CHARGE);
  assertStringIncludes(calls.revokes[0].notes, ADMIN);
  assertStringIncludes(calls.revokes[0].notes, "re_1");
});

Deno.test("an unreadable user row stops the call before Stripe is touched", async () => {
  const { io: deps, calls } = io({ loadUser: () => Promise.resolve(null) });
  const out = await performPackRefund(REQ, deps);
  assert(!out.ok);
  assertEquals(out.status, 404);
  assertEquals(calls.refunds.length, 0);
});

// ── The route still goes through the sequence above ────────────────────────
//
// The tests above drive the lib. That proves nothing if the route grew a second
// path around it, so this reads admin-billing.ts as text — the same shape as the
// guard in admin-charge-refund_test.ts, for the same reason.

Deno.test("US-2345: the pack-refund route still refunds through the shared sequence", () => {
  const src = Deno.readTextFileSync(
    new URL("../routes/admin-billing.ts", import.meta.url),
  );
  const at = src.indexOf(
    'adminBillingRoutes.post("/billing/users/:id/refund-pack"',
  );
  assert(at > -1, "the pack refund route is gone or was renamed");
  const rest = src.slice(at);
  const handler = rest.slice(0, rest.indexOf("\nadminBillingRoutes."));

  assert(
    /performPackRefund\(/.test(handler),
    "the pack refund route no longer goes through the tested sequence",
  );

  // Stripe and the ledger RPC ARE reached from this handler — inside the io
  // adapter, which is the one correct place. The property is EXACTLY ONE of
  // each: a second call is a path that refunds or revokes without the ownership
  // gate above ever running.
  assertEquals(
    [...handler.matchAll(/stripe\.refunds\.create\(/g)].length,
    1,
    "more than one Stripe refund call in this handler — one bypasses the gate",
  );
  assertEquals(
    [...handler.matchAll(/revoke_grade_credits/g)].length,
    1,
    "more than one ledger reversal in this handler — one bypasses the gate",
  );

  // THE AUDIT ROW ON THE LEDGER FAILURE. This is the half-completed refund: the
  // money left and the wallet is still full, and this row is the only record
  // that a reconciliation is owed. Losing it makes the gap invisible.
  const ledgerBranch = handler.slice(
    handler.indexOf('outcome.stage === "ledger"'),
  );
  assert(
    ledgerBranch.length > 0 && /auditLog\(/.test(ledgerBranch.slice(0, 900)),
    "the ledger-failure branch no longer writes an audit row",
  );
  assert(
    /ledger_error/.test(ledgerBranch.slice(0, 900)),
    "the ledger-failure audit row no longer carries the error",
  );

  // ...AND THAT ERROR GOES NOWHERE ELSE. `ledgerError` is the RPC's own text,
  // the single raw DB message anywhere on this path. It belongs in the audit row
  // and the console; putting it in the response body is the US-1445 leak, and
  // the two `safe-raw-error` markers on this handler assert it never happens.
  // no-raw-db-error_test.ts cannot see that on its own — it matches a shape, and
  // an annotated line is a line it stops looking at.
  const bodies = [...handler.matchAll(/return c\.json\([^;]*;/g)].map((m) => m[0]);
  assert(bodies.length > 0, "the handler stopped responding with c.json");
  assert(
    !bodies.some((b) => /ledgerError/.test(b)),
    "the raw ledger error is being returned to the client (US-1445)",
  );
});
