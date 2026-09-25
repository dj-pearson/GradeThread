// C1-C15 (consignment page pass): drive flipdeskConsignmentRoutes with a
// stubbed PostgREST layer and a stubbed Stripe client.
//
// The role-floor table is the point of this file. blockViewerWrites already
// keeps a viewer out of every write, and the viewer case in
// tenant-isolation_test.ts stays green even with the admin checks deleted, so
// nothing else would notice a member being able to raise a split to 100%,
// record a signature or start Stripe onboarding with their own bank details.
//
// The rest pins the money behaviour the same pass changed: integer cents,
// the overpay cap, the Stripe idempotency keys, and error bodies that never
// carry a raw Postgres or Stripe message.
//
//   deno test --allow-net --allow-env --allow-read src/tests/consignment-role-floor_test.ts

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";

const OWNER = "11111111-1111-4111-8111-111111111111";
const CONSIGNOR = "22222222-2222-4222-8222-222222222222";
const PAYOUT = "33333333-3333-4333-8333-333333333333";
const ITEM = "44444444-4444-4444-8444-444444444444";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface RestCall {
  method: string;
  url: string;
  body: unknown;
}
type RestHandler = (call: RestCall) => Response | undefined;

let restHandler: RestHandler = () => undefined;
let restCalls: RestCall[] = [];

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("/rest/v1/")) {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    let body: unknown = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch { /* not JSON */ }
    }
    const call = { method, url: decodeURIComponent(url), body };
    restCalls.push(call);
    return Promise.resolve(restHandler(call) ?? json([]));
  }
  if (url.startsWith("https://deno.land/") || url.startsWith("file:")) {
    return realFetch(input, init);
  }
  return Promise.resolve(json({ error: "stubbed" }, 500));
}) as typeof fetch;
addEventListener("unload", () => {
  globalThis.fetch = realFetch;
});

const { Hono } = await import("hono");
const {
  flipdeskConsignmentRoutes,
  CONSIGNOR_MONEY_ADMIN_ONLY,
  parseAmountCents,
  setConsignmentStripeForTests,
} = await import("../routes/flipdesk-consignment.ts");

type Role = "viewer" | "member" | "listing_manager" | "admin" | "owner";

function appAs(role: Role) {
  // deno-lint-ignore no-explicit-any
  const app = new Hono<any>();
  app.use("*", async (c, next) => {
    c.set("userId", OWNER);
    c.set("workspaceOwnerId", OWNER);
    c.set("workspaceRole", role);
    await next();
  });
  app.route("/", flipdeskConsignmentRoutes);
  return app;
}

async function call(role: Role, method: string, path: string, body?: unknown) {
  const res = await appAs(role).request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text);
  } catch { /* not JSON */ }
  return { status: res.status, body: parsed, text };
}

function reset(handler: RestHandler = () => undefined) {
  restHandler = handler;
  restCalls = [];
  setConsignmentStripeForTests(undefined);
}

// ── C1: role floor ──────────────────────────────────────────────

const MONEY_ROUTES: Array<[string, string, string, unknown]> = [
  ["POST /payouts", "POST", "/payouts", { consignor_id: CONSIGNOR, amount: 10 }],
  ["PATCH split", "PATCH", `/consignors/${CONSIGNOR}`, { default_split_pct: 100 }],
  ["PATCH status", "PATCH", `/consignors/${CONSIGNOR}`, { status: "archived" }],
  ["POST intake", "POST", `/consignors/${CONSIGNOR}/intake`, { signature_name: "x" }],
  ["POST connect", "POST", `/consignors/${CONSIGNOR}/connect`, {}],
  ["PATCH payout", "PATCH", `/payouts/${PAYOUT}`, { action: "mark_paid" }],
  ["POST items", "POST", `/consignors/${CONSIGNOR}/items`, { item_ids: [ITEM] }],
  ["POST consignor at 80%", "POST", "/consignors", { name: "Jane", default_split_pct: 80 }],
];

