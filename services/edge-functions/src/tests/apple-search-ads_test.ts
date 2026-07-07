// US-1707: Apple Search Ads — ES256 client-secret JWT shaping, token-request
// body, and report/structure row mapping (mocked; no live call).
import { assert, assertEquals } from "@std/assert";
import {
  accessTokenRequestBody,
  type AppleSearchAdsConfig,
  appleSearchAdsConfig,
  buildClientSecretJWT,
  isAppleSearchAdsConfigured,
} from "../lib/apple-search-ads-client.ts";
import {
  amountToMicros,
  mapAppleCampaign,
  mapAppleReportRow,
} from "../lib/apple-search-ads-sync.ts";

// Generate a real ES256 key so the JWT actually signs, then decode it.
async function testConfig(): Promise<AppleSearchAdsConfig> {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  let bin = "";
  for (const b of pkcs8) bin += String.fromCharCode(b);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(bin)}\n-----END PRIVATE KEY-----`;
  return { orgId: "111", keyId: "KEY123", clientId: "CLIENT.ABC", teamId: "TEAM.ABC", privateKey: pem };
}

function decodeSegment(seg: string): Record<string, unknown> {
  const b64 = seg.replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
}

Deno.test("buildClientSecretJWT shapes an ES256 header + client-credentials claims", async () => {
  const cfg = await testConfig();
  const jwt = await buildClientSecretJWT(cfg, 1_800_000_000, 3600);
  const [h, p, sig] = jwt.split(".");
  assert(sig && sig.length > 0);
  const header = decodeSegment(h);
  assertEquals(header.alg, "ES256");
  assertEquals(header.kid, "KEY123");
  const claims = decodeSegment(p);
  assertEquals(claims.sub, "CLIENT.ABC");
  assertEquals(claims.iss, "TEAM.ABC");
  assertEquals(claims.aud, "https://appleid.apple.com");
  assertEquals(claims.iat, 1_800_000_000);
  assertEquals(claims.exp, 1_800_003_600);
});

Deno.test("accessTokenRequestBody is a client_credentials grant with the JWT secret", () => {
  const body = accessTokenRequestBody(
    { orgId: "1", keyId: "k", clientId: "cid", teamId: "tid", privateKey: "" },
    "the.jwt.here",
  );
  assertEquals(body.get("grant_type"), "client_credentials");
  assertEquals(body.get("client_id"), "cid");
  assertEquals(body.get("client_secret"), "the.jwt.here");
  assertEquals(body.get("scope"), "searchadsorg");
});

Deno.test("appleSearchAdsConfig returns null when a secret is unset (no throw)", () => {
  const keys = ["APPLE_SEARCH_ADS_ORG_ID", "APPLE_SEARCH_ADS_KEY_ID", "APPLE_SEARCH_ADS_CLIENT_ID", "APPLE_SEARCH_ADS_PRIVATE_KEY"];
  const saved = keys.map((k) => [k, Deno.env.get(k)] as const);
  try {
    for (const k of keys) Deno.env.delete(k);
    assertEquals(appleSearchAdsConfig(), null);
    assertEquals(isAppleSearchAdsConfigured(), false);
  } finally {
    for (const [k, v] of saved) v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
  }
});

Deno.test("amountToMicros converts a decimal amount", () => {
  assertEquals(amountToMicros("12.50"), 12_500_000);
  assertEquals(amountToMicros(3), 3_000_000);
  assertEquals(amountToMicros("nope"), 0);
});

Deno.test("mapAppleCampaign maps id/name/status + budget micros", () => {
  const c = mapAppleCampaign({ id: 555, name: "iOS UA", status: "ENABLED", budgetAmount: { amount: "1000" } }, "owner-1");
  assertEquals(c.platform, "apple_search_ads");
  assertEquals(c.external_id, "555");
  assertEquals(c.budget_micros, 1_000_000_000);
});

Deno.test("mapAppleReportRow flattens the daily granularity into metric rows", () => {
  const rows = mapAppleReportRow({
    metadata: { campaignId: 555 },
    granularity: [
      { date: "2026-07-01", localSpend: { amount: "50.00" }, impressions: 1000, taps: 40, totalInstalls: 5 },
      { date: "2026-07-02", localSpend: { amount: "25.00" }, impressions: 500, taps: 20, totalInstalls: 2 },
    ],
  }, "owner-1");
  assertEquals(rows.length, 2);
  assertEquals(rows[0].entity_type, "campaign");
  assertEquals(rows[0].entity_id, "555");
  assertEquals(rows[0].metric_date, "2026-07-01");
  assertEquals(rows[0].cost_micros, 50_000_000);
  assertEquals(rows[0].clicks, 40);
  assertEquals(rows[0].conversions, 5);
});
