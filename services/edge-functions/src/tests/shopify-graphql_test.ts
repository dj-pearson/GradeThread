// US-710: pure helpers of the Shopify GraphQL Admin API publish path — GID
// conversion, cost/throttle accounting (the rate-limit logic we MUST get right
// against Shopify's 1000-point ceiling), the productSet variable builder, and
// the >250-record bulk threshold. No network: these are the deterministic,
// correctness-critical functions.

// shopify-graphql.ts transitively imports the service-role client via
// shopify-client.ts, so set dummy env BEFORE the dynamic import.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  BULK_RECORD_THRESHOLD,
  SHOPIFY_WEBHOOK_TOPICS,
  buildProductSetVariables,
  computeThrottleWaitMs,
  gidToNumericId,
  isThrottled,
  parseCost,
  requiresBulk,
  toGid,
} = await import("../lib/shopify-graphql.ts");

Deno.test("SHOPIFY_WEBHOOK_TOPICS covers the US-711 sale/inventory/product set", () => {
  assertEquals(
    [...SHOPIFY_WEBHOOK_TOPICS].sort(),
    [
      "INVENTORY_LEVELS_UPDATE",
      "ORDERS_CREATE",
      "ORDERS_UPDATED",
      "PRODUCTS_UPDATE",
    ],
  );
});

Deno.test("gidToNumericId extracts the numeric id and passes bare ids through", () => {
  assertEquals(gidToNumericId("gid://shopify/Product/123"), "123");
  assertEquals(gidToNumericId("gid://shopify/ProductVariant/999?foo=bar"), "999");
  assertEquals(gidToNumericId("456"), "456");
  assertEquals(gidToNumericId(null), "");
  assertEquals(gidToNumericId(undefined), "");
});

Deno.test("toGid builds a GID and is idempotent on an existing one", () => {
  assertEquals(toGid("Product", "123"), "gid://shopify/Product/123");
  assertEquals(
    toGid("Product", "gid://shopify/Product/123"),
    "gid://shopify/Product/123",
  );
});

Deno.test("parseCost reads extensions.cost.throttleStatus", () => {
  const cost = parseCost({
    extensions: {
      cost: {
        requestedQueryCost: 50,
        actualQueryCost: 48,
        throttleStatus: {
          maximumAvailable: 1000,
          currentlyAvailable: 900,
          restoreRate: 50,
        },
      },
    },
  });
  assert(cost);
  assertEquals(cost!.requestedQueryCost, 50);
  assertEquals(cost!.actualQueryCost, 48);
  assertEquals(cost!.throttleStatus!.currentlyAvailable, 900);
  assertEquals(cost!.throttleStatus!.restoreRate, 50);
  // No extensions → null.
  assertEquals(parseCost({ data: {} }), null);
});

Deno.test("isThrottled detects the THROTTLED error code", () => {
  assert(isThrottled({ errors: [{ extensions: { code: "THROTTLED" } }] }));
  assert(!isThrottled({ errors: [{ extensions: { code: "ACCESS_DENIED" } }] }));
  assert(!isThrottled({ data: {} }));
});

Deno.test("computeThrottleWaitMs honors the leaky bucket then backs off", () => {
  // Need 100 more points at a restore rate of 50/s → 2s bucket wait at attempt 0.
  const cost = {
    requestedQueryCost: 1000,
    actualQueryCost: null,
    throttleStatus: {
      maximumAvailable: 1000,
      currentlyAvailable: 900,
      restoreRate: 50,
    },
  };
  assertEquals(computeThrottleWaitMs(cost, 0), 2000);
  // Exponential backoff per attempt.
  assertEquals(computeThrottleWaitMs(cost, 1), 4000);
  // Clamped to the 30s ceiling.
  assertEquals(computeThrottleWaitMs(cost, 10), 30_000);
  // No cost info → a sane non-zero floor.
  assert(computeThrottleWaitMs(null, 0) >= 500);
});

Deno.test("requiresBulk trips above the 250-record ceiling", () => {
  assertEquals(BULK_RECORD_THRESHOLD, 250);
  assert(!requiresBulk(1));
  assert(!requiresBulk(250));
  assert(requiresBulk(251));
});

Deno.test("buildProductSetVariables maps our input onto ProductSetInput", () => {
  const { input } = buildProductSetVariables({
    title: "Nike Hoodie",
    descriptionHtml: "<p>Grade 8.5 — Excellent</p>",
    vendor: "Nike",
    productType: "Hoodies",
    tags: ["nike", "streetwear"],
    price: 49.5,
    sku: "SKU-1",
    imageUrls: ["https://cdn.example.com/a.jpg"],
    status: "ACTIVE",
  });
  assertEquals(input.title, "Nike Hoodie");
  assertEquals(input.descriptionHtml, "<p>Grade 8.5 — Excellent</p>");
  assertEquals(input.vendor, "Nike");
  assertEquals(input.productType, "Hoodies");
  assertEquals(input.status, "ACTIVE");
  assertEquals(input.tags, ["nike", "streetwear"]);
  const variants = input.variants as Array<Record<string, unknown>>;
  assertEquals(variants[0]!.price, "49.50");
  assertEquals(variants[0]!.sku, "SKU-1");
  assertEquals(variants[0]!.inventoryItem, { tracked: true });
  const files = input.files as Array<Record<string, unknown>>;
  assertEquals(files[0]!.originalSource, "https://cdn.example.com/a.jpg");
  assertEquals(files[0]!.contentType, "IMAGE");
  // No id on a create.
  assert(!("id" in input));
});

Deno.test("buildProductSetVariables sets a Product GID for an update", () => {
  const { input } = buildProductSetVariables({
    productId: "789",
    title: "X",
    descriptionHtml: "",
    price: 10,
  });
  assertEquals(input.id, "gid://shopify/Product/789");
  // Optional fields omitted when absent.
  assert(!("vendor" in input));
  assert(!("productType" in input));
  assert(!("tags" in input));
  assert(!("files" in input));
});
