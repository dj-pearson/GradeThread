// The eBay router's route table, pinned.
//
// routes/flipdesk-ebay.ts used to declare all of its routes itself. They now
// live in flipdesk-ebay-*.ts, one file per concern, and flipdesk-ebay.ts only
// mounts those routers. The split was a pure move, and this file is what keeps
// it one:
//
//   1. the mounted router serves exactly the method + path set below, which was
//      read off the router BEFORE the split (124 routes);
//   2. Hono runs the first matching handler, so any two routes that can match
//      the same request must stay in the order they were registered in then;
//   3. every flipdesk-ebay-*.ts router is mounted, and each route is declared in
//      exactly one file (route-shadowing_test.ts checks one file at a time, so a
//      duplicate across two of these files would get past it).
//
// Adding or removing an eBay route means editing EXPECTED_ROUTES in the same
// commit. That is deliberate: it is the only place the whole eBay surface is
// listed, and a route that vanishes in a refactor should fail here, not in prod.
//
// Run: deno test --allow-env --allow-read src/tests/ebay-route-inventory_test.ts
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import { flipdeskEbayRoutes } from "../routes/flipdesk-ebay.ts";

// Registration order as it was before the split. Only the order of pairs that
// can match the same request matters (test 2); the rest is kept for reading.
const EXPECTED_ROUTES = [
  "GET /oauth/debug",
  "GET /oauth/start",
  "GET /oauth/callback",
  "POST /disconnect",
  "POST /oauth/refresh",
  "POST /sync/performance",
  "POST /sync/performance/me",
  "GET /analytics/account-health",
  "GET /compliance/summary",
  "GET /compliance/violations",
  "POST /compliance/sync",
  "POST /compliance/apply-recommendations/:id",
  "GET /finances/payouts",
  "GET /finances/payouts/:payoutId/sales",
  "GET /catalog/match",
  "POST /catalog/adopt",
  "GET /promotions",
  "GET /promotions/:promotionId",
  "POST /promotions",
  "PUT /promotions/:promotionId",
  "DELETE /promotions/:promotionId",
  "GET /policies",
  "POST /policies/sync",
  "PUT /policies/default",
  "POST /policies/create",
  "POST /policies/location",
  "GET /category/suggest",
  "GET /category/:id/aspects",
  "GET /category/:id/conditions",
  "POST /aspects/write-back",
  "POST /category/:id/derive-aspects",
  "POST /listings/pull",
  "GET /sync-runs",
  "GET /returns",
  "POST /returns/:returnId/decide",
  "POST /returns/:returnId/refund",
  "GET /inquiries",
  "POST /inquiries/:inquiryId/shipment",
  "POST /inquiries/:inquiryId/refund",
  "POST /inquiries/:inquiryId/close",
  "GET /cases",
  "POST /cases/:caseId/shipment",
  "POST /cases/:caseId/refund",
  "GET /negotiation/threshold-conflicts",
  "POST /negotiation/threshold-conflicts/reconcile",
  "GET /marketing/email-campaigns",
  "POST /marketing/email-campaigns",
  "POST /marketing/email-campaigns/:id/send",
  "GET /marketing/email-campaigns/:id/report",
  "GET /finances/ad-spend",
  "POST /promotions/markdown-dry-run",
  "GET /promotions/performance",
  "POST /promotions/sync",
  "GET /promotions/stack-check",
  "GET /marketing/suggestions",
  "POST /marketing/campaign/:action",
  "POST /marketing/ads/bulk",
  "GET /marketing/keywords",
  "GET /marketing/keywords/suggestions",
  "POST /marketing/keywords",
  "PATCH /marketing/keywords/:keywordId",
  "POST /marketing/negative-keywords",
  "GET /negotiation/analytics",
  "POST /negotiation/rule-dry-run",
  "POST /returns/rule-dry-run",
  "GET /post-sale/analytics",
  "POST /cases/:caseId/evidence",
  "POST /cases/:caseId/appeal",
  "POST /cases/:caseId/close",
  "POST /returns/:returnId/received",
  "POST /returns/:returnId/message",
  "GET /returns/:returnId/label",
  "POST /evidence/preview",
  "POST /returns/:returnId/evidence",
  "POST /orders/:orderId/refund",
  "GET /programs",
  "POST /programs/:program",
  "DELETE /programs/:program",
  "DELETE /offers/:offerId",
  "DELETE /inventory-items/:sku",
  "GET /cancellations",
  "POST /cancellations/:cancelId/approve",
  "POST /cancellations/:cancelId/reject",
  "POST /feedback",
  "POST /jobs/leave-feedback",
  "GET /payment-disputes",
  "GET /payment-disputes/:id",
  "POST /payment-disputes/:id/accept",
  "POST /payment-disputes/:id/contest",
  "GET /payment-disputes/:id/activity",
  "POST /payment-disputes/:id/evidence",
  "POST /listings/:id/price",
  "POST /listings/bulk-price-quantity",
  "POST /listings/bulk-edit",
  "POST /listings/:id/sale",
  "DELETE /listings/:id/sale",
  "GET /listings/:id/promotion",
  "POST /listings/:id/promotion",
  "DELETE /listings/:id/promotion",
  "POST /listings/:id/revise",
  "POST /listings/bulk-revise",
  "POST /orders/:saleId/ship",
  "GET /listings/:id/category-check",
  "DELETE /listings/:id",
  "POST /listings/validate",
  "POST /aspect-coverage",
  "GET /marketing/ad-rate-suggestion",
  "POST /marketing/promoted/sync",
  "GET /marketing/promoted/overview",
  "POST /listings/push",
  "POST /listings/:id/relist",
  "POST /jobs/publish-due",
  "POST /jobs/promoted-sync",
  "POST /payouts/import-csv",
  "GET /comps",
  "GET /negotiation/offers",
  "POST /negotiation/offers/:bestOfferId/respond",
  "GET /negotiation/capabilities",
  "GET /negotiation/eligible",
  "GET /negotiation/send-offer-today",
  "POST /negotiation/send-offer",
  "GET /messages",
  "POST /messages/:messageId/reply",
  "POST /listings/migrate",
];

