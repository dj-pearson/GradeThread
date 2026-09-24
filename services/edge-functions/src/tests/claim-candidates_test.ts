// MP-09: the claim picker's candidate route and its ranking.
//
// The picker used to call a listings route that does not exist, so "Link to an
// item" always offered nothing. These drive GET /reviews/:id/candidates with a
// stubbed PostgREST layer and pin the ranking.
//
//   deno test --allow-net --allow-env --allow-read src/tests/claim-candidates_test.ts

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { rankClaimCandidates, titleSimilarity } from "../lib/claim-candidates.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const REVIEW = "22222222-2222-4222-8222-222222222222";
const urls: string[] = [];

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
  urls.push(decodeURIComponent(url));
  const wantsObject = (new Headers(init?.headers).get("Accept") ?? "").includes("object");
  if (url.includes("/rest/v1/marketplace_sync_reviews")) {
    // Only the owner's review exists.
    const mine = url.includes(`id=eq.${REVIEW}`) && url.includes(`user_id=eq.${OWNER}`);
    const row = { id: REVIEW, platform: "poshmark", title: "Blue denim jacket", sold_price_cents: 4000 };
    if (wantsObject) return Promise.resolve(mine ? json(row) : json(null));
    return Promise.resolve(json(mine ? [row] : []));
  }
  if (url.includes("/rest/v1/listings")) {
    return Promise.resolve(json([
      { id: "l-shirt", listing_title: "Red flannel shirt", listing_price: 40, inventory_item_id: "i1" },
      { id: "l-jacket", listing_title: "Blue denim jacket vintage", listing_price: 45, inventory_item_id: "i2" },
    ]));
  }
  if (url.includes("/rest/v1/item_photos")) {
    return Promise.resolve(json([{ inventory_item_id: "i2", photo_url: "https://x/p.jpg", thumbnail_url: null }]));
  }
  return Promise.resolve(json([]));
}) as typeof fetch;
addEventListener("unload", () => {
  globalThis.fetch = realFetch;
});

const { Hono } = await import("hono");
const { flipdeskSyncRoutes } = await import("../routes/flipdesk-sync.ts");

function app(userId: string) {
  // deno-lint-ignore no-explicit-any
  const a = new Hono<any>();
  a.use("*", async (c, next) => {
    c.set("userId", userId);
    c.set("workspaceOwnerId", userId);
    await next();
  });
  a.route("/", flipdeskSyncRoutes);
  return a;
}

Deno.test("MP-09: another seller's review id is a 404 and reads no listings", async () => {
  urls.length = 0;
  const res = await app("33333333-3333-4333-8333-333333333333").request(`/reviews/${REVIEW}/candidates`);
  await res.body?.cancel();
  assertEquals(res.status, 404);
  assertEquals(urls.filter((u) => u.includes("/rest/v1/listings")), []);
});

Deno.test("MP-09: the owner's candidates are same-platform, owner-scoped, unlinked and ranked", async () => {
  urls.length = 0;
  const res = await app(OWNER).request(`/reviews/${REVIEW}/candidates`);
  assertEquals(res.status, 200);
  const body = await res.json() as { candidates: Array<{ id: string; photo_url: string | null }> };
  assertEquals(body.candidates.map((c) => c.id), ["l-jacket", "l-shirt"]);
  assertEquals(body.candidates[0]!.photo_url, "https://x/p.jpg");
  const listingsQuery = urls.find((u) => u.includes("/rest/v1/listings"))!;
  assert(listingsQuery.includes(`inventory_items.user_id=eq.${OWNER}`), listingsQuery);
  assert(listingsQuery.includes("platform=eq.poshmark"), listingsQuery);
  assert(listingsQuery.includes("listing_status=eq.active"), listingsQuery);
  assert(listingsQuery.includes("listing_url=is.null"), listingsQuery);
});

Deno.test("rankClaimCandidates: title first, then price closeness", () => {
  const ranked = rankClaimCandidates("Nike running shoes", 5000, [
    { id: "a", listing_title: "Nike running shoes", listing_price: 80, photo_url: null },
    { id: "b", listing_title: "Nike running shoes", listing_price: 51, photo_url: null },
    { id: "c", listing_title: "Wool coat", listing_price: 50, photo_url: null },
  ]);
  assertEquals(ranked.map((r) => r.id), ["b", "a", "c"]);
  assertEquals(titleSimilarity("", "x y"), 0);
});
