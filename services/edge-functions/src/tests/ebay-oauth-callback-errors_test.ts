// MP-12: every eBay consent error other than a cancel comes back as one status
// the app words. Unknown codes (invalid_scope, server_error) used to be passed
// through raw, and the page had no message for them.
//
//   deno test --allow-net --allow-env --allow-read src/tests/ebay-oauth-callback-errors_test.ts

import "./_env.ts";
import { assert } from "@std/assert";

Deno.env.set("EBAY_APP_ID", Deno.env.get("EBAY_APP_ID") ?? "test-app");
Deno.env.set("EBAY_CERT_ID", Deno.env.get("EBAY_CERT_ID") ?? "test-cert");
Deno.env.set("EBAY_RU_NAME", Deno.env.get("EBAY_RU_NAME") ?? "test-ru");

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.includes("/rest/v1/")) {
    return Promise.resolve(new Response("null", { status: 200, headers: { "Content-Type": "application/json" } }));
  }
  return realFetch(input, init);
}) as typeof fetch;
addEventListener("unload", () => {
  globalThis.fetch = realFetch;
});

const { Hono } = await import("hono");
const { flipdeskEbayRoutes } = await import("../routes/flipdesk-ebay-oauth.ts");

function app() {
  // deno-lint-ignore no-explicit-any
  const a = new Hono<any>();
  a.route("/", flipdeskEbayRoutes);
  return a;
}

for (const [code, expected] of [
  ["access_denied", "ebay=cancelled"],
  ["invalid_scope", "ebay=provider_error"],
  ["server_error", "ebay=provider_error"],
]) {
  Deno.test(`MP-12: consent error ${code} redirects with ${expected}`, async () => {
    const res = await app().request(`/oauth/callback?error=${code}`);
    await res.body?.cancel();
    const location = res.headers.get("location") ?? "";
    assert(location.includes(expected), location);
  });
}
