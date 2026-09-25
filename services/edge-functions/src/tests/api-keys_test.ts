// routes/api-keys.ts, driven through Hono against a recording stand-in for the
// service-role client. No network, no DB.
//
// Pinned here:
//   DEV-01/03  GET /usage answers api_access from the OWNER's plan and the
//              overage block from the owner's wallet.
//   DEV-06     rotating an expired key is refused with 409 and key_hash is
//              never written.
//   DEV-08     a PUT /branding with an empty body cannot wipe stored branding.

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { apiKeyRoutes } from "../routes/api-keys.ts";

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
  const a = new Hono();
  a.use("*", async (c, next) => {
    // deno-lint-ignore no-explicit-any
    const cc = c as any;
    cc.set("userId", userId);
    cc.set("workspaceOwnerId", ownerId);
    cc.set("workspaceRole", role);
    await next();
  });
  a.route("/", apiKeyRoutes);
  return a;
}

const superAdminUser = { role: "super_admin", flipdesk_plan: "business" };

Deno.test("rotate: an expired owned key answers 409 and key_hash is never written", async () => {
  const db = install((op) => {
    if (op.table === "api_keys" && op.op === "select") {
      return { data: { id: "k1", expires_at: "2020-01-01T00:00:00Z" } };
    }
    return { data: null };
  });
  try {
    const res = await app("owner").request("/k1/rotate", { method: "POST" });
    assertEquals(res.status, 409);
    const body = await res.json();
    assertEquals(body.error, "This key has expired. Create a new key instead.");
    assertEquals(db.ops.filter((o) => o.op === "update").length, 0, "rotate wrote to an expired key");
    // The lookup stayed owner-scoped.
    const lookup = db.ops.find((o) => o.table === "api_keys")!;
    assert(lookup.filters.some(([k, col, v]) => k === "eq" && col === "user_id" && v === OWNER));
  } finally {
    db.restore();
  }
});

Deno.test("rotate: an unexpired key still rotates", async () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();
  const db = install((op) => {
    if (op.table === "api_keys" && op.op === "select") return { data: { id: "k1", expires_at: future } };
    if (op.table === "api_keys" && op.op === "update") return { data: { id: "k1", key_prefix: "gt_sk_x" } };
    return { data: null };
  });
  try {
    const res = await app("owner").request("/k1/rotate", { method: "POST" });
    assertEquals(res.status, 200);
    assertEquals(db.ops.filter((o) => o.op === "update").length, 1);
  } finally {
    db.restore();
  }
});

Deno.test("usage: api_access and overage are read for the workspace OWNER", async () => {
  const db = install((op) => {
    if (op.table === "users") return { data: superAdminUser };
    if (op.table === "api_keys") return { count: 0 };
    if (op.table === "api_credit_wallet") return { data: { balance: 42 } };
    return { data: null };
  });
  try {
    // An admin (ADMIN) acting inside OWNER's workspace.
    const res = await app("admin", ADMIN, OWNER).request("/usage");
    assertEquals(res.status, 200);
    const { data } = await res.json();
    assertEquals(data.api_access, true);
    assertEquals(data.overage, { quota_enabled: false, balance: 42 });
    for (const op of db.ops) {
      const scoped = op.filters.some(([, col, v]) => (col === "user_id" || col === "id") && v === OWNER);
      assert(scoped, `${op.table} was not scoped to the owner`);
      assert(!op.filters.some(([, , v]) => v === ADMIN), `${op.table} used the admin's own id`);
    }
    const quota = db.ops.find((o) => o.table === "api_keys")!;
    assert(quota.filters.some(([k, col]) => k === "not.is" && col === "monthly_quota"));
  } finally {
    db.restore();
  }
});

Deno.test("usage: a member is refused", async () => {
  const db = install(() => ({ data: null }));
  try {
    const res = await app("member", ADMIN, OWNER).request("/usage");
    assertEquals(res.status, 403);
    assertEquals(db.ops.length, 0);
  } finally {
    db.restore();
  }
});

Deno.test("branding: an empty PUT over stored branding is refused and the row is unchanged", async () => {
  const db = install((op) => {
    if (op.table === "users" && op.op === "select") {
      return { data: { ...superAdminUser, partner_branding: { brand_color: "#0F3460" } } };
    }
    return { data: null };
  });
  try {
    const res = await app("owner").request("/branding", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assertEquals(res.status, 400);
    assertEquals(db.ops.filter((o) => o.op === "update").length, 0, "the stored branding was overwritten");
  } finally {
    db.restore();
  }
});

Deno.test("branding: clear:true is the one way to empty stored branding", async () => {
  const db = install((op) => {
    if (op.table === "users" && op.op === "select") {
      return { data: { ...superAdminUser, partner_branding: { brand_color: "#0F3460" } } };
    }
    return { data: null };
  });
  try {
    const res = await app("owner").request("/branding", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clear: true }),
    });
    assertEquals(res.status, 200);
    const update = db.ops.find((o) => o.op === "update")!;
    assertEquals(update.values, { partner_branding: {} });
    assert(update.filters.some(([, col, v]) => col === "id" && v === OWNER));
  } finally {
    db.restore();
  }
});

// DEV-11: the PUT that creates the endpoint answers from what it wrote. With
// the follow-up config read failing, the minted secret still comes back.
Deno.test("webhook PUT: a failing follow-up read cannot swallow the minted secret", async () => {
  if (!Deno.env.get("EDGE_ENCRYPTION_KEY")) {
    Deno.env.set("EDGE_ENCRYPTION_KEY", btoa("0123456789abcdef0123456789abcdef"));
  }
  let endpointReads = 0;
  const db = install((op) => {
    if (op.table === "users") return { data: superAdminUser };
    if (op.table === "api_webhook_endpoints" && op.op === "select") {
      endpointReads++;
      // First read: no endpoint yet. Any later read (the old re-read) fails.
      return endpointReads === 1 ? { data: null } : { error: { message: "read failed" } };
    }
    if (op.table === "api_webhook_endpoints" && op.op === "upsert") return { data: [{ user_id: OWNER }] };
    return { data: null };
  });
  try {
    const res = await app("owner").request("/webhook", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://93.184.216.34/hook" }),
    });
    assertEquals(res.status, 200);
    const { data } = await res.json();
    assert(String(data.signing_secret).startsWith("whsec_"), "the minted secret was not returned");
    assertEquals(data.has_signing_secret, true);
    assertEquals(data.webhook_url, "https://93.184.216.34/hook");
  } finally {
    db.restore();
  }
});
