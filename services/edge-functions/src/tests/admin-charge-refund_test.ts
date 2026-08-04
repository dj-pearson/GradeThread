// US-2345 AC1: the admin manual-refund sequence and its failure branches.
//
// admin-billing.ts is ~1,750 lines with no direct tests, and this is the route
// where an admin sends real money back. Its pure decisions were already covered
// (normalizeRefundAmount, refundIdempotencyKey). What nothing exercised is the
// ORDER of the steps and what each failure does — because the handler drove
// Stripe and the audit log directly, so reaching a failure branch meant having
// a Stripe account that would fail on demand.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { performAdminChargeRefund, refundableCeiling } = await import(
  "../lib/admin-charge-refund.ts"
);
const { normalizeRefundAmount, refundIdempotencyKey } = await import(
  "../lib/refund-amount.ts"
);

function spyIO(over: Record<string, unknown> = {}) {
  const refunds: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const io = {
    retrieveCharge: () => Promise.resolve({ amount: 5000, amount_refunded: 0 }),
    createRefund: (args: Record<string, unknown>) => {
      refunds.push(args);
      return Promise.resolve({ id: "re_1", amount: (args.amount as number) ?? 5000 });
    },
    writeAudit: (d: Record<string, unknown>) => {
      audits.push(d);
      return Promise.resolve();
    },
    ...over,
    // deno-lint-ignore no-explicit-any
  } as any;
  return { io, refunds, audits };
}

const FULL = { ok: true as const, kind: "full" as const };

Deno.test("US-2345: a successful refund is recorded with STRIPE's numbers", async () => {
  // Not the requested ones. A partial Stripe clamped would otherwise be logged
  // at the amount we asked for, and the log is what reconciliation trusts.
  const { io, audits } = spyIO({
    createRefund: () => Promise.resolve({ id: "re_9", amount: 1234 }),
  });
  const r = await performAdminChargeRefund(
    "ch_1",
    { parsed: FULL, reason: "goodwill", adminId: "admin-1", idempotencyKey: "k" },
    io,
  );
  assertEquals(r, { ok: true, refundId: "re_9", amount: 1234 });
  assertEquals(audits.length, 1);
  assertEquals(audits[0]!.refund_id, "re_9");
  assertEquals(audits[0]!.amount, 1234, "the audit recorded the REQUESTED amount");
  assertEquals(audits[0]!.reason, "goodwill");
});

Deno.test("US-2345: a FAILED refund writes NO audit row", async () => {
  // The property that matters most. A record saying money moved when it did not
  // is worse than no record: the next operator reconciles Stripe against this
  // log and goes looking for a refund that never existed.
  const { io, audits } = spyIO({
    createRefund: () => Promise.reject(new Error("charge_already_refunded")),
  });
  const r = await performAdminChargeRefund(
    "ch_1",
    { parsed: FULL, reason: null, adminId: "admin-1", idempotencyKey: "k" },
    io,
  );
  assertEquals(r.ok, false);
  assert(!r.ok && r.status === 500);
  assert(!r.ok && r.message.includes("charge_already_refunded"), "the reason was lost");
  assertEquals(audits, [], "an audit row claims a refund that never happened");
});

Deno.test("US-2345: a FULL refund omits `amount` entirely", async () => {
  // US-2294's bug in its original form: `amount: 0` is falsy, so the field was
  // dropped and Stripe executed a FULL refund. "Refund everything" has to be an
  // intent, never something inferred from a value.
  const { io, refunds } = spyIO();
  await performAdminChargeRefund(
    "ch_1",
    { parsed: FULL, reason: null, adminId: "a", idempotencyKey: "k" },
    io,
  );
  assertEquals("amount" in refunds[0]!, false, "a full refund sent an amount field");
});

Deno.test("US-2345: a PARTIAL refund sends exactly the validated amount", async () => {
  const { io, refunds } = spyIO();
  await performAdminChargeRefund(
    "ch_1",
    {
      parsed: { ok: true, kind: "partial", amount: 250 },
      reason: null,
      adminId: "a",
      idempotencyKey: "k",
    },
    io,
  );
  assertEquals(refunds[0]!.amount, 250);
});

Deno.test("US-2345: the idempotency key reaches Stripe", async () => {
  // Without it a double-click is a second real refund. Derived from the same
  // validator result, which US-2294 found drifted once — producing a different
  // key for the same effect, so the guard was bypassed by the exact input that
  // caused the bug it guards.
  const { io, refunds } = spyIO();
  const key = refundIdempotencyKey("ch_7", FULL);
  await performAdminChargeRefund(
    "ch_7",
    { parsed: FULL, reason: null, adminId: "a", idempotencyKey: key },
    io,
  );
  assertEquals(refunds[0]!.idempotencyKey, key);
  assertEquals(key, "admin-refund:ch_7:full");
});

