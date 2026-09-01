// US-3042: the eBay call counter's judgement, tested without eBay or a database.
//
// The three pure functions here decide what a row in ebay_api_call_daily MEANS.
// normalizeEbayEndpoint in particular is load-bearing in a way that is easy to
// miss: it is the only thing keeping a daily rollup from becoming an unbounded
// event log, and a regression in it would show up as a slowly growing table
// rather than as a failure.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  classifyEbayApi,
  normalizeEbayEndpoint,
  statusClassOf,
  utcDay,
} from "../lib/ebay-call-log.ts";

const HOST = "https://api.ebay.com";

Deno.test("classifyEbayApi: every family we actually call is recognised", () => {
  const cases: Array<[string, string]> = [
    [`${HOST}/sell/inventory/v1/inventory_item/ABC-123`, "inventory"],
    [`${HOST}/sell/inventory/v1/offer`, "inventory"],
    [`${HOST}/sell/fulfillment/v1/order?limit=50`, "fulfillment"],
    [`${HOST}/sell/account/v1/fulfillment_policy`, "account"],
    [`${HOST}/sell/finances/v1/payout`, "finances"],
    [`${HOST}/sell/marketing/v1/ad_campaign`, "marketing"],
    [`${HOST}/sell/compliance/v1/listing_violation`, "compliance"],
    [`${HOST}/sell/logistics/v1/shipping_quote`, "logistics"],
    [`${HOST}/sell/feed/v1/order_task`, "feed"],
    [`${HOST}/buy/browse/v1/item_summary/search?q=patagonia`, "browse"],
    [`${HOST}/buy/marketplace_insights/v1_beta/item_sales/search`, "insights"],
    [`${HOST}/commerce/taxonomy/v1/category_tree/0`, "taxonomy"],
    [`${HOST}/commerce/notification/v1/destination`, "notification"],
    [`${HOST}/post-order/v2/return/5001`, "postorder"],
    [`${HOST}/developer/analytics/v1_beta/rate_limit/`, "analytics"],
    [`${HOST}/identity/v1/oauth2/token`, "oauth"],
    [`${HOST}/ws/api.dll`, "trading"],
  ];
  for (const [url, family] of cases) {
    assertEquals(classifyEbayApi(url), family, url);
  }
});

Deno.test("classifyEbayApi: an unknown path is counted, not dropped", () => {
  // The bucket exists so a newly added API shows up as an anomaly in the rollup
  // instead of vanishing. Silently losing calls is the failure this prevents.
  assertEquals(classifyEbayApi(`${HOST}/sell/somethingnew/v1/thing`), "other");
  assertEquals(classifyEbayApi("not a url at all"), "other");
  assertEquals(classifyEbayApi(""), "other");
});

Deno.test("normalizeEbayEndpoint: ids are templated away", () => {
  // THE PROPERTY THE TABLE'S SIZE DEPENDS ON. Two calls that differ only by
  // which item they touched must produce the SAME endpoint string.
  const a = normalizeEbayEndpoint(`${HOST}/sell/inventory/v1/offer/8123456789`);
  const b = normalizeEbayEndpoint(`${HOST}/sell/inventory/v1/offer/9987654321`);
  assertEquals(a, b);
  assertEquals(a, "/sell/inventory/v1/offer/{id}");

  // UUIDs, seller SKUs and eBay order ids all count as ids.
  assertEquals(
    normalizeEbayEndpoint(
      `${HOST}/sell/fulfillment/v1/order/12-34567-89012`,
    ),
    "/sell/fulfillment/v1/order/{id}",
  );
  assertEquals(
    normalizeEbayEndpoint(
      `${HOST}/sell/inventory/v1/inventory_item/3f2504e0-4f89-11d3-9a0c-0305e82c3301`,
    ),
    "/sell/inventory/v1/inventory_item/{id}",
  );
});

Deno.test("normalizeEbayEndpoint: version segments are NOT ids", () => {
  // v1 and v1_beta contain a digit. Templating them would collapse every
  // version of every API into one row and make a future v2 invisible.
  assertEquals(
    normalizeEbayEndpoint(`${HOST}/sell/inventory/v1/offer`),
    "/sell/inventory/v1/offer",
  );
  assertEquals(
    normalizeEbayEndpoint(`${HOST}/buy/marketplace_insights/v1_beta/item_sales/search`),
    "/buy/marketplace_insights/v1_beta/item_sales/search",
  );
});

Deno.test("normalizeEbayEndpoint: the query string never reaches the bucket", () => {
  // A search query is unbounded user input. If it survived into the endpoint
  // column, every distinct search would mint a row.
  const one = normalizeEbayEndpoint(
    `${HOST}/buy/browse/v1/item_summary/search?q=patagonia+synchilla&limit=25`,
  );
  const two = normalizeEbayEndpoint(
    `${HOST}/buy/browse/v1/item_summary/search?q=arcteryx+beta+ar&limit=10`,
  );
  assertEquals(one, two);
  assertEquals(one, "/buy/browse/v1/item_summary/search");
});

Deno.test("normalizeEbayEndpoint: Trading is split by call name", () => {
  // Trading is one URL for every operation. Without the call name the whole
  // API reports as a single row and we cannot tell a GetItem storm from a
  // ReviseItem storm.
  const get = normalizeEbayEndpoint(`${HOST}/ws/api.dll`, "GetItem");
  const revise = normalizeEbayEndpoint(`${HOST}/ws/api.dll`, "ReviseFixedPriceItem");
  assert(get !== revise);
  assertEquals(get, "/ws/api.dll:GetItem");
});

Deno.test("normalizeEbayEndpoint: output is capped to the column width", () => {
  const long = normalizeEbayEndpoint(`${HOST}/sell/${"a".repeat(400)}/thing`);
  assert(long.length <= 200, `endpoint was ${long.length} chars`);
});

Deno.test("statusClassOf: 429 is its own class", () => {
  // The whole point of the table is answering "are we hitting the ceiling",
  // so a 429 folded into 4xx would be indistinguishable from a bad request.
  assertEquals(statusClassOf(429), "429");
  assertEquals(statusClassOf(400), "4xx");
  assertEquals(statusClassOf(404), "4xx");
  assertEquals(statusClassOf(200), "2xx");
  assertEquals(statusClassOf(204), "2xx");
  assertEquals(statusClassOf(301), "3xx");
  assertEquals(statusClassOf(500), "5xx");
  assertEquals(statusClassOf(503), "5xx");
});

Deno.test("statusClassOf: no response is not the same as a rejection", () => {
  // A timeout never reached eBay and never counted against the quota. Recording
  // it as a 5xx would inflate our number against eBay's and make the two
  // uncomparable, which is the one thing the second table exists to allow.
  assertEquals(statusClassOf(null), "error");
  assertEquals(statusClassOf(undefined), "error");
});

Deno.test("utcDay: the day boundary is UTC, not local", () => {
  // eBay's limits reset on a UTC day. Counting on any other calendar would
  // attribute the tail of a busy day to the next one.
  assertEquals(utcDay(new Date("2026-09-01T23:59:59Z")), "2026-09-01");
  assertEquals(utcDay(new Date("2026-09-02T00:00:01Z")), "2026-09-02");
  // 7pm US Central on the 1st is already the 2nd in UTC.
  assertEquals(utcDay(new Date("2026-09-02T01:30:00Z")), "2026-09-02");
});
