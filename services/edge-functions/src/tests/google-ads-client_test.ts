// US-1697: Google Ads client — token-request shaping + GAQL request/response
// parsing + error classification, all with a MOCKED fetch (no live Google call).
import { assert, assertEquals } from "@std/assert";
import {
  accessTokenRequestBody,
  checkAdsConnection,
  gaqlHeaders,
  gaqlSearchUrl,
  GoogleAdsError,
  googleAdsConfig,
  isGoogleAdsConfigured,
  mintGoogleAdsAccessToken,
  normalizeCustomerId,
  runGaql,
  type GoogleAdsConfig,
} from "../lib/google-ads-client.ts";

const CONFIG: GoogleAdsConfig = {
  developerToken: "dev-token",
  clientId: "cid",
  clientSecret: "secret",
  refreshToken: "refresh",
  loginCustomerId: "1234567890",
  customerId: "9876543210",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// A mock fetch that records the last call and returns a scripted response.
function mockFetch(responder: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return Promise.resolve(responder(url, init));
  }) as typeof fetch;
  return { fn, calls };
}

Deno.test("normalizeCustomerId strips non-digits", () => {
  assertEquals(normalizeCustomerId("123-456-7890"), "1234567890");
  assertEquals(normalizeCustomerId(" 12 34 "), "1234");
});

Deno.test("googleAdsConfig returns null when any secret is unset (no throw)", () => {
  const keys = [
    "GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET",
    "GOOGLE_ADS_REFRESH_TOKEN", "GOOGLE_ADS_LOGIN_CUSTOMER_ID", "GOOGLE_ADS_CUSTOMER_ID",
  ];
  const saved = keys.map((k) => [k, Deno.env.get(k)] as const);
  try {
    for (const k of keys) Deno.env.delete(k);
    assertEquals(googleAdsConfig(), null);
    assertEquals(isGoogleAdsConfigured(), false);
    // Set all but one → still null.
    for (const k of keys) Deno.env.set(k, "x");
    Deno.env.delete("GOOGLE_ADS_CUSTOMER_ID");
    assertEquals(googleAdsConfig(), null);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
});

Deno.test("accessTokenRequestBody shapes a refresh_token grant", () => {
  const body = accessTokenRequestBody(CONFIG);
  assertEquals(body.get("grant_type"), "refresh_token");
  assertEquals(body.get("client_id"), "cid");
  assertEquals(body.get("client_secret"), "secret");
  assertEquals(body.get("refresh_token"), "refresh");
});

Deno.test("mintGoogleAdsAccessToken posts the grant + returns the token", async () => {
  const { fn, calls } = mockFetch(() => jsonResponse({ access_token: "ya29.tok", expires_in: 3600 }));
  const token = await mintGoogleAdsAccessToken(CONFIG, fn);
  assertEquals(token, "ya29.tok");
  assertEquals(calls.length, 1);
  assert(calls[0].url.includes("oauth2.googleapis.com/token"));
  assertEquals(calls[0].init?.method, "POST");
  const sentBody = String(calls[0].init?.body);
  assert(sentBody.includes("grant_type=refresh_token"));
  assert(sentBody.includes("refresh_token=refresh"));
});

Deno.test("mintGoogleAdsAccessToken maps invalid_grant to a re-auth error", async () => {
  const { fn } = mockFetch(() => jsonResponse({ error: "invalid_grant" }, 400));
  try {
    await mintGoogleAdsAccessToken(CONFIG, fn);
    throw new Error("expected throw");
  } catch (err) {
    assert(err instanceof GoogleAdsError);
    assertEquals((err as GoogleAdsError).kind, "unauthorized");
    assert((err as GoogleAdsError).message.toLowerCase().includes("re-authorize"));
  }
});

Deno.test("gaqlSearchUrl + gaqlHeaders shape the versioned search request", () => {
  assert(gaqlSearchUrl(CONFIG).includes("/customers/9876543210/googleAds:search"));
  const h = gaqlHeaders(CONFIG, "tok");
  assertEquals(h["Authorization"], "Bearer tok");
  assertEquals(h["developer-token"], "dev-token");
  assertEquals(h["login-customer-id"], "1234567890");
});

Deno.test("runGaql sends the query + parses results, following pagination", async () => {
  let call = 0;
  const { fn, calls } = mockFetch(() => {
    call++;
    return call === 1
      ? jsonResponse({ results: [{ customer: { descriptiveName: "A" } }], nextPageToken: "p2" })
      : jsonResponse({ results: [{ customer: { descriptiveName: "B" } }] });
  });
  const rows = await runGaql(CONFIG, "tok", "SELECT customer.descriptive_name FROM customer", fn);
  assertEquals(rows.length, 2);
  assertEquals(calls.length, 2);
  // First body carries the query; second carries the pageToken.
  assert(String(calls[0].init?.body).includes("SELECT customer.descriptive_name"));
  assert(String(calls[1].init?.body).includes("p2"));
});

Deno.test("runGaql classifies an unapproved developer token", async () => {
  const { fn } = mockFetch(() =>
    jsonResponse({ error: { details: [{ errors: [{ errorCode: "DEVELOPER_TOKEN_NOT_APPROVED" }] }] } }, 403)
  );
  try {
    await runGaql(CONFIG, "tok", "SELECT customer.id FROM customer", fn);
    throw new Error("expected throw");
  } catch (err) {
    assert(err instanceof GoogleAdsError);
    assertEquals((err as GoogleAdsError).kind, "developer_token");
    assert((err as GoogleAdsError).message.includes("Basic Access"));
  }
});

Deno.test("checkAdsConnection returns configured:false when unset (no throw)", async () => {
  const keys = [
    "GOOGLE_ADS_DEVELOPER_TOKEN", "GOOGLE_ADS_CLIENT_ID", "GOOGLE_ADS_CLIENT_SECRET",
    "GOOGLE_ADS_REFRESH_TOKEN", "GOOGLE_ADS_LOGIN_CUSTOMER_ID", "GOOGLE_ADS_CUSTOMER_ID",
  ];
  const saved = keys.map((k) => [k, Deno.env.get(k)] as const);
  try {
    for (const k of keys) Deno.env.delete(k);
    const status = await checkAdsConnection();
    assertEquals(status.ok, false);
    if (!status.ok) assertEquals(status.configured, false);
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
});