const ROUTES_DIR = new URL("../routes/", import.meta.url);

function mounted(): string[] {
  return flipdeskEbayRoutes.routes.map((r) => `${r.method} ${r.path}`);
}

const segments = (p: string) => p.split("/").filter(Boolean);

/** Can one request match both routes? Same method, same depth, and every
 * segment either equal or a `:param` on one side. */
function canOverlap(a: string, b: string): boolean {
  const [ma, pa] = a.split(" ");
  const [mb, pb] = b.split(" ");
  if (ma !== mb && ma !== "ALL" && mb !== "ALL") return false;
  const x = segments(pa!);
  const y = segments(pb!);
  if (x.length !== y.length) return false;
  return x.every((s, i) => s === y[i] || s.startsWith(":") || y[i]!.startsWith(":"));
}

function overlappingPairs(routes: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      if (canOverlap(routes[i]!, routes[j]!)) out.push([routes[i]!, routes[j]!]);
    }
  }
  return out;
}

Deno.test("eBay router serves exactly the pre-split method + path set", () => {
  const got = mounted();
  const dupes = got.filter((r, i) => got.indexOf(r) !== i);
  assertEquals(dupes, [], "a method + path is registered twice; Hono only ever runs the first");
  const missing = EXPECTED_ROUTES.filter((r) => !got.includes(r));
  const extra = got.filter((r) => !EXPECTED_ROUTES.includes(r));
  assertEquals(missing, [], "routes that were served before the split are not mounted");
  assertEquals(
    extra,
    [],
    "routes mounted that EXPECTED_ROUTES does not list; add them there in the same commit",
  );
});

Deno.test("routes that can match the same request keep their pre-split order", () => {
  const got = mounted();
  const pairs = overlappingPairs(EXPECTED_ROUTES);
  // Guards the guard: an overlap detector that stopped matching would pass
  // with nothing to check. These two are the ones the table has today.
  assertEquals(pairs, [
    ["GET /promotions/:promotionId", "GET /promotions/performance"],
    ["GET /promotions/:promotionId", "GET /promotions/stack-check"],
  ]);
  for (const [first, second] of pairs) {
    assert(
      got.indexOf(first) < got.indexOf(second),
      `${first} must stay registered before ${second}: both match one request and ` +
        "Hono serves whichever came first",
    );
  }
});

Deno.test("canOverlap: literal, param and depth cases", () => {
  assert(canOverlap("GET /a/:id", "GET /a/b"));
  assert(!canOverlap("GET /a/:id", "POST /a/b"));
  assert(!canOverlap("GET /a/:id", "GET /a/b/c"));
  assert(!canOverlap("GET /a/x", "GET /a/y"));
});

Deno.test("every flipdesk-ebay-*.ts router is mounted and declares its own routes", async () => {
  const thin = await Deno.readTextFile(new URL("flipdesk-ebay.ts", ROUTES_DIR));
  const routeFiles: string[] = [];
  const declared = new Map<string, string[]>();
  for await (const e of Deno.readDir(ROUTES_DIR)) {
    if (!e.isFile || !/^flipdesk-ebay-.+\.ts$/.test(e.name)) continue;
    const src = await Deno.readTextFile(new URL(e.name, ROUTES_DIR));
    if (!/^export const flipdeskEbayRoutes = new Hono<EbayEnv>\(\);$/m.test(src)) continue;
    routeFiles.push(e.name);
    for (const m of src.matchAll(/^flipdeskEbayRoutes\.(get|post|put|patch|delete)\(\s*"([^"]+)"/gm)) {
      const key = `${m[1]!.toUpperCase()} ${m[2]}`;
      declared.set(key, [...(declared.get(key) ?? []), e.name]);
    }
  }
  assert(routeFiles.length >= 10, `expected the split route files, found ${routeFiles.length}`);

  // Mounted: imported under an alias AND passed to flipdeskEbayRoutes.route().
  const unmounted = routeFiles.filter((f) => {
    const imp = thin.match(
      new RegExp(`import \\{ flipdeskEbayRoutes as (\\w+) \\} from "\\./${f.replace(".", "\\.")}";`),
    );
    return !imp ||
      !new RegExp(`^flipdeskEbayRoutes\\.route\\("/", ${imp[1]}\\);$`, "m").test(thin);
  });
  assertEquals(unmounted, [], "route files flipdesk-ebay.ts does not mount");

  // The thin file declares nothing itself.
  assertEquals(
    [...thin.matchAll(/^flipdeskEbayRoutes\.(get|post|put|patch|delete)\(/gm)].length,
    0,
    "flipdesk-ebay.ts only mounts; declare the route in the flipdesk-ebay-*.ts file for its concern",
  );

  const twice = [...declared].filter(([, files]) => files.length > 1).map(([k, f]) => `${k}: ${f}`);
  assertEquals(twice, [], "one route declared in two eBay route files");
  assertEquals(
    [...declared.keys()].sort(),
    [...EXPECTED_ROUTES].sort(),
    "the text of the route files and the mounted router disagree",
  );
});
