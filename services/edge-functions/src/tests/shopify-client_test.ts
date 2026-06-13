// US-599: pure helpers of the Shopify connector — domain normalization, OAuth
// HMAC verification, the Admin API product payload, and the net-payout estimate
// used by the (marketplace-agnostic) reconciliation matcher. No network: these
// are the security- and correctness-critical pure functions.

// shopify-client.ts imports the service-role supabase client at module init, so
// set dummy env BEFORE the dynamic import (mirrors abandoned-checkout_test.ts).
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  buildProductPayload,
  estimateShopifyNet,
  normalizeShopDomain,
  verifyOAuthHmac,
  verifyWebhookHmac,
} = await import("../lib/shopify-client.ts");

Deno.test("normalizeShopDomain accepts handles, hosts, and URLs", () => {
  assertEquals(normalizeShopDomain("my-store"), "my-store.myshopify.com");
  assertEquals(
    normalizeShopDomain("My-Store.myshopify.com"),
    "my-store.myshopify.com",
  );
  assertEquals(
    normalizeShopDomain("https://my-store.myshopify.com/admin"),
    "my-store.myshopify.com",
  );
});

Deno.test("normalizeShopDomain rejects non-myshopify and empty input", () => {
  assertEquals(normalizeShopDomain(""), null);
  assertEquals(normalizeShopDomain(null), null);
  assertEquals(normalizeShopDomain("evil.com"), null);
  // A custom storefront domain is NOT the Admin API host.
  assertEquals(normalizeShopDomain("shop.mybrand.com"), null);
});

Deno.test("verifyOAuthHmac validates Shopify's signature and rejects tampering", async () => {
  // Compute a valid HMAC the way Shopify does, then check both paths.
  const secret = "test_secret_value";
  Deno.env.set("SHOPIFY_API_SECRET", secret);
  const params: Record<string, string> = {
    code: "abc123",
    shop: "my-store.myshopify.com",
    state: "nonce",
    timestamp: "1700000000",
  };
  const message = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
  );
  let hmac = "";
  for (const b of sig) hmac += b.toString(16).padStart(2, "0");

  assert(await verifyOAuthHmac({ ...params, hmac }));
  // Tampered shop → fails.
  assert(!(await verifyOAuthHmac({ ...params, shop: "attacker.myshopify.com", hmac })));
  // Missing hmac → fails.
  assert(!(await verifyOAuthHmac({ ...params })));

  Deno.env.delete("SHOPIFY_API_SECRET");
});

Deno.test("verifyWebhookHmac validates the base64 body signature and rejects tampering (US-711)", async () => {
  // Shopify signs a webhook with HMAC-SHA256 over the RAW body, base64-encoded.
  const secret = "test_webhook_secret";
  Deno.env.set("SHOPIFY_API_SECRET", secret);
  const body = JSON.stringify({ id: 12345, financial_status: "paid" });

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );
  let binary = "";
  for (const b of sig) binary += String.fromCharCode(b);
  const hmac = btoa(binary);

  assert(await verifyWebhookHmac(body, hmac));
  // Tampered body → fails.
  assert(!(await verifyWebhookHmac(body + " ", hmac)));
  // Missing/empty header → fails.
  assert(!(await verifyWebhookHmac(body, "")));

  Deno.env.delete("SHOPIFY_API_SECRET");
});

Deno.test("buildProductPayload maps our input onto the Admin API shape", () => {
  const { product } = buildProductPayload({
    title: "Nike Hoodie",
    bodyHtml: "<p>Great shape</p>",
    vendor: "Nike",
    productType: "Hoodies",
    tags: ["nike", "streetwear"],
    price: 49.5,
    sku: "SKU-1",
    quantity: 1,
    imageUrls: ["https://cdn.example.com/a.jpg"],
    status: "active",
  });
  assertEquals(product.title, "Nike Hoodie");
  assertEquals(product.body_html, "<p>Great shape</p>");
  assertEquals(product.vendor, "Nike");
  assertEquals(product.product_type, "Hoodies");
  assertEquals(product.tags, "nike, streetwear");
  assertEquals(product.status, "active");
  const variants = product.variants as Array<Record<string, unknown>>;
  assertEquals(variants[0]!.price, "49.50");
  assertEquals(variants[0]!.sku, "SKU-1");
  const images = product.images as Array<Record<string, unknown>>;
  assertEquals(images[0]!.src, "https://cdn.example.com/a.jpg");
});

Deno.test("buildProductPayload omits optional fields when absent", () => {
  const { product } = buildProductPayload({
    title: "Plain",
    bodyHtml: "",
    price: 10,
  });
  assert(!("vendor" in product));
  assert(!("product_type" in product));
  assert(!("tags" in product));
  assert(!("images" in product));
});

Deno.test("estimateShopifyNet applies the 2.9% + $0.30 fee and floors at 0", () => {
  // 100 → 100 - (2.90 + 0.30) = 96.80
  assertEquals(estimateShopifyNet(100), 96.8);
  assertEquals(estimateShopifyNet(0), 0);
  assertEquals(estimateShopifyNet(-5), 0);
});