for (const role of ["member", "listing_manager"] as const) {
  Deno.test(`C1: a ${role} gets 403 on every consignor money route`, async () => {
    for (const [label, method, path, body] of MONEY_ROUTES) {
      reset();
      const r = await call(role, method, path, body);
      assertEquals(r.status, 403, `${role} ${label}`);
      assertEquals(r.body.error, CONSIGNOR_MONEY_ADMIN_ONLY, `${role} ${label}`);
      // The refusal happens before any read or write.
      assertEquals(restCalls.length, 0, `${role} ${label} touched the database`);
    }
  });
}

for (const role of ["admin", "owner"] as const) {
  Deno.test(`C1: an ${role} passes every consignor money floor`, async () => {
    for (const [label, method, path, body] of MONEY_ROUTES) {
      reset();
      const r = await call(role, method, path, body);
      assert(r.status !== 403, `${role} ${label} got 403`);
    }
  });
}

Deno.test("C1: a member may still edit a consignor's notes and contact details", async () => {
  reset();
  const r = await call("member", "PATCH", `/consignors/${CONSIGNOR}`, {
    notes: "prefers text",
    contact_phone: "555-0100",
  });
  assert(r.status !== 403, `member notes PATCH got ${r.status}`);
});

Deno.test("C1: a member may create a consignor at the default split", async () => {
  reset();
  const r = await call("member", "POST", "/consignors", { name: "Jane" });
  assert(r.status !== 403, `member create got ${r.status}`);
});

// ── C3: connect status ──────────────────────────────────────────

function consignorRow(extra: Record<string, unknown> = {}) {
  return {
    id: CONSIGNOR,
    user_id: OWNER,
    name: "Jane",
    default_split_pct: 60,
    contact_email: null,
    stripe_connect_account_id: null,
    payouts_enabled: false,
    intake_signed_at: null,
    ...extra,
  };
}

Deno.test("C3: a transfers-only account counts as enabled even with charges_enabled false", async () => {
  reset((c) => {
    if (c.method === "GET" && c.url.includes("/consignors?")) {
      return json([consignorRow({ stripe_connect_account_id: "acct_1" })]);
    }
    return undefined;
  });
  setConsignmentStripeForTests({
    accounts: {
      retrieve: (id: string) =>
        Promise.resolve({
          id,
          payouts_enabled: true,
          charges_enabled: false,
          details_submitted: true,
          capabilities: { transfers: "active" },
          requirements: { currently_due: [] },
        }),
    },
  });
  const r = await call("member", "GET", `/consignors/${CONSIGNOR}/connect/status`);
  assertEquals(r.status, 200);
  assertEquals(r.body.payouts_enabled, true);
  const write = restCalls.find((c) => c.method === "PATCH");
  assert(write, "payouts_enabled was not written");
  assertEquals(write.body, { payouts_enabled: true });
  assert(write.url.includes(`user_id=eq.${OWNER}`), "status write not tenant-scoped");
});

Deno.test("C3: a Stripe error on retrieve returns the safe body", async () => {
  reset((c) =>
    c.method === "GET" ? json([consignorRow({ stripe_connect_account_id: "acct_1" })]) : undefined
  );
  setConsignmentStripeForTests({
    accounts: { retrieve: () => Promise.reject(new Error("No such account: acct_1 (secret detail)")) },
  });
  const r = await call("owner", "GET", `/consignors/${CONSIGNOR}/connect/status`);
  assertEquals(r.status, 502);
  assert(!r.text.includes("secret detail"), "raw Stripe text leaked");
});

// ── C4: connect is idempotent ───────────────────────────────────

