// money.md action 5, PROVEN BY DRIVING THE ROUTE: a signed Stripe event goes
// through POST /stripe and the real handler, supabase-js query builder and
// guard. Only the wire is fake: a small PostgREST stand-in keeps the user row
// and the flipdesk_subscription_events audit rows in memory and applies the
// watermark query's own filters, so a guard that stops scoping on the
// subscription id (or stops reading event_created) changes what it gets back.
// Stripe's lookup of the stored subscription goes through the
// subscriptionGuardDeps seam, since the SDK does not use this fetch.
//
// The decision table itself is pinned in subscription-event-guard_test.ts.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { resetSupabaseAdminForTests } from "../lib/supabase.ts";
import { subscriptionGuardDeps, webhookRoutes } from "../routes/webhooks.ts";

const USER = "33333333-3333-4333-8333-333333333333";
const CUSTOMER = "cus_order_test";
const TEST_SECRET = "whsec_order_test_secret";
const T = 1_790_000_000;

type Row = Record<string, unknown>;

let user: Row = {};
let audit: Row[] = [];
let userPatches: Row[] = [];
let storedStatus: Record<string, string> = {};
let retrieveCalls: string[] = [];

function reset(fields: Row) {
  user = {
    id: USER,
    email: null,
    full_name: null,
    stripe_customer_id: CUSTOMER,
    flipdesk_plan: "free",
    flipdesk_subscription_id: null,
    subscription_status: "none",
    trial_ends_at: "2026-01-01T00:00:00Z",
    flipdesk_cancel_at_period_end: false,
    pending_flipdesk_plan: null,
    pending_flipdesk_interval: null,
    pending_schedule_id: null,
    pending_effective_at: null,
    flipdesk_pause_until: null,
    past_due_since: null,
    buyer_plan: "free",
    buyer_subscription_id: null,
    buyer_subscription_status: null,
    buyer_cancel_at_period_end: false,
    buyer_past_due_since: null,
    ...fields,
  };
  audit = [];
  userPatches = [];
  storedStatus = {};
  retrieveCalls = [];
}

function json(body: unknown, status = 200): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function eqParam(url: URL, key: string): string | null {
  const raw = url.searchParams.get(key);
  return raw && raw.startsWith("eq.") ? raw.slice(3) : null;
}

function fakeWire(input: Request | URL | string, init?: RequestInit): Response {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href);
  const method = (init?.method ?? "GET").toUpperCase();
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;

  if (url.pathname === "/rest/v1/users") {
    if (method === "PATCH") {
      userPatches.push(body);
      user = { ...user, ...body };
      return json(null, 204);
    }
    // Every users read in these handlers is .single().
    return json(user);
  }

  if (url.pathname === "/rest/v1/flipdesk_subscription_events") {
    if (method === "POST") {
      for (const r of Array.isArray(body) ? body : [body]) audit.push(r);
      return json(null, 201);
    }
    // The watermark query: user_id + raw_payload->>subscription_id, rows that
    // carry raw_payload->event_created.
    const uid = eqParam(url, "user_id");
    const sid = eqParam(url, "raw_payload->>subscription_id");
    const needsCreated = url.searchParams.get("raw_payload->event_created") === "not.is.null";
    const rows = audit.filter((r) => {
      const p = (r.raw_payload ?? {}) as Row;
      if (uid !== null && r.user_id !== uid) return false;
      if (sid !== null && p.subscription_id !== sid) return false;
      if (needsCreated && (p.event_created === undefined || p.event_created === null)) return false;
      return true;
    });
    return json(rows.map((r) => ({ raw_payload: r.raw_payload })));
  }

  if (url.pathname.startsWith("/rest/v1/")) {
    return method === "GET" ? json([]) : json(null, 201);
  }
  // PostHog, ops sinks and anything else fire-and-forget.
  return json({});
}

globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) =>
  Promise.resolve(fakeWire(input, init))) as typeof fetch;

resetSupabaseAdminForTests();
Deno.env.set("STRIPE_SECRET_KEY", "sk_test_dummy");
Deno.env.set("STRIPE_WEBHOOK_SECRET", TEST_SECRET);

subscriptionGuardDeps.retrieveStatus = (id: string) => {
  retrieveCalls.push(id);
  return Promise.resolve(storedStatus[id] ?? "missing");
};