Deno.test("US-2345: the acting admin is stamped on the Stripe refund", async () => {
  // The only attribution that survives outside our database. If the audit row
  // is ever lost, this is what says who did it.
  const { io, refunds } = spyIO();
  await performAdminChargeRefund(
    "ch_1",
    { parsed: FULL, reason: "duplicate", adminId: "admin-42", idempotencyKey: "k" },
    io,
  );
  const md = refunds[0]!.metadata as Record<string, string>;
  assertEquals(md.admin_id, "admin-42");
  assertEquals(md.admin_reason, "duplicate");
});

Deno.test("US-2345: an unreadable charge yields NO refund attempt", async () => {
  // The ceiling comes from this read, so proceeding without it means refunding
  // an unbounded amount — which is the entire reason US-2294 added the read.
  const { io, refunds } = spyIO({
    retrieveCharge: () => Promise.reject(new Error("No such charge")),
  });
  const ceiling = await refundableCeiling("ch_missing", io);
  assertEquals(ceiling.ok, false);
  assert(!ceiling.ok && ceiling.message.includes("No such charge"));
  assertEquals(refunds, [], "a refund was attempted despite an unreadable charge");
});

Deno.test("US-2345: the ceiling is what is LEFT, not the original amount", async () => {
  // A charge already half refunded must not allow a second full refund.
  const { io } = spyIO({
    retrieveCharge: () => Promise.resolve({ amount: 5000, amount_refunded: 3000 }),
  });
  const ceiling = await refundableCeiling("ch_1", io);
  assert(ceiling.ok);
  assertEquals(ceiling.ok && ceiling.remainingCents, 2000);

  // And the validator refuses more than that, so the two compose.
  const over = normalizeRefundAmount(2500, 2000);
  assertEquals(over.ok, false);
  const within = normalizeRefundAmount(2000, 2000);
  assertEquals(within.ok, true);
});

Deno.test("US-2345: null charge totals do not become a refund of NaN", async () => {
  // Stripe types these as nullable. `null - null` is 0, not NaN, but only
  // because of the coalescing — worth pinning, since an unbounded or NaN
  // ceiling is how the validator stops protecting anything.
  const { io } = spyIO({
    retrieveCharge: () => Promise.resolve({ amount: null, amount_refunded: null }),
  });
  const ceiling = await refundableCeiling("ch_1", io);
  assert(ceiling.ok);
  assertEquals(ceiling.ok && ceiling.remainingCents, 0);
  // A zero ceiling refuses a full refund rather than silently allowing one.
  assertEquals(normalizeRefundAmount(undefined, 0).ok, false);
});

Deno.test("US-2345: the route still refunds through the shared sequence", () => {
  // The extraction must not have left a second, unguarded path behind.
  const src = Deno.readTextFileSync(
    new URL("../routes/admin-billing.ts", import.meta.url),
  );
  const at = src.indexOf('adminBillingRoutes.post("/charges/:id/refund"');
  assert(at > -1, "the admin refund route is gone or was renamed");
  const rest = src.slice(at);
  const handler = rest.slice(0, rest.indexOf("\nadminBillingRoutes."));
  assert(
    /performAdminChargeRefund\(/.test(handler),
    "the refund route no longer goes through the tested sequence",
  );
  assert(
    /refundableCeiling\(/.test(handler),
    "the refund route no longer bounds the amount by what is refundable",
  );
  // Stripe IS called from this handler — inside the io adapter, which is the
  // one correct place. The property is that it happens ONLY there, so no second
  // path can refund without going through the sequence above.
  //
  // The first version of this simply forbade `stripe.refunds.create(` in the
  // handler and failed on my own adapter. A guard that cannot tell the binding
  // from a bypass would have pushed the next person to delete it.
  const createCalls = [...handler.matchAll(/stripe\.refunds\.create\(/g)];
  assertEquals(
    createCalls.length,
    1,
    "there is more than one Stripe refund call in this handler — one of them " +
      "bypasses the sequence under test",
  );
  const adapterAt = handler.indexOf("createRefund: (");
  assert(adapterAt > -1, "the io adapter is gone");
  assert(
    createCalls[0]!.index! > adapterAt,
    "the Stripe refund call is outside the io adapter, so it is a second path " +
      "rather than the binding",
  );
});
