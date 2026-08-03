// US-2345 AC1: the affiliate payout's money-moving step, both branches.
//
// `fireTransfer` is where the money actually leaves — a Stripe transfer, then a
// write recording what happened. Its FAILURE branch carries the property the
// whole two-phase design rests on: a failed transfer must mark the PAYOUT failed
// and leave the commissions attached to it, so the sweep retries the same
// idempotency key. Releasing them would risk paying twice for a transfer that
// actually went through on a network blip.
//
// None of that was tested, because the writes went straight to the service-role
// client and driving them needed a database. They are injectable now; the live
// path is unchanged (the default IO is byte-for-byte what the function did).

import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { fireTransfer } = await import("../lib/affiliate-payout.ts");

type Call = { name: string; args: Record<string, unknown> };

function recorder() {
  const calls: Call[] = [];
  return {
    calls,
    io: {
      markPaid(args: Record<string, unknown>) {
        calls.push({ name: "markPaid", args });
        return Promise.resolve();
      },
      markFailed(args: Record<string, unknown>) {
        calls.push({ name: "markFailed", args });
        return Promise.resolve();
      },
    },
  };
}

// A Stripe double narrow enough to be honest about what is exercised: only
// transfers.create is reached.
// deno-lint-ignore no-explicit-any
const stripeThat = (impl: (params: any, opts: any) => unknown) =>
  ({ transfers: { create: impl } }) as never;

const BASE = {
  payoutId: "po_1",
  affiliateUserId: "aff_1",
  amount: 2500,
  accountId: "acct_1",
};

Deno.test("a successful transfer records the transfer id and the amount", async () => {
  const r = recorder();
  const res = await fireTransfer({
    ...BASE,
    stripe: stripeThat(() => Promise.resolve({ id: "tr_123" })),
    io: r.io,
  });
  assertEquals(res.outcome, "transferred");
  assertEquals(res.amount, 2500);
  assertEquals(r.calls.length, 1);
  assertEquals(r.calls[0]?.name, "markPaid");
  assertEquals(r.calls[0]?.args.transferId, "tr_123");
  assertEquals(r.calls[0]?.args.amount, 2500);
});

Deno.test("a FAILED transfer marks the payout failed and never releases", async () => {
  // The property the two-phase record depends on. If this branch ever released
  // the commissions instead, a transfer that succeeded but timed out on the way
  // back would be paid a second time by the next sweep.
  const r = recorder();
  const res = await fireTransfer({
    ...BASE,
    stripe: stripeThat(() => Promise.reject(new Error("card_declined"))),
    io: r.io,
  });
  assertEquals(res.outcome, "failed");
  assertEquals(res.reason, "card_declined");
  assertEquals(r.calls.length, 1);
  assertEquals(r.calls[0]?.name, "markFailed");
  assertEquals(r.calls[0]?.args.message, "card_declined");
  // And nothing was marked paid on the way past.
  assert(!r.calls.some((c) => c.name === "markPaid"));
});

Deno.test("a non-Error rejection still produces a recorded reason", async () => {
  // Stripe's SDK can reject with a plain object. An unhandled `undefined`
  // message would store null in `error` and the operator sees a failed payout
  // with no reason — which reads as a bug in our code rather than a decline.
  const r = recorder();
  const res = await fireTransfer({
    ...BASE,
    stripe: stripeThat(() => Promise.reject({ code: "rate_limit" })),
    io: r.io,
  });
  assertEquals(res.outcome, "failed");
  assertEquals(res.reason, "Transfer failed");
  assertEquals(r.calls[0]?.args.message, "Transfer failed");
});

Deno.test("the idempotency key is derived from the payout id alone", async () => {
  // The retry path re-fires with the SAME key, which is what makes a retry safe.
  // Keying on anything that varies between attempts — a timestamp, an attempt
  // counter — would turn every retry into a second real transfer.
  let seenKey: string | undefined;
  const r = recorder();
  await fireTransfer({
    ...BASE,
    stripe: stripeThat((_params, opts) => {
      seenKey = (opts as { idempotencyKey?: string }).idempotencyKey;
      return Promise.resolve({ id: "tr_1" });
    }),
    io: r.io,
  });
  assertEquals(seenKey, "affiliate_payout_po_1");
});

Deno.test("the transfer is sent in whole cents to the connected account", async () => {
  // `amount` is integer cents by contract (US-1655), but Math.round is the last
  // line of defence: Stripe rejects a fractional amount outright, which would
  // turn a rounding slip anywhere upstream into a hard payout failure.
  // deno-lint-ignore no-explicit-any
  let params: any;
  const r = recorder();
  await fireTransfer({
    ...BASE,
    amount: 1234.6,
    stripe: stripeThat((p) => {
      params = p;
      return Promise.resolve({ id: "tr_1" });
    }),
    io: r.io,
  });
  assertEquals(params.amount, 1235);
  assertEquals(params.currency, "usd");
  assertEquals(params.destination, "acct_1");
  // The metadata is what an operator reconciles a Stripe transfer back to.
  assertEquals(params.metadata.payout_id, "po_1");
  assertEquals(params.metadata.affiliate_user_id, "aff_1");
});

Deno.test("both writes are scoped by affiliate as well as payout id", () => {
  // Source-level, because the default IO is the thing that talks to the
  // database. The second predicate is not redundant: without it a mis-derived
  // payout id could mark ANOTHER affiliate's payout as paid.
  const src = Deno.readTextFileSync(
    new URL("../lib/affiliate-payout.ts", import.meta.url),
  );
  const io = src.slice(
    src.indexOf("const defaultTransferIO"),
    src.indexOf("export async function fireTransfer"),
  );
  const scoped = io.match(/\.eq\("affiliate_user_id", affiliateUserId\)/g) ?? [];
  assertEquals(scoped.length, 2, "both writes must be affiliate-scoped");
  assertEquals((io.match(/\.eq\("id", payoutId\)/g) ?? []).length, 2);
});