async function signStripe(payload: string): Promise<string> {
  const ts = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(TEST_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${ts}.${payload}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `t=${ts},v1=${hex}`;
}

let seq = 0;
function subObject(id: string, plan: string, extra: Row = {}): Row {
  return {
    id,
    object: "subscription",
    customer: CUSTOMER,
    status: "active",
    metadata: { plan },
    items: { data: [{ price: { id: `price_${plan}`, unit_amount: 1000, recurring: { interval: "month" } } }] },
    current_period_end: T + 30 * 86400,
    cancel_at_period_end: false,
    pause_collection: null,
    schedule: null,
    trial_end: null,
    ...extra,
  };
}

async function deliver(type: string, created: number, object: Row): Promise<Response> {
  const payload = JSON.stringify({
    id: `evt_order_${++seq}`,
    object: "event",
    type,
    created,
    // livemode true: an unset EDGE_ENV reads as production, which drops test-mode events.
    livemode: true,
    data: { object },
  });
  return await webhookRoutes.request("/stripe", {
    method: "POST",
    headers: { "Content-Type": "application/json", "stripe-signature": await signStripe(payload) },
    body: payload,
  });
}

Deno.test("seller: an older subscription.updated after a newer one is ignored", async () => {
  reset({ flipdesk_plan: "starter", flipdesk_subscription_id: "sub_A", subscription_status: "active" });

  // Newer event first: the upgrade to pro.
  let res = await deliver("customer.subscription.updated", T + 100, subObject("sub_A", "pro"));
  assertEquals(res.status, 200);
  assertEquals(user.flipdesk_plan, "pro");
  const patchesAfterNewer = userPatches.length;

  // Then the older one (still on starter) arrives late.
  res = await deliver("customer.subscription.updated", T, subObject("sub_A", "starter"));
  assertEquals(res.status, 200);
  assertEquals(user.flipdesk_plan, "pro", "the late older event put the old plan back");
  assertEquals(userPatches.length, patchesAfterNewer, "the stale event still wrote to users");
  const ignored = audit.filter((r) => r.event_type === "ignored.customer.subscription.updated");
  assertEquals(ignored.length, 1);
  assertEquals((ignored[0].raw_payload as Row).reason, "stale_event");
  // An ignored row must not carry the watermark key.
  assertEquals((ignored[0].raw_payload as Row).event_created, undefined);
});

Deno.test("seller: a newer event after an older one still applies (control)", async () => {
  reset({ flipdesk_plan: "starter", flipdesk_subscription_id: "sub_A", subscription_status: "active" });
  await deliver("customer.subscription.updated", T, subObject("sub_A", "starter"));
  const res = await deliver("customer.subscription.updated", T + 100, subObject("sub_A", "pro"));
  assertEquals(res.status, 200);
  assertEquals(user.flipdesk_plan, "pro");
});

Deno.test("seller: an event for a non-current subscription does not overwrite the current one", async () => {
  reset({ flipdesk_plan: "pro", flipdesk_subscription_id: "sub_CURRENT", subscription_status: "active" });
  storedStatus = { sub_CURRENT: "active" };

  const res = await deliver("customer.subscription.updated", T, subObject("sub_OTHER", "starter"));
  assertEquals(res.status, 200);
  assertEquals(retrieveCalls, ["sub_CURRENT"]);
  assertEquals(user.flipdesk_subscription_id, "sub_CURRENT");
  assertEquals(user.flipdesk_plan, "pro");
  assertEquals(userPatches.length, 0, "a non-current sub's event wrote to users");
  const ignored = audit.filter((r) => r.event_type === "ignored.customer.subscription.updated");
  assertEquals((ignored[0]?.raw_payload as Row | undefined)?.reason, "not_current_subscription");
});

Deno.test("seller: a replacement sub is adopted once Stripe says the stored one is canceled (control)", async () => {
  reset({ flipdesk_plan: "pro", flipdesk_subscription_id: "sub_OLD", subscription_status: "active" });
  storedStatus = { sub_OLD: "canceled" };
  const res = await deliver("customer.subscription.created", T, subObject("sub_NEW", "business"));
  assertEquals(res.status, 200);
  assertEquals(user.flipdesk_subscription_id, "sub_NEW");
  assertEquals(user.flipdesk_plan, "business");
});

Deno.test("seller: deleting a non-current subscription leaves the plan alone", async () => {
  reset({ flipdesk_plan: "pro", flipdesk_subscription_id: "sub_CURRENT", subscription_status: "active" });
  const res = await deliver("customer.subscription.deleted", T, subObject("sub_DUP", "pro", { status: "canceled" }));
  assertEquals(res.status, 200);
  assertEquals(user.flipdesk_plan, "pro");
  assertEquals(user.flipdesk_subscription_id, "sub_CURRENT");
  assertEquals(userPatches.length, 0);
  assert(audit.some((r) => r.event_type === "ignored.customer.subscription.deleted"));
  assert(!audit.some((r) => r.event_type === "customer.subscription.deleted"));
});

Deno.test("seller: deleting the current subscription still demotes (control)", async () => {
  reset({ flipdesk_plan: "pro", flipdesk_subscription_id: "sub_CURRENT", subscription_status: "active" });
  await deliver("customer.subscription.deleted", T, subObject("sub_CURRENT", "pro", { status: "canceled" }));
  assertEquals(user.flipdesk_plan, "free");
  assertEquals(user.flipdesk_subscription_id, null);
});

Deno.test("seller: a late update for a sub that was already deleted cannot revive it", async () => {
  reset({ flipdesk_plan: "pro", flipdesk_subscription_id: "sub_A", subscription_status: "active" });
  await deliver("customer.subscription.deleted", T + 100, subObject("sub_A", "pro", { status: "canceled" }));
  assertEquals(user.flipdesk_plan, "free");
  await deliver("customer.subscription.updated", T, subObject("sub_A", "pro"));
  assertEquals(user.flipdesk_plan, "free");
  assertEquals(user.flipdesk_subscription_id, null);
});

Deno.test("buyer: older event after newer, and non-current buyer sub, are both ignored", async () => {
  reset({ buyer_plan: "guard", buyer_subscription_id: "sub_B", buyer_subscription_status: "active" });

  await deliver("customer.subscription.updated", T + 100, subObject("sub_B", "connoisseur"));
  assertEquals(user.buyer_plan, "connoisseur");
  await deliver("customer.subscription.updated", T, subObject("sub_B", "guard"));
  assertEquals(user.buyer_plan, "connoisseur", "a stale buyer event put the old tier back");

  storedStatus = { sub_B: "active" };
  await deliver("customer.subscription.deleted", T + 200, subObject("sub_B_DUP", "guard", { status: "canceled" }));
  assertEquals(user.buyer_plan, "connoisseur", "deleting a non-current buyer sub demoted the buyer");
  assertEquals(user.buyer_subscription_id, "sub_B");
  assert(audit.some((r) => r.event_type === "buyer.ignored.customer.subscription.updated"));
  assert(audit.some((r) => r.event_type === "buyer.ignored.customer.subscription.deleted"));
  // Buyer rows never touch the seller columns.
  assertEquals(user.flipdesk_plan, "free");
});