Deno.test("C4: connect sends an idempotency key and adopts an account a racing request stored", async () => {
  let reads = 0;
  reset((c) => {
    if (c.method === "GET" && c.url.includes("/consignors?")) {
      reads++;
      return json([
        consignorRow(reads > 1 ? { stripe_connect_account_id: "acct_stored" } : {}),
      ]);
    }
    if (c.method === "PATCH") return json([]); // lost the race: 0 rows
    return undefined;
  });
  const seen: { createOpts?: { idempotencyKey?: string }; linkAccount?: string } = {};
  setConsignmentStripeForTests({
    accounts: {
      create: (_p: unknown, opts: { idempotencyKey?: string }) => {
        seen.createOpts = opts;
        return Promise.resolve({ id: "acct_new" });
      },
    },
    accountLinks: {
      create: (p: { account: string }) => {
        seen.linkAccount = p.account;
        return Promise.resolve({ url: "https://connect.stripe.test/x" });
      },
    },
  });
  const r = await call("admin", "POST", `/consignors/${CONSIGNOR}/connect`, {});
  assertEquals(r.status, 200);
  assertEquals(seen.createOpts?.idempotencyKey, `consignor_connect_${CONSIGNOR}`);
  assertEquals(seen.linkAccount, "acct_stored");
  const write = restCalls.find((c) => c.method === "PATCH");
  assert(write?.url.includes("stripe_connect_account_id=is.null"), "write-back is not conditional");
});

Deno.test("C4: a Stripe throw on connect returns the safe copy, not the raw message", async () => {
  reset((c) => (c.method === "GET" ? json([consignorRow()]) : undefined));
  setConsignmentStripeForTests({
    accounts: { create: () => Promise.reject(new Error("raw stripe boom sk_live_x")) },
    accountLinks: { create: () => Promise.resolve({ url: "x" }) },
  });
  const r = await call("owner", "POST", `/consignors/${CONSIGNOR}/connect`, {});
  assertEquals(r.status, 502);
  assertEquals(r.body.error, "Couldn't start Stripe setup. Try again in a minute.");
  assert(!r.text.includes("raw stripe boom"));
});

// ── C5: payouts ─────────────────────────────────────────────────

Deno.test("C5: parseAmountCents takes dollars with at most two decimals", () => {
  assertEquals(parseAmountCents(10.005), null);
  assertEquals(parseAmountCents("10.005"), null);
  assertEquals(parseAmountCents(0), null);
  assertEquals(parseAmountCents("-1"), null);
  assertEquals(parseAmountCents(1_000_000.01), null);
  assertEquals(parseAmountCents(1_000_000), 100_000_000);
  assertEquals(parseAmountCents(0.29), 29);
  assertEquals(parseAmountCents("12.3"), 1230);
  assertEquals(parseAmountCents(NaN), null);
});

function payoutWorld(opts: {
  share?: number;
  paid?: number;
  pending?: number;
  connected?: boolean;
  insertError?: boolean;
} = {}): RestHandler {
  return (c) => {
    if (c.method === "GET" && c.url.includes("/consignors?")) {
      return json([
        consignorRow(
          opts.connected ? { stripe_connect_account_id: "acct_1", payouts_enabled: true } : {},
        ),
      ]);
    }
    if (c.method === "GET" && c.url.includes("/consignor_pnl?")) {
      return json([{
        consignor_share: opts.share ?? 100,
        payouts_paid: opts.paid ?? 0,
        payouts_pending: opts.pending ?? 0,
      }]);
    }
    if (c.method === "POST" && c.url.includes("/consignor_payouts")) {
      if (opts.insertError) {
        return json({ code: "23514", message: "new row violates check constraint secret_col" }, 400);
      }
      return json({ id: PAYOUT, ...(c.body as object) }, 201);
    }
    if (c.method === "PATCH" && c.url.includes("/consignor_payouts")) {
      return json({ id: PAYOUT, ...(c.body as object) });
    }
    return undefined;
  };
}

Deno.test("C5: 10.005 is rejected before anything is read", async () => {
  reset(payoutWorld());
  const r = await call("owner", "POST", "/payouts", { consignor_id: CONSIGNOR, amount: 10.005 });
  assertEquals(r.status, 400);
  assertEquals(restCalls.length, 0);
});

