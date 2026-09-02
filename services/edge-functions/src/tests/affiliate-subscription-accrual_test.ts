// US-9212: one paid invoice, through the whole accrual, with the reads faked.
//
// This is a MONEY path (US-2345): it decides what a creator is owed, and every
// refusal in it is the difference between paying nobody and paying the wrong
// person. The reads and the write are injectable for exactly the reason
// fireTransfer's are -- driving them through the service-role client needs a
// database, and that is how this class of code went untested before.

import { assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);
// The payout config is part of the injected IO for the same reason the reads
// are: `mode` is what "shipped dark" means, and a test that could not set it
// could not prove the off state accrues nothing.

import type { SubscriptionAccrualIO } from "../lib/affiliate-payout.ts";

const { accrueSubscriptionCommission } = await import("../lib/affiliate-payout.ts");
const { DEFAULT_AFFILIATE_PAYOUT_CONFIG } = await import("../lib/affiliate-payout-math.ts");

const EVENT = { id: "ev_1", referrer_user_id: "creator_1", attribution_source: "affiliate" };

function io(
  over: Partial<SubscriptionAccrualIO> = {},
  sink: Record<string, unknown>[] = [],
  mode: "off" | "batched" = "batched",
) {
  const base: SubscriptionAccrualIO = {
    loadConfig: () => Promise.resolve({ ...DEFAULT_AFFILIATE_PAYOUT_CONFIG, mode }),
    loadReferralEvent: () => Promise.resolve(EVENT),
    loadProgram: () => Promise.resolve("creator"),
    loadPriorCommissions: () => Promise.resolve([]),
    insertCommission: (row) => {
      sink.push(row);
      return Promise.resolve(null);
    },
  };
  return { ...base, ...over };
}

const INVOICE = {
  referredUserId: "seller_1",
  invoiceId: "in_1",
  invoiceAmountCents: 5900,
  paidAt: "2026-03-15T00:00:00Z",
};

Deno.test("a creator earns the percentage, and the row says what earned it", async () => {
    const rows: Record<string, unknown>[] = [];
    const res = await accrueSubscriptionCommission({ ...INVOICE, io: io({}, rows) });
    assertEquals(res, { accrued: true, amount: 1475 }); // 25% of $59.00
    assertEquals(rows.length, 1);
    assertEquals(rows[0].affiliate_user_id, "creator_1");
    assertEquals(rows[0].referred_user_id, "seller_1");
    assertEquals(rows[0].stripe_invoice_id, "in_1");
    assertEquals(rows[0].commission_model, "subscription_pct");
    assertEquals(rows[0].status, "accrued");
    assertEquals(rows[0].amount, 1475);
});

Deno.test("nothing accrues without a referral, a creator, or an engine that is on", async () => {
  // No referral event: the payer arrived on their own.
  const none = await accrueSubscriptionCommission({
    ...INVOICE,
    io: io({ loadReferralEvent: () => Promise.resolve(null) }),
  });
  assertEquals(none, { accrued: false, reason: "not_referred" });

  // Referred, but by an ordinary seller sharing a link: credits, never cash.
  const user = await accrueSubscriptionCommission({
    ...INVOICE,
    io: io({ loadProgram: () => Promise.resolve("user") }),
  });
  assertEquals(user, { accrued: false, reason: "not_creator" });

  // Attributed to something other than the affiliate channel.
  const direct = await accrueSubscriptionCommission({
    ...INVOICE,
    io: io({
      loadReferralEvent: () => Promise.resolve({ ...EVENT, attribution_source: "direct" }),
    }),
  });
  assertEquals(direct, { accrued: false, reason: "not_affiliate" });

  // The engine off is the shipped state, and it must accrue nothing at all.
  const rows: Record<string, unknown>[] = [];
  const off = await accrueSubscriptionCommission({ ...INVOICE, io: io({}, rows, "off") });
  assertEquals(off, { accrued: false, reason: "disabled" });
  assertEquals(rows.length, 0, "a disabled engine must not write a row");
});

Deno.test("missing arguments are refused before any read", async () => {
  let read = false;
  const res = await accrueSubscriptionCommission({
    referredUserId: "",
    invoiceId: "in_x",
    invoiceAmountCents: 100,
    io: io({
      loadReferralEvent: () => {
        read = true;
        return Promise.resolve(EVENT);
      },
    }),
  });
  assertEquals(res, { accrued: false, reason: "missing_args" });
  assertEquals(read, false);
});

Deno.test("the window anchors on the FIRST commissioned invoice, not this one", async () => {
    // Earliest prior row is 14 months before this invoice, so a 12-month window
    // has closed even though the invoice itself was paid today.
    const closed = await accrueSubscriptionCommission({
      ...INVOICE,
      paidAt: "2027-06-01T00:00:00Z",
      io: io({
        loadPriorCommissions: () =>
          Promise.resolve([
            { amount: 500, created_at: "2026-03-15T00:00:00Z" },
            { amount: 500, created_at: "2026-09-15T00:00:00Z" },
          ]),
      }),
    });
    assertEquals(closed, { accrued: false, reason: "outside_window" });
});

Deno.test("the per-account cap truncates the last invoice and then pays nothing", async () => {
    // $248 of the $250 cap already earned: this invoice earns the $2 of room.
    const partial = await accrueSubscriptionCommission({
      ...INVOICE,
      io: io({
        loadPriorCommissions: () =>
          Promise.resolve([{ amount: 24_800, created_at: "2026-03-01T00:00:00Z" }]),
      }),
    });
    assertEquals(partial, { accrued: true, amount: 200 });

    const spent = await accrueSubscriptionCommission({
      ...INVOICE,
      io: io({
        loadPriorCommissions: () =>
          Promise.resolve([{ amount: 25_000, created_at: "2026-03-01T00:00:00Z" }]),
      }),
    });
    assertEquals(spent, { accrued: false, reason: "cap_reached" });
});

Deno.test("a redelivered invoice is a no-op, and a real write failure is reported", async () => {
    const dup = await accrueSubscriptionCommission({
      ...INVOICE,
      io: io({ insertCommission: () => Promise.resolve({ code: "23505" }) }),
    });
    assertEquals(dup, { accrued: false, reason: "already_accrued" });

    const failed = await accrueSubscriptionCommission({
      ...INVOICE,
      io: io({
        insertCommission: () => Promise.resolve({ code: "08006", message: "connection lost" }),
      }),
    });
    assertEquals(failed, { accrued: false, reason: "connection lost" });
});

Deno.test("a zero-amount invoice earns nothing", async () => {
    const res = await accrueSubscriptionCommission({
      ...INVOICE,
      invoiceAmountCents: 0,
      io: io(),
    });
    assertEquals(res, { accrued: false, reason: "zero_amount" });
});
