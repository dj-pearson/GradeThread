// MP-01: attaching or reshaping a marketplace connection is admin-only.
//
// GET /oauth/start (eBay and Shopify) skips blockViewerWrites because it is a
// GET, so before this a viewer could attach their own eBay account to the
// owner's tenant. The policy, location and program writes had no role check at
// all, so any member could create live buyer-facing policies or opt the owner
// out of a program.
//
// These DRIVE the routers with a stubbed PostgREST layer and a stand-in for
// workspaceMiddleware, and assert the role outcome only: below admin is a 403
// carrying the admin-only line; admin is never that 403.
//
//   deno test --allow-net --allow-env --allow-read src/tests/marketplace-admin-guard_test.ts

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";

Deno.env.set("EBAY_APP_ID", Deno.env.get("EBAY_APP_ID") ?? "test-app");
Deno.env.set("EBAY_CERT_ID", Deno.env.get("EBAY_CERT_ID") ?? "test-cert");
Deno.env.set("EBAY_RU_NAME", Deno.env.get("EBAY_RU_NAME") ?? "test-ru");
Deno.env.set("SHOPIFY_API_KEY", Deno.env.get("SHOPIFY_API_KEY") ?? "test-key");
Deno.env.set("SHOPIFY_API_SECRET", Deno.env.get("SHOPIFY_API_SECRET") ?? "test-secret");

const OWNER = "11111111-1111-4111-8111-111111111111";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: Request | URL | string, _init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("/rest/v1/")) return Promise.resolve(json([]));
  // Anything reaching eBay or Shopify fails; the admin cases only need to get
  // past the guard, not to succeed.
  return Promise.resolve(json({ errors: [{ message: "stubbed" }] }, 500));
}) as typeof fetch;
addEventListener("unload", () => {
  globalThis.fetch = realFetch;
});

const { Hono } = await import("hono");
const { flipdeskEbayRoutes: oauthRoutes } = await import("../routes/flipdesk-ebay-oauth.ts");
const { flipdeskEbayRoutes: policyRoutes } = await import("../routes/flipdesk-ebay-policies.ts");
const { flipdeskShopifyRoutes } = await import("../routes/flipdesk-shopify.ts");
const { MARKETPLACE_ADMIN_ONLY } = await import("../lib/marketplace-admin-guard.ts");

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
  app.route("/ebay", oauthRoutes);
  app.route("/ebay", policyRoutes);
  app.route("/shopify", flipdeskShopifyRoutes);
  return app;
}

const body = JSON.stringify({ postal_code: "10001", handling_days: 1 });
const CASES: Array<[string, string]> = [
  ["GET", "/ebay/oauth/start"],
  ["GET", "/shopify/oauth/start?shop=my-store.myshopify.com"],
  ["PUT", "/ebay/policies/default"],
  ["POST", "/ebay/policies/sync"],
  ["POST", "/ebay/policies/create"],
  ["POST", "/ebay/policies/location"],
  ["POST", "/ebay/programs/out-of-stock"],
  ["DELETE", "/ebay/programs/out-of-stock"],
];

async function call(role: Role, method: string, path: string) {
  const res = await appAs(role).request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "GET" || method === "DELETE" ? undefined : body,
  });
  const text = await res.text();
  let error: string | undefined;
  try {
    error = (JSON.parse(text) as { error?: string }).error;
  } catch { /* not JSON */ }
  return { status: res.status, error };
}

for (const role of ["viewer", "member", "listing_manager"] as const) {
  Deno.test(`MP-01: a ${role} gets 403 on every connection and policy write`, async () => {
    for (const [method, path] of CASES) {
      const r = await call(role, method, path);
      assertEquals(r.status, 403, `${role} ${method} ${path}`);
      assertEquals(r.error, MARKETPLACE_ADMIN_ONLY, `${role} ${method} ${path}`);
    }
  });
}

for (const role of ["admin", "owner"] as const) {
  Deno.test(`MP-01: an ${role} passes the connection guard`, async () => {
    for (const [method, path] of CASES) {
      const r = await call(role, method, path);
      assert(
        r.error !== MARKETPLACE_ADMIN_ONLY,
        `${role} ${method} ${path} must not be refused by the admin guard`,
      );
    }
  });
}