Deno.test("C5: an amount above what is owed after pending payouts is a 409", async () => {
  reset(payoutWorld({ share: 100, paid: 20, pending: 50 }));
  const r = await call("owner", "POST", "/payouts", { consignor_id: CONSIGNOR, amount: 30.01 });
  assertEquals(r.status, 409);
  assertEquals(r.body.available, 30);
  assert(!restCalls.some((c) => c.method === "POST"), "a payout row was inserted anyway");
});

Deno.test("C5: override pays above the cap only with a note", async () => {
  reset(payoutWorld({ share: 0 }));
  const noNote = await call("owner", "POST", "/payouts", {
    consignor_id: CONSIGNOR,
    amount: 5,
    override: true,
  });
  assertEquals(noNote.status, 400);
  reset(payoutWorld({ share: 0 }));
  const withNote = await call("owner", "POST", "/payouts", {
    consignor_id: CONSIGNOR,
    amount: 5,
    override: true,
    note: "advance agreed in person",
  });
  assertEquals(withNote.status, 200);
});

Deno.test("C5: an insert error returns the safe body, never the Postgres message", async () => {
  reset(payoutWorld({ insertError: true }));
  const r = await call("owner", "POST", "/payouts", { consignor_id: CONSIGNOR, amount: 5 });
  assertEquals(r.status, 500);
  assert(!r.text.includes("secret_col"), "Postgres text leaked");
  assert(!("detail" in r.body));
});

Deno.test("C5: a Stripe throw marks the row failed, scoped by user_id, and maps the copy", async () => {
  reset(payoutWorld({ connected: true }));
  const err = Object.assign(new Error("Insufficient funds in Stripe account acct_platform"), {
    code: "balance_insufficient",
  });
  setConsignmentStripeForTests({ transfers: { create: () => Promise.reject(err) } });
  const r = await call("owner", "POST", "/payouts", { consignor_id: CONSIGNOR, amount: 5 });
  assertEquals(r.status, 502);
  assertEquals(r.body.error, "Your Stripe balance can't cover this payout yet.");
  assert(!r.text.includes("acct_platform"));
  const failed = restCalls.find((c) =>
    c.method === "PATCH" && (c.body as { status?: string })?.status === "failed"
  );
  assert(failed, "row was not marked failed");
  assert(failed.url.includes(`user_id=eq.${OWNER}`), "failed write not tenant-scoped");
  // The seller reads this column in History, so it holds the safe copy, not
  // Stripe's own text (which names the platform account).
  assertEquals((failed.body as { error?: string }).error, "Your Stripe balance can't cover this payout yet.");
});

Deno.test("C5: a successful transfer uses integer cents and the payout idempotency key", async () => {
  reset(payoutWorld({ connected: true }));
  const seen: { params?: { amount: number }; opts?: { idempotencyKey?: string } } = {};
  setConsignmentStripeForTests({
    transfers: {
      create: (params: { amount: number }, opts: { idempotencyKey?: string }) => {
        seen.params = params;
        seen.opts = opts;
        return Promise.resolve({ id: "tr_1" });
      },
    },
  });
  const r = await call("owner", "POST", "/payouts", { consignor_id: CONSIGNOR, amount: 0.29 });
  assertEquals(r.status, 200);
  assertEquals(seen.params?.amount, 29);
  assert(Number.isInteger(seen.params?.amount));
  assertEquals(seen.opts?.idempotencyKey, `consignor_payout_${PAYOUT}`);
  const insert = restCalls.find((c) => c.method === "POST");
  assertEquals((insert?.body as { amount?: number }).amount, 0.29);
});

// ── C7: settle a manual payout ──────────────────────────────────

function payoutRowWorld(row: Record<string, unknown>): RestHandler {
  return (c) => {
    if (c.method === "GET" && c.url.includes("/consignor_payouts?")) {
      return json([{ id: PAYOUT, note: null, ...row }]);
    }
    if (c.method === "PATCH") return json([{ id: PAYOUT, ...(c.body as object) }]);
    return undefined;
  };
}

