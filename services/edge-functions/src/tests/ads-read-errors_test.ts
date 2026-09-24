// MP-11: a failed database read on the Ads tab is an error, never an empty
// answer. The overview, the discount stack check and the promotion performance
// each dropped their read's error, so an outage rendered as "no promoted
// listings", "no discount breaches" (the one warning that costs money) or a
// -100% lift. These DRIVE the routes with every PostgREST read failing.
//
//   deno test --allow-net --allow-env --allow-read src/tests/ads-read-errors_test.ts

import "./_env.ts";
import { assertEquals } from "@std/assert";

const OWNER = "11111111-1111-4111-8111-111111111111";
let failing = true;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes("/rest/v1/")) return realFetch(input, init);
  if (failing) {
    return Promise.resolve(
      json({ code: "XX000", message: "read failed", details: null, hint: null }, 500),
    );
  }
  return Promise.resolve(json([]));
}) as typeof fetch;
addEventListener("unload", () => {
  globalThis.fetch = realFetch;
});

const { Hono } = await import("hono");
const { flipdeskEbayRoutes } = await import("../routes/flipdesk-ebay-marketing.ts");

function app() {
  // deno-lint-ignore no-explicit-any
  const a = new Hono<any>();
  a.use("*", async (c, next) => {
    c.set("userId", OWNER);
    c.set("workspaceOwnerId", OWNER);
    c.set("workspaceRole", "owner");
    await next();
  });
  a.route("/", flipdeskEbayRoutes);
  return a;
}

for (const path of [
  "/marketing/promoted/overview",
  "/promotions/stack-check",
  "/promotions/performance",
]) {
  Deno.test(`MP-11: a failed read on GET ${path} is a 500, not an empty 200`, async () => {
    failing = true;
    const res = await app().request(path);
    await res.body?.cancel();
    assertEquals(res.status, 500);
  });

  Deno.test(`MP-11: GET ${path} still answers 200 when the reads succeed`, async () => {
    failing = false;
    const res = await app().request(path);
    await res.body?.cancel();
    assertEquals(res.status, 200);
  });
}
