// MP-10: the queue view clears, and Cancel cannot delete a running job.
//
// Expired and failed rows never left the view, and the single oldest-first
// limit(200) over live and dead rows let old failures push a new delist off it.
// DELETE /:id also deleted a row the extension had already claimed. These DRIVE
// the router against a small in-memory PostgREST stand-in.
//
//   deno test --allow-net --allow-env --allow-read src/tests/extension-queue-lifecycle_test.ts

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";

const OWNER = "11111111-1111-4111-8111-111111111111";

type Row = Record<string, unknown> & { id: string; status: string; user_id: string };
let table: Row[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Apply the PostgREST filters this router uses to `table`. */
function matches(row: Row, params: URLSearchParams): boolean {
  for (const [key, raw] of params) {
    if (["select", "order", "limit", "offset"].includes(key)) continue;
    const value = row[key] as string | null | undefined;
    if (raw.startsWith("eq.")) {
      if (String(value) !== raw.slice(3)) return false;
    } else if (raw.startsWith("in.(")) {
      const set = raw.slice(4, -1).split(",").map((s) => s.replace(/^"|"$/g, ""));
      if (!set.includes(String(value))) return false;
    } else if (raw.startsWith("gte.")) {
      if (value == null || String(value) < raw.slice(4)) return false;
    } else if (raw.startsWith("lt.")) {
      if (value == null || String(value) >= raw.slice(3)) return false;
    } else if (raw === "not.is.null") {
      if (value == null) return false;
    }
  }
  return true;
}

function handle(input: Request | URL | string, init?: RequestInit): Response {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? "GET").toUpperCase();
  if (!url.pathname.includes("/rest/v1/")) return json({});
  const wantsObject = (new Headers(init?.headers).get("Accept") ?? "").includes("object");
  if (!url.pathname.endsWith("/extension_work_queue")) return json(wantsObject ? null : []);

  const hits = table.filter((r) => matches(r, url.searchParams));
  if (method === "DELETE") {
    table = table.filter((r) => !hits.includes(r));
    return json(wantsObject ? hits[0] ?? null : hits);
  }
  if (method === "PATCH") {
    const patch = JSON.parse(String(init?.body ?? "{}"));
    for (const r of hits) Object.assign(r, patch);
    return json(wantsObject ? hits[0] ?? null : hits);
  }
  let out = [...hits];
  const order = url.searchParams.get("order");
  if (order) {
    const [col, dir] = order.split(".");
    out.sort((a, b) => {
      const av = String(a[col!] ?? "");
      const bv = String(b[col!] ?? "");
      return dir === "desc" ? bv.localeCompare(av) : av.localeCompare(bv);
    });
  }
  const limit = Number(url.searchParams.get("limit") ?? "0");
  if (limit) out = out.slice(0, limit);
  return json(wantsObject ? out[0] ?? null : out);
}

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) =>
  Promise.resolve(handle(input, init))) as typeof fetch;
addEventListener("unload", () => {
  globalThis.fetch = realFetch;
});

const { Hono } = await import("hono");
const { flipdeskExtensionQueueRoutes, NEEDS_ATTENTION_LIMIT } = await import(
  "../routes/flipdesk-extension-queue.ts"
);

function app() {
  // deno-lint-ignore no-explicit-any
  const a = new Hono<any>();
  a.use("*", async (c, next) => {
    c.set("userId", OWNER);
    c.set("workspaceOwnerId", OWNER);
    c.set("workspaceRole", "owner");
    await next();
  });
  a.route("/", flipdeskExtensionQueueRoutes);
  return a;
}

function row(over: Partial<Row>): Row {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    user_id: OWNER,
    kind: "delist",
    platform: "poshmark",
    inventory_item_id: null,
    listing_id: null,
    payload: {},
    status: "queued",
    attempts: 0,
    source: "web",
    claimed_at: null,
    completed_at: null,
    result: null,
    expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    created_at: now,
    ...over,
  };
}

Deno.test("MP-10: DELETE on a claimed row is a 409 and the row survives", async () => {
  const claimed = row({ status: "claimed", claimed_at: new Date().toISOString() });
  table = [claimed];
  const res = await app().request(`/${claimed.id}`, { method: "DELETE" });
  const body = await res.json() as { status?: string };
  assertEquals(res.status, 409);
  assertEquals(body.status, "claimed");
  assertEquals(table.length, 1, "the running job must not be deleted");
});

Deno.test("MP-10: queued, failed and expired rows can be deleted", async () => {
  for (const status of ["queued", "failed", "expired"]) {
    const r = row({ status });
    table = [r];
    const res = await app().request(`/${r.id}`, { method: "DELETE" });
    await res.body?.cancel();
    assertEquals(res.status, 200, status);
    assertEquals(table.length, 0, status);
  }
});

Deno.test("MP-10: another seller's row is a 404", async () => {
  const r = row({ user_id: "99999999-9999-4999-8999-999999999999" });
  table = [r];
  const res = await app().request(`/${r.id}`, { method: "DELETE" });
  await res.body?.cancel();
  assertEquals(res.status, 404);
  assertEquals(table.length, 1);
});

Deno.test("MP-10: 300 old failures do not push a new delist off the queue", async () => {
  const old = Date.now() - 3 * 86_400_000;
  table = Array.from({ length: 300 }, (_, i) =>
    row({
      status: "failed",
      created_at: new Date(old + i).toISOString(),
      completed_at: new Date(old + i + 1000).toISOString(),
    }));
  const fresh = row({ status: "queued" });
  table.push(fresh);
  const res = await app().request("/");
  const body = await res.json() as {
    pending: Array<{ id: string }>;
    needsAttention: Array<{ id: string }>;
  };
  assertEquals(res.status, 200);
  assertEquals(body.pending.map((r) => r.id), [fresh.id]);
  assert(body.needsAttention.length <= NEEDS_ATTENTION_LIMIT, `${body.needsAttention.length}`);
});

Deno.test("MP-10: a failure older than the window leaves the view", async () => {
  table = [
    row({
      status: "failed",
      completed_at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    }),
  ];
  const res = await app().request("/");
  const body = await res.json() as { needsAttention: unknown[] };
  assertEquals(body.needsAttention.length, 0);
});

Deno.test("MP-10: expiry stamps completed_at so an expired row can age out", async () => {
  const stale = row({ status: "queued", expires_at: new Date(Date.now() - 1000).toISOString() });
  table = [stale];
  const res = await app().request("/");
  const body = await res.json() as { needsAttention: Array<{ id: string }> };
  assertEquals(table[0]!.status, "expired");
  assert(table[0]!.completed_at, "expiry must stamp completed_at");
  assertEquals(body.needsAttention.map((r) => r.id), [stale.id]);
});
