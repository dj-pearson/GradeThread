// GET /promotions/performance and GET /promotions/stack-check must reach their
// own handlers, not GET /promotions/:promotionId.
//
// Hono serves the first matching route. The :promotionId read was registered
// ahead of both literal paths, so "performance" and "stack-check" were taken
// as promotion ids: with eBay configured, the dashboard card
// (promotion-performance-card.tsx) got a { promotion } body or a 502 from eBay
// instead of the lift report and the discount-stack check; with eBay
// unconfigured it got a 503 for two routes that only read local tables.
//
// The handlers are told apart by what they answer with eBay unconfigured and
// every database read answering empty: the :promotionId read refuses with 503
// before any work, performance answers { promotions: [] }, stack-check answers
// with its margin_floor_pct.
//
// MP-11: this used to rely on the database being UNREACHABLE and the reads
// swallowing that into []. A failed read is now a 500, so the reads are stubbed
// to succeed empty instead.
//
// Run: deno test --allow-env --allow-read --allow-net src/tests/ebay-promotions-route-order_test.ts
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { Hono } from "hono";
import { flipdeskEbayRoutes } from "../routes/flipdesk-ebay.ts";
import type { EbayEnv } from "../routes/flipdesk-ebay-shared.ts";

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("/rest/v1/")) {
    return Promise.resolve(
      new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }),
    );
  }
  return realFetch(input, init);
}) as typeof fetch;
addEventListener("unload", () => {
  globalThis.fetch = realFetch;
});

const OWNER = "00000000-0000-4000-8000-0000000000aa";

function app(): Hono<EbayEnv> {
  const a = new Hono<EbayEnv>();
  a.use("*", async (c, next) => {
    c.set("userId", OWNER);
    c.set("workspaceOwnerId", OWNER);
    await next();
  });
  a.route("/", flipdeskEbayRoutes);
  return a;
}

async function withEbayUnconfigured<T>(fn: () => Promise<T>): Promise<T> {
  const keys = ["EBAY_APP_ID", "EBAY_CERT_ID", "EBAY_RU_NAME"];
  const saved = keys.map((k) => [k, Deno.env.get(k)] as const);
  for (const k of keys) Deno.env.delete(k);
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) if (v !== undefined) Deno.env.set(k, v);
  }
}

const NOT_CONFIGURED = "eBay is not configured on this server.";

Deno.test("GET /promotions/performance reaches the performance handler", async () => {
  await withEbayUnconfigured(async () => {
    const res = await app().request("/promotions/performance");
    const body = await res.json();
    assert(body.error !== NOT_CONFIGURED, "served by GET /promotions/:promotionId");
    assertEquals(res.status, 200);
    assertEquals(body, { promotions: [] });
  });
});

Deno.test("GET /promotions/stack-check reaches the stack-check handler", async () => {
  await withEbayUnconfigured(async () => {
    const res = await app().request("/promotions/stack-check?margin_floor_pct=30");
    const body = await res.json();
    assert(body.error !== NOT_CONFIGURED, "served by GET /promotions/:promotionId");
    assertEquals(res.status, 200);
    assertEquals(body.margin_floor_pct, 30);
    assertEquals(body.breaching, []);
  });
});

Deno.test("GET /promotions/:promotionId still serves a real promotion id", async () => {
  await withEbayUnconfigured(async () => {
    const res = await app().request("/promotions/5012345678");
    assertEquals(res.status, 503);
    assertEquals((await res.json()).error, NOT_CONFIGURED);
  });
});