Deno.test("C7: a manual pending payout can be marked paid", async () => {
  reset(payoutRowWorld({ status: "pending", source: "manual" }));
  const r = await call("admin", "PATCH", `/payouts/${PAYOUT}`, {
    action: "mark_paid",
    method: "cash",
  });
  assertEquals(r.status, 200);
  const write = restCalls.find((c) => c.method === "PATCH");
  assertEquals((write?.body as { status?: string }).status, "paid");
  assert(write?.url.includes(`user_id=eq.${OWNER}`));
  assert(write?.url.includes("source=eq.manual"));
  assert(!write?.url.includes("or="), "US-1552: no .or() on a mutation");
});

Deno.test("C7: an auto payout cannot be settled by hand", async () => {
  reset(payoutRowWorld({ status: "pending", source: "auto" }));
  const r = await call("admin", "PATCH", `/payouts/${PAYOUT}`, { action: "cancel" });
  assertEquals(r.status, 409);
  assert(!restCalls.some((c) => c.method === "PATCH"));
});

function cancelWorld(accountId: string | null): RestHandler {
  return (c) => {
    if (c.method === "GET" && c.url.includes("/consignor_payouts?")) {
      return json([{
        id: PAYOUT,
        note: null,
        status: "pending",
        source: "manual",
        consignor_id: CONSIGNOR,
        created_at: "2026-09-20T00:00:00Z",
        stripe_transfer_id: null,
      }]);
    }
    if (c.method === "GET" && c.url.includes("/consignors?")) {
      return json([{ stripe_connect_account_id: accountId }]);
    }
    if (c.method === "PATCH") return json([{ id: PAYOUT, ...(c.body as object) }]);
    return undefined;
  };
}

Deno.test("C7: cancel on a payout Stripe already sent heals it to paid instead", async () => {
  reset(cancelWorld("acct_1"));
  setConsignmentStripeForTests({
    transfers: {
      list: () =>
        Promise.resolve({
          data: [{ id: "tr_sent", created: 1_790_000_000, metadata: { payout_id: PAYOUT } }],
          has_more: false,
        }),
    },
  });
  const r = await call("admin", "PATCH", `/payouts/${PAYOUT}`, { action: "cancel" });
  assertEquals(r.status, 409);
  const writes = restCalls.filter((c) => c.method === "PATCH");
  assertEquals(writes.length, 1);
  const body = writes[0]!.body as { status?: string; stripe_transfer_id?: string };
  assertEquals(body.status, "paid");
  assertEquals(body.stripe_transfer_id, "tr_sent");
});

Deno.test("C7: cancel is refused when Stripe cannot say whether the payout went out", async () => {
  reset(cancelWorld("acct_1"));
  setConsignmentStripeForTests({
    transfers: { list: () => Promise.reject(new Error("stripe down")) },
  });
  const r = await call("admin", "PATCH", `/payouts/${PAYOUT}`, { action: "cancel" });
  assertEquals(r.status, 503);
  assert(!restCalls.some((c) => c.method === "PATCH"), "canceled without Stripe's answer");
});

Deno.test("C7: cancel goes through when Stripe has no transfer for the payout", async () => {
  reset(cancelWorld("acct_1"));
  setConsignmentStripeForTests({
    transfers: { list: () => Promise.resolve({ data: [], has_more: false }) },
  });
  const r = await call("admin", "PATCH", `/payouts/${PAYOUT}`, { action: "cancel" });
  assertEquals(r.status, 200);
  const write = restCalls.find((c) => c.method === "PATCH");
  assertEquals((write?.body as { status?: string }).status, "canceled");
});

Deno.test("C7: a cash-only consignor's payout cancels without asking Stripe", async () => {
  reset(cancelWorld(null));
  const r = await call("admin", "PATCH", `/payouts/${PAYOUT}`, { action: "cancel" });
  assertEquals(r.status, 200);
});

