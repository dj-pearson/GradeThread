// MP-03: opening the Ads tab must never create a cost-per-click campaign.
//
// GET /marketing/suggestions, GET /marketing/keywords and
// GET /marketing/keywords/suggestions used ensureCpcCampaign, which POSTs a new
// COST_PER_CLICK campaign to eBay whenever none is cached. So viewing the tab,
// even as a viewer, started a campaign, and ending one was undone seconds later
// by the card's own refetch. These DRIVE the routes with eBay and PostgREST
// stubbed, and count the POSTs that reach eBay's ad_campaign endpoint.
//
//   deno test --allow-net --allow-env --allow-read src/tests/ebay-cpc-find_test.ts

import "./_env.ts";
import { assertEquals } from "@std/assert";

Deno.env.set("EBAY_APP_ID", Deno.env.get("EBAY_APP_ID") ?? "test-app");
Deno.env.set("EBAY_CERT_ID", Deno.env.get("EBAY_CERT_ID") ?? "test-cert");
Deno.env.set("EBAY_RU_NAME", Deno.env.get("EBAY_RU_NAME") ?? "test-ru");
if (!Deno.env.get("EDGE_ENCRYPTION_KEY")) {
  Deno.env.set("EDGE_ENCRYPTION_KEY", btoa(String.fromCharCode(...new Uint8Array(32).fill(7))));
}

const OWNER = "11111111-1111-4111-8111-111111111111";
const { encryptToken } = await import("../lib/crypto-aes.ts");
const ACCESS = await encryptToken("user-token", { aad: OWNER });

// What the stubbed world holds.
let cachedCampaign: string | null = null;
let ebayCampaigns: Array<{ campaignId: string; campaignName: string; campaignStatus: string }> = [];
let adCampaignPosts = 0;
let connectionUpdates: unknown[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const realFetch = globalThis.fetch;
function handle(input: Request | URL | string, init?: RequestInit): Response {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (url.includes("/rest/v1/marketplace_connections")) {
    if (method === "PATCH") {
      connectionUpdates.push(init?.body ? JSON.parse(String(init.body)) : null);
      const body = connectionUpdates.at(-1) as Record<string, unknown> | null;
      if (body && "ebay_cpc_campaign_id" in body) {
        cachedCampaign = body.ebay_cpc_campaign_id as string | null;
      }
      return json([]);
    }
    const row = {
      id: "conn-1",
      access_token_encrypted: ACCESS,
      refresh_token_encrypted: ACCESS,
      token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      account_handle: "seller",
      external_account_id: "ext",
      ebay_cpc_campaign_id: cachedCampaign,
      ebay_cpc_ad_group_id: cachedCampaign ? "group-1" : null,
    };
    const wantsObject = (new Headers(init?.headers).get("Accept") ?? "").includes("object");
    return json(wantsObject ? row : [row]);
  }
  if (url.includes("/rest/v1/")) return json([]);
  if (url.includes("/sell/marketing/v1/ad_campaign")) {
    if (method === "POST" && /\/ad_campaign(\?|$)/.test(url)) {
      adCampaignPosts++;
      return json({ campaignId: "new-campaign" }, 201);
    }
    if (method === "POST" && url.includes("/end")) return new Response(null, { status: 204 });
    if (url.includes("/ad_group")) return json({ adGroups: [] });
    if (url.includes("campaign_name=")) return json({ campaigns: ebayCampaigns });
    return json({});
  }
  // Suggestions, keywords, search terms: nothing to report.
  return json({});
}
globalThis.fetch = ((input: Request | URL | string, init?: RequestInit) =>
  Promise.resolve(handle(input, init))) as typeof fetch;
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

function reset() {
  cachedCampaign = null;
  ebayCampaigns = [];
  adCampaignPosts = 0;
  connectionUpdates = [];
}

for (const path of ["/marketing/suggestions", "/marketing/keywords", "/marketing/keywords/suggestions"]) {
  Deno.test(`MP-03: GET ${path} with no campaign creates nothing and says campaign:null`, async () => {
    reset();
    const res = await app().request(path);
    const body = await res.json() as { campaign?: unknown };
    assertEquals(res.status, 200);
    assertEquals(body.campaign, null);
    assertEquals(adCampaignPosts, 0, "a read must not POST a campaign to eBay");
  });
}

Deno.test("MP-03: after End, the next GET reports campaign:null instead of recreating one", async () => {
  reset();
  cachedCampaign = "live-campaign";
  const end = await app().request("/marketing/campaign/end", { method: "POST", body: "{}" });
  await end.body?.cancel();
  assertEquals(end.status, 200);
  assertEquals(cachedCampaign, null, "ending clears the cached id");
  // eBay now lists the ended campaign by name; the find must skip it.
  ebayCampaigns = [
    { campaignId: "live-campaign", campaignName: "FlipDesk Priority (CPC)", campaignStatus: "ENDED" },
  ];
  const res = await app().request("/marketing/suggestions");
  const body = await res.json() as { campaign?: unknown };
  assertEquals(body.campaign, null);
  assertEquals(adCampaignPosts, 0);
});

Deno.test("MP-03: pause with no campaign is a 404, not a new campaign", async () => {
  reset();
  const res = await app().request("/marketing/campaign/pause", { method: "POST", body: "{}" });
  await res.body?.cancel();
  assertEquals(res.status, 404);
  assertEquals(adCampaignPosts, 0);
});

Deno.test("MP-03: start is the one action that creates a campaign", async () => {
  reset();
  const res = await app().request("/marketing/campaign/start", { method: "POST", body: "{}" });
  await res.body?.cancel();
  assertEquals(adCampaignPosts, 1);
});
