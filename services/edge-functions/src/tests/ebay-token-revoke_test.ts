// US-364: revokeEbayUserToken — upstream token revocation on disconnect /
// account deletion. The function is best-effort: it NEVER throws and reports a
// status the caller logs but does not branch on for local deactivation.
//
// ebay-client.ts imports the service-role supabase client at load, so set dummy
// env BEFORE the dynamic import.
//
//   deno test --allow-env src/tests/ebay-token-revoke_test.ts
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);
// basicAuthHeader() needs these; revoke builds an Authorization header.
Deno.env.set("EBAY_APP_ID", Deno.env.get("EBAY_APP_ID") ?? "test-app-id");
Deno.env.set("EBAY_CERT_ID", Deno.env.get("EBAY_CERT_ID") ?? "test-cert-id");

const { revokeEbayUserToken } = await import("../lib/ebay-client.ts");

const realFetch = globalThis.fetch;
function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(
      handler(typeof input === "string" ? input : input.toString(), init),
    )) as typeof fetch;
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}

Deno.test("returns 'unsupported' and makes NO network call when EBAY_TOKEN_REVOKE_URL is unset", async () => {
  Deno.env.delete("EBAY_TOKEN_REVOKE_URL");
  let called = false;
  stubFetch(() => {
    called = true;
    return new Response(null, { status: 200 });
  });
  try {
    const result = await revokeEbayUserToken("tok");
    assertEquals(result, "unsupported");
    assert(!called, "fetch must not be called when revoke URL is unset");
  } finally {
    restoreFetch();
  }
});

Deno.test("returns 'revoked' on a 2xx from the revocation endpoint", async () => {
  Deno.env.set("EBAY_TOKEN_REVOKE_URL", "https://api.ebay.com/identity/v1/oauth2/revoke");
  let sentBody = "";
  stubFetch((_url, init) => {
    sentBody = String(init?.body ?? "");
    return new Response(null, { status: 200 });
  });
  try {
    const result = await revokeEbayUserToken("my-refresh-token", "refresh_token");
    assertEquals(result, "revoked");
    assert(sentBody.includes("my-refresh-token"), "token must be sent in the body");
    assert(sentBody.includes("token_type_hint=refresh_token"));
  } finally {
    restoreFetch();
    Deno.env.delete("EBAY_TOKEN_REVOKE_URL");
  }
});

Deno.test("maps 404/501 to 'unsupported' (keyset does not expose the endpoint)", async () => {
  Deno.env.set("EBAY_TOKEN_REVOKE_URL", "https://api.ebay.com/identity/v1/oauth2/revoke");
  try {
    stubFetch(() => new Response(null, { status: 404 }));
    assertEquals(await revokeEbayUserToken("tok"), "unsupported");
    stubFetch(() => new Response(null, { status: 501 }));
    assertEquals(await revokeEbayUserToken("tok"), "unsupported");
  } finally {
    restoreFetch();
    Deno.env.delete("EBAY_TOKEN_REVOKE_URL");
  }
});

Deno.test("returns 'failed' (never throws) on a 5xx or a network error", async () => {
  Deno.env.set("EBAY_TOKEN_REVOKE_URL", "https://api.ebay.com/identity/v1/oauth2/revoke");
  try {
    stubFetch(() => new Response("boom", { status: 500 }));
    assertEquals(await revokeEbayUserToken("tok"), "failed");
    globalThis.fetch = (() => Promise.reject(new Error("network down"))) as typeof fetch;
    assertEquals(await revokeEbayUserToken("tok"), "failed");
  } finally {
    restoreFetch();
    Deno.env.delete("EBAY_TOKEN_REVOKE_URL");
  }
});