Deno.test("C7: a foreign or missing payout id is a 404", async () => {
  reset();
  const r = await call("admin", "PATCH", `/payouts/${PAYOUT}`, { action: "cancel" });
  assertEquals(r.status, 404);
});

// ── C8: split changes and input checks ──────────────────────────

Deno.test("C8: changing the split on a signed consignor voids the signature", async () => {
  reset((c) => {
    if (c.method === "GET") {
      return json([consignorRow({ intake_signed_at: "2026-01-01T00:00:00Z" })]);
    }
    if (c.method === "PATCH") return json({ ...consignorRow(), ...(c.body as object) });
    return undefined;
  });
  const r = await call("admin", "PATCH", `/consignors/${CONSIGNOR}`, { default_split_pct: 40 });
  assertEquals(r.status, 200);
  assertEquals(r.body.resign_required, true);
  const write = restCalls.find((c) => c.method === "PATCH");
  const body = write?.body as Record<string, unknown>;
  assertEquals(body.intake_signed_at, null);
  assertEquals(body.intake_signature_name, null);
  assertEquals(body.intake_agreement_version, null);
});

Deno.test("C8: the same split leaves the signature alone", async () => {
  reset((c) => {
    if (c.method === "GET") {
      return json([consignorRow({ intake_signed_at: "2026-01-01T00:00:00Z" })]);
    }
    if (c.method === "PATCH") return json({ ...consignorRow(), ...(c.body as object) });
    return undefined;
  });
  const r = await call("admin", "PATCH", `/consignors/${CONSIGNOR}`, { default_split_pct: 60 });
  assertEquals(r.body.resign_required, false);
  const body = restCalls.find((c) => c.method === "PATCH")?.body as Record<string, unknown>;
  assert(!("intake_signed_at" in body));
});

Deno.test("C8: a split of 150 is a 400 on create and on update", async () => {
  reset((c) => (c.method === "GET" ? json([consignorRow()]) : undefined));
  const a = await call("owner", "POST", "/consignors", { name: "Jane", default_split_pct: 150 });
  assertEquals(a.status, 400);
  const b = await call("owner", "PATCH", `/consignors/${CONSIGNOR}`, { default_split_pct: 150 });
  assertEquals(b.status, 400);
  const d = await call("owner", "POST", "/consignors", { name: "Jane", default_split_pct: "abc" });
  assertEquals(d.status, 400);
});

Deno.test("C8: a duplicate name is a 409 naming it", async () => {
  reset((c) =>
    c.method === "POST"
      ? json({ code: "23505", message: "duplicate key value violates unique constraint" }, 409)
      : undefined
  );
  const r = await call("owner", "POST", "/consignors", { name: "Jane" });
  assertEquals(r.status, 409);
  assert(String(r.body.error).includes('"Jane"'));
});

Deno.test("C8: over-long and malformed contact fields are refused by name", async () => {
  reset();
  const long = await call("owner", "POST", "/consignors", { name: "x".repeat(121) });
  assertEquals(long.status, 400);
  assert(String(long.body.error).startsWith("name"));
  const email = await call("owner", "POST", "/consignors", { name: "Jane", contact_email: "nope" });
  assertEquals(email.status, 400);
  assert(String(email.body.error).startsWith("contact_email"));
});

// ── C10: list never reports a failed P&L read as $0 ─────────────

Deno.test("C10: a failed consignor_pnl read is reported as pnl_error", async () => {
  reset((c) => {
    if (c.url.includes("/consignor_pnl?")) return json({ message: "view broke" }, 500);
    if (c.url.includes("/consignors?")) return json([consignorRow()]);
    return undefined;
  });
  const r = await call("viewer", "GET", "/consignors");
  assertEquals(r.status, 200);
  assertEquals(r.body.pnl_error, true);
  assert(!r.text.includes("view broke"));
});

// ── C11: payout ledger paging ───────────────────────────────────

