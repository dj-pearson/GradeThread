// DEV-01: POST /api/payments/api-overage/checkout, driven through Hono against
// a recording stand-in for the service-role client. No network, no Stripe.
//
// Pinned here: only owner/admin may buy; the quota check reads the workspace
// OWNER's keys, never the buyer's; and with no quota-bearing key the route
// answers 409 before any Stripe call.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { paymentRoutes } from "../routes/payments.ts";

const OWNER = "11111111-1111-1111-1111-111111111111";
const ADMIN = "22222222-2222-2222-2222-222222222222";

interface Op {
  table: string;
  op: string;
  values?: unknown;
  filters: Array<[string, string, unknown]>;
}

type Answer = { data?: unknown; error?: unknown; count?: number };
type Responder = (op: Op) => Answer;

function install(respond: Responder) {
  const ops: Op[] = [];
  // supabaseAdmin is a Proxy onto a lazily built client whose from()/rpc()
  // delegate to `this.rest`. Patching the real PostgrestClient's own methods is
  // the seam; assigning onto the proxy would land on its empty target.
  // deno-lint-ignore no-explicit-any
  const admin = (supabaseAdmin as any).rest;
  admin.from = (table: string) => {
    const op: Op = { table, op: "select", filters: [] };
    ops.push(op);
    const answer = () => {
      const a = respond(op);
      return { data: a.data ?? null, error: a.error ?? null, count: a.count ?? null };
    };
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select: () => b,
      insert: (v: unknown) => ((op.op = "insert"), (op.values = v), b),
      update: (v: unknown) => ((op.op = "update"), (op.values = v), b),
      upsert: (v: unknown) => ((op.op = "upsert"), (op.values = v), b),
      delete: () => ((op.op = "delete"), b),
      eq: (col: string, val: unknown) => (op.filters.push(["eq", col, val]), b),
      not: (col: string, o: string, val: unknown) => (op.filters.push([`not.${o}`, col, val]), b),
      gt: (col: string, val: unknown) => (op.filters.push(["gt", col, val]), b),
      gte: (col: string, val: unknown) => (op.filters.push(["gte", col, val]), b),
      lt: (col: string, val: unknown) => (op.filters.push(["lt", col, val]), b),
      order: () => b,
      limit: () => b,
      single: () => Promise.resolve(answer()),
      maybeSingle: () => Promise.resolve(answer()),
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
        Promise.resolve(answer()).then(ok, bad),
    };
    return b;
  };
  admin.rpc = () => Promise.resolve({ data: { total_requests: 0 }, error: null });
  return {
    ops,
    restore() {
      delete admin.from;
      delete admin.rpc;
    },
  };
}

function app(role: string, userId = OWNER, ownerId = OWNER) {
  // deno-lint-ignore no-explicit-any
  const a = new Hono<any>();
  a.use("*", async (cc, next) => {
    cc.set("userId", userId);
    cc.set("workspaceOwnerId", ownerId);
    cc.set("workspaceRole", role);
    await next();
  });
  a.route("/", paymentRoutes);
  return a;
}

const superAdminUser = { id: OWNER, role: "super_admin", flipdesk_plan: "business" };

function post(role: string, userId = OWNER, ownerId = OWNER) {
  return app(role, userId, ownerId).request("/api-overage/checkout", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pack: "10" }),
  });
}

Deno.test("overage checkout: a member is refused before any read", async () => {
  const db = install(() => ({ data: null }));
  try {
    const res = await post("member", ADMIN, OWNER);
    assertEquals(res.status, 403);
    assertEquals(db.ops.length, 0);
  } finally {
    db.restore();
  }
});

Deno.test("overage checkout: no quota-bearing key answers 409, checked on the OWNER's keys", async () => {
  const db = install((op) => {
    if (op.table === "users") return { data: superAdminUser };
    if (op.table === "api_keys") return { count: 0 };
    return { data: null };
  });
  try {
    const res = await post("admin", ADMIN, OWNER);
    assertEquals(res.status, 409);
    const quota = db.ops.find((o) => o.table === "api_keys");
    assert(quota, "the quota check never ran");
    assert(quota.filters.some(([k, col, v]) => k === "eq" && col === "user_id" && v === OWNER));
    assert(quota.filters.some(([k, col]) => k === "not.is" && col === "monthly_quota"));
    for (const op of db.ops) {
      assert(!op.filters.some(([, , v]) => v === ADMIN), `${op.table} used the buyer's own id`);
    }
  } finally {
    db.restore();
  }
});
