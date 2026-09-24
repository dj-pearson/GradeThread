// eBay Developer Support ticket 260829-000039 (2026-09-25): the bare base scope
// `https://api.ebay.com/oauth/api_scope` is removed from our Authorization Code
// grant once sell.logistics is assigned, and stays available through the Client
// Credential grant. A consent URL that still asks for it fails the WHOLE consent
// screen, which blocks every connect and reconnect.
//
// So this pins three things at the wire, not at a helper:
//   1. the consent URL never carries the bare base scope, from the default list
//      OR from an EBAY_SCOPES override that still has it (an old pasted value);
//   2. the client_credentials app token still asks for it (Browse, Taxonomy,
//      Catalog, Metadata, Notification all run on that token);
//   3. a refresh never sends `scope` at all, so it cannot ask for it either;
// and keeps US-2160's gate: sell.logistics is requested only when EBAY_SCOPES
// carries it, and isLogisticsScopeAvailable() says the same.
//
//   deno test --allow-env --allow-net src/tests/ebay-user-consent-scope_test.ts

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  buildConsentUrl,
  EBAY_BASE_SCOPE,
  getAppAccessToken,
  isLogisticsScopeAvailable,
  refreshUserToken,
} from "../lib/ebay-client.ts";

const P = "https://api.ebay.com/oauth/api_scope";
const LOGISTICS = `${P}/sell.logistics`;

function withEnv<T>(vars: Record<string, string | null>, fn: () => T): T {
  const before = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    before.set(k, Deno.env.get(k));
    if (v === null) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

/** Async twin: the token calls read env AFTER their first await. */
async function withEnvAsync<T>(
  vars: Record<string, string | null>,
  fn: () => Promise<T>,
): Promise<T> {
  const before = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    before.set(k, Deno.env.get(k));
    if (v === null) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

const CONSENT_ENV = { EBAY_APP_ID: "test-app-id", EBAY_RU_NAME: "test-ru-name" };

function consentScopes(): string[] {
  const url = new URL(buildConsentUrl("state"));
  return (url.searchParams.get("scope") ?? "").split(/\s+/).filter(Boolean);
}

Deno.test("the base scope constant is the bare api_scope", () => {
  assertEquals(EBAY_BASE_SCOPE, P);
});

Deno.test("user consent (default list) does not request the bare base scope", () => {
  const scopes = withEnv({ ...CONSENT_ENV, EBAY_SCOPES: null }, consentScopes);
  assert(scopes.length >= 6, `only ${scopes.length} scopes; default not read`);
  assert(!scopes.includes(P), `consent still asks for ${P}: ${scopes.join(" ")}`);
  // Every remaining scope is a sub-scope, never the bare one in another spelling.
  for (const s of scopes) assert(s.startsWith(`${P}/`), `unexpected scope ${s}`);
});

Deno.test("an EBAY_SCOPES override that still carries the base scope is stripped", () => {
  const scopes = withEnv(
    {
      ...CONSENT_ENV,
      EBAY_SCOPES: `${P}  ${P}/sell.inventory ${P}/sell.fulfillment ${LOGISTICS}`,
    },
    consentScopes,
  );
  assertEquals(scopes, [
    `${P}/sell.inventory`,
    `${P}/sell.fulfillment`,
    LOGISTICS,
  ]);
});

Deno.test("sell.logistics is requested only when the logistics gate says so (US-2160)", () => {
  withEnv({ ...CONSENT_ENV, EBAY_SCOPES: null }, () => {
    assertEquals(isLogisticsScopeAvailable(), false);
    assert(!consentScopes().includes(LOGISTICS));
  });
  withEnv(
    { ...CONSENT_ENV, EBAY_SCOPES: `${P} ${P}/sell.inventory ${LOGISTICS}` },
    () => {
      assertEquals(isLogisticsScopeAvailable(), true);
      const scopes = consentScopes();
      assert(scopes.includes(LOGISTICS));
      assert(!scopes.includes(P));
    },
  );
});

/** Capture every request body sent to the eBay token endpoint. */
async function captureTokenBodies(
  fn: () => Promise<unknown>,
  respond: () => Response,
): Promise<URLSearchParams[]> {
  const realFetch = globalThis.fetch;
  const bodies: URLSearchParams[] = [];
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.includes("/identity/v1/oauth2/token")) {
      bodies.push(new URLSearchParams(String(init?.body ?? "")));
      return Promise.resolve(respond());
    }
    // Anything else (the shared token cache's store) fails; the cache treats
    // that as a miss and mints locally.
    return Promise.resolve(new Response("unavailable", { status: 503 }));
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
  return bodies;
}

Deno.test("the client_credentials app token still requests the base scope", async () => {
  const bodies = await withEnvAsync(
    { EBAY_APP_ID: "test-app-id", EBAY_CERT_ID: "test-cert-id", EBAY_ENV: "sandbox" },
    () =>
      captureTokenBodies(
        () => getAppAccessToken(),
        () => Response.json({ access_token: "app-token", expires_in: 7200 }),
      ),
  );
  assertEquals(bodies.length, 1);
  assertEquals(bodies[0]!.get("grant_type"), "client_credentials");
  assertEquals(bodies[0]!.get("scope"), P);
});

Deno.test("a user token refresh sends no scope, so it cannot request the base scope", async () => {
  const bodies = await withEnvAsync(
    { EBAY_APP_ID: "test-app-id", EBAY_CERT_ID: "test-cert-id", EBAY_ENV: "sandbox" },
    () =>
      captureTokenBodies(
        () => refreshUserToken("refresh-token-under-test"),
        () =>
          Response.json({
            access_token: "user-token",
            expires_in: 7200,
            token_type: "User Access Token",
          }),
      ),
  );
  assertEquals(bodies.length, 1);
  assertEquals(bodies[0]!.get("grant_type"), "refresh_token");
  assertEquals(bodies[0]!.has("scope"), false);
});
