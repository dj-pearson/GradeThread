// US-2325 AC4: the configured eBay category tree id is checked against eBay's.
//
// getCategoryTreeId() reads EBAY_CATEGORY_TREE_ID and falls back to "0", and
// eight call sites depend on it — category suggestion, aspect metadata, the
// lot. eBay versions its taxonomy per marketplace, so a bump silently points
// every one of them at a stale tree. Aspects are cached for 30 days, so the
// wrong answers stay warm for up to a month before anything looks different.
//
// The reconcile REPORTS rather than self-heals, so what these tests pin is the
// reporting: agreement, drift, and — the one that actually matters — the
// difference between "they agree" and "we could not ask".

import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { reconcileCategoryTreeId } from "../lib/ebay-client.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.test("US-2325: agreement is reported as checked and matching", async () => {
  const r = await reconcileCategoryTreeId({
    configured: "0",
    marketplaceId: "EBAY_US",
    doFetch: () => Promise.resolve(jsonResponse({ categoryTreeId: "0" })),
  });
  assertEquals(r.matches, true);
  assertEquals(r.checked, true);
  assertEquals(r.actual, "0");
});

Deno.test("US-2325: a tree bump is reported as drift, with both ids", async () => {
  const r = await reconcileCategoryTreeId({
    configured: "0",
    marketplaceId: "EBAY_US",
    doFetch: () => Promise.resolve(jsonResponse({ categoryTreeId: "15" })),
  });
  assertEquals(r.matches, false);
  assertEquals(r.checked, true);
  assertEquals(r.actual, "15");
  // The operator has to be able to act on this without opening the code.
  assert(r.detail.includes("0"));
  assert(r.detail.includes("15"));
});

Deno.test("US-2325: an unreachable eBay is NOT reported as agreement", async () => {
  // The load-bearing case. A reconcile that answers "matches" when it could not
  // ask is worse than no reconcile: it converts an unknown into a reassurance,
  // which is the same failure shape as a timeout that silently stops timing.
  for (
    const [label, doFetch] of [
      ["HTTP 500", () => Promise.resolve(jsonResponse({}, 500))],
      ["network throw", () => Promise.reject(new Error("ECONNRESET"))],
      ["no id in body", () => Promise.resolve(jsonResponse({ other: "x" }))],
    ] as const
  ) {
    const r = await reconcileCategoryTreeId({
      configured: "0",
      marketplaceId: "EBAY_US",
      doFetch: doFetch as () => Promise<Response>,
    });
    assertEquals(r.checked, false, `${label} should report checked:false`);
    assertEquals(r.matches, false, `${label} must never report matches:true`);
    assertEquals(r.actual, null, `${label} should carry no actual id`);
    assert(r.detail.length > 0, `${label} should say why`);
  }
});

Deno.test("US-2325: the marketplace is part of the question", async () => {
  // Tree ids are per marketplace, so asking without one would compare a US
  // configuration against whatever eBay defaulted to.
  let seen = "";
  await reconcileCategoryTreeId({
    configured: "3",
    marketplaceId: "EBAY_GB",
    doFetch: (url: string) => {
      seen = url;
      return Promise.resolve(jsonResponse({ categoryTreeId: "3" }));
    },
  });
  assert(
    seen.includes("marketplace_id=EBAY_GB"),
    `marketplace not sent: ${seen}`,
  );
  assert(seen.includes("get_default_category_tree_id"), `wrong endpoint: ${seen}`);
});
