// US-1916: the consignor payout engine must not double-pay. Stripe idempotency
// keys only dedupe for ~24h, so a transfer that settled on Stripe but whose DB
// write-back failed is retried by sweepConsignorPayouts after the key TTL and
// would create a SECOND transfer. findExistingTransfer is the pre-fire guard:
// it asks Stripe whether a transfer for this payout already exists (matched on
// metadata.payout_id) so fireTransfer reconciles the row instead of re-firing.
// consignor-payout.ts inits the service-role supabase client at module load, so
// set dummy env BEFORE the dynamic import.
import { assert, assertEquals } from "@std/assert";
import type Stripe from "stripe";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { findExistingTransfer } = await import("../lib/consignor-payout.ts");

// Minimal fake Stripe whose transfers.list returns scripted pages and records
// the params it was called with (to assert the time-bound).
function fakeStripe(
  pages: Array<{ data: Array<Partial<Stripe.Transfer>>; has_more?: boolean }>,
  opts: { throwOnCall?: boolean; calls?: unknown[] } = {},
) {
  let i = 0;
  return {
    transfers: {
      list: (params: unknown) => {
        opts.calls?.push(params);
        if (opts.throwOnCall) return Promise.reject(new Error("stripe down"));
        const page = pages[Math.min(i, pages.length - 1)];
        i++;
        return Promise.resolve(page);
      },
    },
  } as unknown as Stripe;
}

const T = (id: string, payoutId: string): Partial<Stripe.Transfer> => ({
  id,
  metadata: { payout_id: payoutId },
});

Deno.test("(a) settled-on-Stripe: a matching transfer is found → reconcile, no re-fire", async () => {
  const stripe = fakeStripe([{ data: [T("tr_1", "PAY-1")], has_more: false }]);
  const res = await findExistingTransfer(stripe, "acct_1", "PAY-1", Date.now());
  assertEquals(res.error, undefined);
  assertEquals(res.transfer?.id, "tr_1");
});

Deno.test("(b) genuinely unpaid: no matching transfer → null (caller fires once)", async () => {
  const stripe = fakeStripe([{ data: [T("tr_x", "OTHER")], has_more: false }]);
  const res = await findExistingTransfer(stripe, "acct_1", "PAY-1", Date.now());
  assertEquals(res.error, undefined);
  assertEquals(res.transfer, null);
});

Deno.test("Stripe list failure → error (caller declines to re-fire)", async () => {
  const stripe = fakeStripe([], { throwOnCall: true });
  const res = await findExistingTransfer(stripe, "acct_1", "PAY-1", Date.now());
  assertEquals(res.transfer, null);
  assert(typeof res.error === "string" && res.error.length > 0);
});

Deno.test("walks bounded pages: match on the second page", async () => {
  const stripe = fakeStripe([
    { data: [T("tr_a", "OTHER"), T("tr_b", "OTHER2")], has_more: true },
    { data: [T("tr_match", "PAY-1")], has_more: false },
  ]);
  const res = await findExistingTransfer(stripe, "acct_1", "PAY-1", Date.now());
  assertEquals(res.transfer?.id, "tr_match");
});

Deno.test("time-bounds the scan when created_at is known; unbounded when NaN", async () => {
  const calls: unknown[] = [];
  const now = Date.now();
  await findExistingTransfer(
    fakeStripe([{ data: [], has_more: false }], { calls }),
    "acct_1",
    "PAY-1",
    now,
  );
  const p0 = calls[0] as { created?: { gte: number } };
  assert(p0.created?.gte !== undefined, "expected a created.gte bound");
  // gte ≈ (now - 5min) in seconds
  assertEquals(p0.created!.gte, Math.floor((now - 5 * 60 * 1000) / 1000));

  const calls2: unknown[] = [];
  await findExistingTransfer(
    fakeStripe([{ data: [], has_more: false }], { calls: calls2 }),
    "acct_1",
    "PAY-1",
    Number.NaN,
  );
  const p1 = calls2[0] as { created?: unknown };
  assertEquals(p1.created, undefined);
});
