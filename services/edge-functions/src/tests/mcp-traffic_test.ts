// US-9105: rate-limit classification, budget isolation and usage accounting for
// the MCP endpoint.
//
// The behaviour worth protecting is the one /api/v1 gets for free from HTTP
// verbs and MCP cannot: a client polling tools/list must not be able to spend
// the budget a publish needs. That is asserted end-to-end through the shared
// limiter, not just on the classifier.

import { assert, assertEquals, assertExists } from "@std/assert";
import type { Context } from "hono";
import { Hono } from "hono";
// Type-only, so it is erased at runtime and does not hoist a module load above
// the env setup below.
import type { RateLimitIncrementer } from "../middleware/rate-limit.ts";
// Static: api-v1-rate.ts is pure (hono types only) so it needs no env setup,
// and the same static form is what api-v1-rate_test.ts already uses.
import { API_RATE_TIERS, apiV1Subject } from "../middleware/api-v1-rate.ts";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  bypassUnlessRead,
  bypassUnlessWrite,
  classifyRpcMethod,
  isBillableRpcMethod,
  mcpClassifyMiddleware,
  mcpRateLimitBody,
  mcpReadLimit,
  mcpWriteLimit,
} = await import("../middleware/mcp-traffic.ts");
const { rateLimiter } = await import("../middleware/rate-limit.ts");

// The classifier sets vars the base Hono Env does not declare, so the test app
// declares them or c.get() will not type-check.
type McpTestEnv = { Variables: { mcpRateClass: string; mcpRpcMethod: string; mcpToolName: string } };

function ctx(vars: Record<string, string | undefined>): Context {
  return { get: (k: string) => vars[k] } as unknown as Context;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

Deno.test("classifyRpcMethod: only tools/call is a write; everything else reads", () => {
  assertEquals(classifyRpcMethod("tools/call"), "write");
  assertEquals(classifyRpcMethod("tools/list"), "read");
  assertEquals(classifyRpcMethod("server/discover"), "read");
  assertEquals(classifyRpcMethod("ping"), "read");
  assertEquals(classifyRpcMethod("initialize"), "read");
  // An unreadable body must not fall into the looser bucket.
  assertEquals(classifyRpcMethod(undefined), "read");
});

Deno.test("isBillableRpcMethod: protocol overhead never creates a ledger row", () => {
  assert(isBillableRpcMethod("tools/call"));
  for (const method of ["initialize", "ping", "server/discover", "tools/list", "prompts/list"]) {
    assert(!isBillableRpcMethod(method), `${method} must not be billable`);
  }
  // Reconnect churn must not eat a partner's monthly quota.
  assert(!isBillableRpcMethod("notifications/initialized"));
  assert(!isBillableRpcMethod(undefined));
});

Deno.test("the classifier reads the method from a legacy body (no mirrored header)", async () => {
  const app = new Hono<McpTestEnv>();
  app.use("/*", mcpClassifyMiddleware);
  app.post("/", (c) => c.json({ rateClass: c.get("mcpRateClass"), tool: c.get("mcpToolName") }));

  const res = await app.request(
    new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "gradethread_publish_listing" },
      }),
    }),
  );
  assertEquals(await res.json(), {
    rateClass: "write",
    tool: "gradethread_publish_listing",
  });
});

Deno.test("the classifier trusts Mcp-Method only when the version says header validation applies", async () => {
  const app = new Hono<McpTestEnv>();
  app.use("/*", mcpClassifyMiddleware);
  app.post("/", (c) => c.json({ rateClass: c.get("mcpRateClass") }));

  // A legacy version with a stray Mcp-Method header claiming a read: the body
  // is the source of truth, so this must still be classified as a write.
  const res = await app.request(
    new Request("http://localhost/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-11-25",
        "Mcp-Method": "tools/list",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} }),
    }),
  );
  assertEquals((await res.json()).rateClass, "write");
});

Deno.test("the classifier leaves the body readable for the route (Hono caches it)", async () => {
  const app = new Hono<McpTestEnv>();
  app.use("/*", mcpClassifyMiddleware);
  app.post("/", async (c) => c.json({ method: (await c.req.json()).method }));

  const res = await app.request(
    new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    }),
  );
  assertEquals((await res.json()).method, "ping");
});