Deno.test("C11: GET /payouts validates consignor_id and pages at 200", async () => {
  reset();
  const bad = await call("viewer", "GET", "/payouts?consignor_id=not-a-uuid");
  assertEquals(bad.status, 400);
  assertEquals(restCalls.length, 0);
  const ok = await call("viewer", "GET", `/payouts?consignor_id=${CONSIGNOR}`);
  assertEquals(ok.status, 200);
  const q = restCalls[0].url;
  assert(q.includes("limit=200"), q);
  assert(q.includes(`user_id=eq.${OWNER}`), q);
});

// ── C15: attach items ───────────────────────────────────────────

Deno.test("C15: assigning items is tenant-scoped and only fills unassigned rows", async () => {
  reset((c) => {
    if (c.method === "GET") return json([consignorRow()]);
    if (c.method === "PATCH") return json([{ id: ITEM }]);
    return undefined;
  });
  const r = await call("admin", "POST", `/consignors/${CONSIGNOR}/items`, { item_ids: [ITEM] });
  assertEquals(r.status, 200);
  assertEquals(r.body.updated, 1);
  const write = restCalls.find((c) => c.method === "PATCH");
  assert(write?.url.includes("/inventory_items?"));
  assert(write?.url.includes(`user_id=eq.${OWNER}`));
  assert(write?.url.includes("consignor_id=is.null"));
  assertEquals((write?.body as Record<string, unknown>).consignment_split_pct, 60);
});

Deno.test("C15: assigning to a consignor the caller does not own is a 404 with no write", async () => {
  reset();
  const r = await call("admin", "POST", `/consignors/${CONSIGNOR}/items`, { item_ids: [ITEM] });
  assertEquals(r.status, 404);
  assert(!restCalls.some((c) => c.method === "PATCH"));
});

Deno.test("C15: the unassigned-items picker is tenant-scoped and strips filter syntax", async () => {
  reset();
  const r = await call("viewer", "GET", "/unassigned-items?q=" + encodeURIComponent("coat),user_id.eq.x"));
  assertEquals(r.status, 200);
  const q = restCalls[0].url;
  assert(q.includes(`user_id=eq.${OWNER}`), q);
  assert(q.includes("consignor_id=is.null"), q);
  assert(!q.includes("user_id.eq.x"), q);
});

// ── Review fixes ────────────────────────────────────────────────

Deno.test("C15: detaching never touches a sold item", async () => {
  reset((c) => {
    if (c.method === "GET") return json([consignorRow()]);
    if (c.method === "PATCH") return json([]);
    return undefined;
  });
  const r = await call("admin", "POST", `/consignors/${CONSIGNOR}/items`, {
    item_ids: [ITEM],
    unassign: true,
  });
  assertEquals(r.status, 200);
  const write = restCalls.find((c) => c.method === "PATCH");
  assert(write?.url.includes(`consignor_id=eq.${CONSIGNOR}`), write?.url);
  assert(write?.url.includes("status=not.in.(sold,shipped,completed)"), write?.url);
});

Deno.test("C11: a status-filtered ledger read is filtered and not cut at 200", async () => {
  reset();
  const ok = await call("viewer", "GET", "/payouts?status=pending,processing,failed");
  assertEquals(ok.status, 200);
  const q = restCalls[0].url;
  assert(q.includes("status=in.(pending,processing,failed)"), q);
  assert(q.includes("limit=2000"), q);
  assert(q.includes(`user_id=eq.${OWNER}`), q);
  reset();
  const bad = await call("viewer", "GET", "/payouts?status=pending,nope");
  assertEquals(bad.status, 400);
  assertEquals(restCalls.length, 0);
});

Deno.test("C8: a non-object PATCH body is a 400, not a crash", async () => {
  reset((c) => (c.method === "GET" ? json([consignorRow()]) : undefined));
  const r = await call("member", "PATCH", `/consignors/${CONSIGNOR}`, "status");
  assertEquals(r.status, 400);
});