Deno.test("a malformed body classifies as a read rather than throwing", async () => {
  const app = new Hono<McpTestEnv>();
  app.use("/*", mcpClassifyMiddleware);
  app.post("/", (c) => c.json({ rateClass: c.get("mcpRateClass") }));

  const res = await app.request(
    new Request("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    }),
  );
  assertEquals(res.status, 200);
  assertEquals((await res.json()).rateClass, "read");
});

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

Deno.test("MCP budgets come from the same plan tiers as /api/v1", () => {
  const c = ctx({ apiKeyPlan: "business" });
  assertEquals(mcpReadLimit(c), API_RATE_TIERS.business.read);
  assertEquals(mcpWriteLimit(c), API_RATE_TIERS.business.write);
});

Deno.test("bypass predicates route each request to exactly one limiter", () => {
  const read = ctx({ mcpRateClass: "read" });
  const write = ctx({ mcpRateClass: "write" });
  assertEquals(bypassUnlessRead(read), false);
  assertEquals(bypassUnlessRead(write), true);
  assertEquals(bypassUnlessWrite(write), false);
  assertEquals(bypassUnlessWrite(read), true);
  // An unclassified request (GET on the legacy SSE stream) counts as a read.
  const unclassified = ctx({});
  assertEquals(bypassUnlessRead(unclassified), false);
  assertEquals(bypassUnlessWrite(unclassified), true);
});

Deno.test("mcpRateLimitBody is a JSON-RPC error, not the /api/v1 envelope", () => {
  const body = mcpRateLimitBody({ retryAfter: 12, limit: 40 }) as {
    jsonrpc: string;
    error: { code: number; message: string; data: Record<string, unknown> };
  };
  assertEquals(body.jsonrpc, "2.0");
  assert(body.error.message.includes("12"));
  assertEquals(body.error.data.retry_after_seconds, 12);
  assertEquals(body.error.data.limit_per_minute, 40);
  assertEquals(body.error.data.reason, "rate_limited");
});

// ── End-to-end through the shared limiter ──────────────────────────

function memoryStore(): RateLimitIncrementer {
  const counts = new Map<string, number>();
  return (bucketKey, windowStartIso) => {
    const k = `${bucketKey}|${windowStartIso}`;
    const next = (counts.get(k) ?? 0) + 1;
    counts.set(k, next);
    return Promise.resolve(next);
  };
}

// US-2448: pin the clock, or a real minute boundary landing mid-run rolls the
// window and lets the over-budget request through.
const NEAR_BOUNDARY = Date.parse("2026-08-09T12:00:59.995Z");

interface Rec {
  status: number | null;
  body: unknown;
  headers: Record<string, string>;
}

async function invoke(
  mw: ReturnType<typeof rateLimiter>,
  vars: Record<string, string | undefined>,
): Promise<{ rec: Rec; nexted: boolean }> {
  const rec: Rec = { status: null, body: undefined, headers: {} };
  const c = {
    get: (k: string) => vars[k],
    req: { method: "POST", header: () => undefined },
    header: (n: string, v: string) => {
      rec.headers[n] = v;
    },
    json: (body: unknown, status?: number) => {
      rec.status = status ?? 200;
      rec.body = body;
      return { __response: true };
    },
  };
  let nexted = false;
  await (mw as unknown as (c: unknown, next: () => Promise<void>) => Promise<unknown>)(
    c,
    () => {
      nexted = true;
      return Promise.resolve();
    },
  );
  return { rec, nexted };
}

function limiters(store: RateLimitIncrementer) {
  const common = {
    subject: apiV1Subject,
    failClosed: true,
    errorBody: mcpRateLimitBody,
    now: () => NEAR_BOUNDARY,
  };
  return {
    read: rateLimiter(mcpReadLimit, 60_000, "mcp-read", store, {
      ...common,
      bypass: bypassUnlessRead,
    }),
    write: rateLimiter(mcpWriteLimit, 60_000, "mcp-write", store, {
      ...common,
      bypass: bypassUnlessWrite,
    }),
  };
}

Deno.test("a tools/list flood cannot drain the budget a tools/call needs", async () => {
  const store = memoryStore();
  const { read, write } = limiters(store);
  const key = { apiKeyId: "key-1", apiKeyPlan: "business" };
  const readVars = { ...key, mcpRateClass: "read" };
  const writeVars = { ...key, mcpRateClass: "write" };

  // Spend the ENTIRE read budget, driving both limiters exactly as main.ts
  // mounts them (the write limiter must bypass every one of these).
  for (let i = 0; i < API_RATE_TIERS.business.read; i++) {
    await invoke(read, readVars);
    await invoke(write, readVars);
  }

  // The read budget is now spent.
  const overRead = await invoke(read, readVars);
  assertEquals(overRead.rec.status, 429);
  assert(!overRead.nexted);

  // The write budget is untouched: a publish still goes through.
  const firstWrite = await invoke(write, writeVars);
  assert(firstWrite.nexted, "the write budget was consumed by read traffic");
  assertEquals(firstWrite.rec.status, null);
});

Deno.test("the write budget still exhausts on its own, in a JSON-RPC 429", async () => {
  const store = memoryStore();
  const { write } = limiters(store);
  const vars = { apiKeyId: "key-2", apiKeyPlan: "business", mcpRateClass: "write" };

  for (let i = 0; i < API_RATE_TIERS.business.write; i++) {
    const { nexted } = await invoke(write, vars);
    assert(nexted, `write ${i + 1} should have been allowed`);
  }

  const over = await invoke(write, vars);
  assertEquals(over.rec.status, 429);
  const body = over.rec.body as { jsonrpc: string; error: { data: Record<string, unknown> } };
  assertEquals(body.jsonrpc, "2.0");
  assertEquals(body.error.data.reason, "rate_limited");
  assertExists(over.rec.headers["Retry-After"]);
});

Deno.test("two keys held by one user do not share a budget", async () => {
  const store = memoryStore();
  const { write } = limiters(store);
  const a = { apiKeyId: "key-a", userId: "u1", apiKeyPlan: "business", mcpRateClass: "write" };
  const b = { apiKeyId: "key-b", userId: "u1", apiKeyPlan: "business", mcpRateClass: "write" };

  for (let i = 0; i < API_RATE_TIERS.business.write; i++) await invoke(write, a);
  assertEquals((await invoke(write, a)).rec.status, 429);

  const otherKey = await invoke(write, b);
  assert(otherKey.nexted, "a second key must have its own budget");
});

Deno.test("a counter-store outage still limits: writes fail CLOSED", async () => {
  const throwingStore: RateLimitIncrementer = () => Promise.reject(new Error("store down"));
  const { write } = limiters(throwingStore);
  const vars = { apiKeyId: "key-3", apiKeyPlan: "business", mcpRateClass: "write" };

  // The local fallback takes over rather than handing out unlimited throughput.
  let limited = false;
  for (let i = 0; i < API_RATE_TIERS.business.write * 3; i++) {
    const { rec } = await invoke(write, vars);
    if (rec.status === 429) {
      limited = true;
      break;
    }
  }
  assert(limited, "a store outage must not disable the write limit");
});
