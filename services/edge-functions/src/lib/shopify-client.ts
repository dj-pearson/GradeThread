// Shopify Admin API connector for FlipDesk (US-599) — the first REAL non-eBay
// marketplace. This module owns OAuth + connection storage + the READ/SYNC feed
// (product status + paid orders) over the Admin REST API:
//
//   sync   → GET   /admin/api/<v>/products/<id>.json        (getProductStatus)
//   recon  → GET   /admin/api/<v>/orders.json?...           (listPaidOrders)
//
// The WRITE path (publish / update / delist) moved to the GraphQL Admin API in
// US-710 — see shopify-graphql.ts (productSet → inventorySetQuantities →
// publishablePublish; productDelete to delist) so we honor the cost-based rate
// limit. The REST createProduct/updateProduct/deleteProduct + buildProductPayload
// below are retained only as a documented fallback (and unit-tested payload
// builder); the live adapter no longer calls them.
//
// Tokens: Shopify's OAuth access token is OFFLINE (non-expiring) — far simpler
// than eBay's refresh dance. We store it encrypted in marketplace_connections
// with marketplace='shopify', account_handle=<shop>.myshopify.com, and a null
// token_expires_at / refresh_token. The token is bound to the owning user_id as
// AES-GCM AAD (US-352), identical to the eBay path.
//
// Required env (Coolify Shared Variables):
//   SHOPIFY_API_KEY       the app's client id
//   SHOPIFY_API_SECRET    the app's client secret (also HMAC key for callbacks)
//   SHOPIFY_REDIRECT_URI  https://functions.gradethread.com/api/flipdesk/shopify/oauth/callback
//   SHOPIFY_SCOPES        optional; default = the US-709 publish+inventory+orders
//                         set (write_products,read_products,write_inventory,
//                         read_inventory,read_orders,write_assigned_fulfillment_orders)
//   EDGE_ENCRYPTION_KEY   (shared with the eBay path)

import { supabaseAdmin } from "./supabase.ts";
import { decryptToken, encryptToken } from "./crypto-aes.ts";
import { fetchWithTimeout } from "./circuit-breaker.ts";

// Pin the Admin API version — Shopify supports each for ~12 months. Bump
// deliberately (the payload shapes below are stable across recent versions).
export const SHOPIFY_API_VERSION = "2024-10";
const SHOPIFY_TIMEOUT_MS = 20_000;
// US-709: request the full publish + inventory + order/fulfillment scope set so
// the connector can create/update products, manage stock levels, read paid
// orders for reconciliation, and act on assigned fulfillment orders.
const DEFAULT_SCOPES =
  "write_products,read_products,write_inventory,read_inventory,read_orders,write_assigned_fulfillment_orders";

// All env reads trim whitespace (copy-paste guard) and treat "" as unset —
// mirrors ebay-client's readEnv so a stray space can't break the OAuth host.
function readEnv(name: string): string | undefined {
  const v = Deno.env.get(name);
  if (v == null) return undefined;
  const trimmed = v.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function isShopifyConfigured(): boolean {
  return !!(readEnv("SHOPIFY_API_KEY") && readEnv("SHOPIFY_API_SECRET"));
}

export function getShopifyScopes(): string {
  return readEnv("SHOPIFY_SCOPES") ?? DEFAULT_SCOPES;
}

// The public HTTPS endpoint Shopify POSTs webhooks to (US-711). Overridable via
// SHOPIFY_WEBHOOK_CALLBACK_URL; defaults to the consolidated edge container's
// inbound-webhook path (the same host the eBay receiver lives on).
export function getShopifyWebhookUrl(): string {
  return (
    readEnv("SHOPIFY_WEBHOOK_CALLBACK_URL") ??
    "https://functions.gradethread.com/api/flipdesk/webhooks/shopify"
  );
}

// ── Shop-domain handling ─────────────────────────────────────────────
// Accepts "store", "store.myshopify.com", or "https://store.myshopify.com" and
// normalizes to the canonical "<store>.myshopify.com". Returns null for an
// invalid handle (this is the value the user types, so validate it hard — it
// becomes the host every API call hits). Pure + unit-tested.
export function normalizeShopDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();
  if (s === "") return null;
  // Strip a scheme + any path/query the user may have pasted.
  s = s.replace(/^https?:\/\//, "");
  s = s.replace(/\/.*$/, "");
  // Bare store handle → append the canonical myshopify host.
  if (!s.includes(".")) s = `${s}.myshopify.com`;
  // Only *.myshopify.com is a valid Admin API host; a custom storefront domain
  // is NOT (the Admin API is served off the myshopify host).
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(s)) return null;
  return s;
}

// ── OAuth ────────────────────────────────────────────────────────────

export function buildConsentUrl(shop: string, state: string): string {
  const apiKey = readEnv("SHOPIFY_API_KEY");
  const redirectUri = readEnv("SHOPIFY_REDIRECT_URI");
  if (!apiKey || !redirectUri) {
    throw new Error("SHOPIFY_API_KEY / SHOPIFY_REDIRECT_URI are not set.");
  }
  const params = new URLSearchParams({
    client_id: apiKey,
    scope: getShopifyScopes(),
    redirect_uri: redirectUri,
    state,
  });
  return `https://${shop}/admin/oauth/authorize?${params.toString()}`;
}

// Shopify signs every OAuth callback (and webhook) with HMAC-SHA256 over the
// query string (all params except `hmac` and `signature`, sorted by key). We
// MUST verify this with our API secret before trusting the `shop`/`code` —
// otherwise an attacker could forge a callback and bind a shop they don't own.
// Pure (Web Crypto only) + unit-tested.
export async function verifyOAuthHmac(
  query: Record<string, string>,
): Promise<boolean> {
  const secret = readEnv("SHOPIFY_API_SECRET");
  if (!secret) return false;
  const provided = query.hmac;
  if (!provided) return false;

  const message = Object.keys(query)
    .filter((k) => k !== "hmac" && k !== "signature")
    .sort()
    .map((k) => `${k}=${query[k]}`)
    .join("&");

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
  );
  let computed = "";
  for (const b of sigBytes) computed += b.toString(16).padStart(2, "0");

  // Constant-time compare (lengths equal → XOR-accumulate).
  if (computed.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

// Verifies an inbound WEBHOOK's signature (US-711). Distinct from the OAuth
// callback HMAC above: Shopify signs a webhook with HMAC-SHA256 over the RAW
// request body (the exact bytes — re-serializing the JSON would change them) and
// presents it BASE64-encoded in the `X-Shopify-Hmac-Sha256` header, NOT hex over
// the query string. Verify with our app secret BEFORE trusting the body or the
// X-Shopify-Shop-Domain header. Pure (Web Crypto only) + unit-tested.
export async function verifyWebhookHmac(
  rawBody: string,
  hmacHeaderBase64: string,
): Promise<boolean> {
  const secret = readEnv("SHOPIFY_API_SECRET");
  if (!secret || !hmacHeaderBase64) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)),
  );
  // Base64-encode the computed signature to compare against the header.
  let binary = "";
  for (const b of sigBytes) binary += String.fromCharCode(b);
  const computed = btoa(binary);

  // Constant-time compare (lengths equal → XOR-accumulate).
  if (computed.length !== hmacHeaderBase64.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ hmacHeaderBase64.charCodeAt(i);
  }
  return diff === 0;
}

export interface ShopifyTokenResponse {
  access_token: string;
  scope: string;
}

export async function exchangeCodeForToken(
  shop: string,
  code: string,
): Promise<ShopifyTokenResponse> {
  const apiKey = readEnv("SHOPIFY_API_KEY");
  const apiSecret = readEnv("SHOPIFY_API_SECRET");
  if (!apiKey || !apiSecret) {
    throw new Error("SHOPIFY_API_KEY / SHOPIFY_API_SECRET are not set.");
  }
  const res = await fetchWithTimeout(
    `https://${shop}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: apiKey,
        client_secret: apiSecret,
        code,
      }),
    },
    SHOPIFY_TIMEOUT_MS,
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify token exchange failed (${res.status}): ${text}`);
  }
  return (await res.json()) as ShopifyTokenResponse;
}

// ── Connection storage ───────────────────────────────────────────────

export interface ShopInfo {
  id: string | null;
  name: string | null;
  myshopifyDomain: string | null;
  email: string | null;
  currency: string | null;
}

export async function getShopInfo(
  shop: string,
  token: string,
): Promise<ShopInfo | null> {
  try {
    const res = await adminFetch(shop, token, "GET", "/shop.json");
    if (!res.ok) {
      await res.body?.cancel();
      return null;
    }
    const body = (await res.json()) as {
      shop?: {
        id?: number;
        name?: string;
        myshopify_domain?: string;
        email?: string;
        currency?: string;
      };
    };
    const s = body.shop;
    if (!s) return null;
    return {
      id: s.id != null ? String(s.id) : null,
      name: s.name ?? null,
      myshopifyDomain: s.myshopify_domain ?? null,
      email: s.email ?? null,
      currency: s.currency ?? null,
    };
  } catch {
    return null;
  }
}

export async function upsertShopifyConnection(args: {
  userId: string;
  shop: string;
  accessToken: string;
  scope: string;
  externalAccountId?: string | null;
}): Promise<void> {
  // US-352: bind the ciphertext to the owning user_id (AES-GCM AAD) so a token
  // blob can't be replayed onto another tenant's connection row.
  const access = await encryptToken(args.accessToken, { aad: args.userId });

  const { data: existing, error: lookupErr } = await supabaseAdmin
    .from("marketplace_connections")
    .select("id")
    .eq("user_id", args.userId)
    .eq("marketplace", "shopify")
    .eq("account_handle", args.shop)
    .maybeSingle();
  if (lookupErr) {
    throw new Error(`Failed to look up Shopify connection: ${lookupErr.message}`);
  }

  const patch: Record<string, unknown> = {
    access_token_encrypted: access,
    // Shopify offline tokens never expire and have no refresh token.
    refresh_token_encrypted: null,
    token_expires_at: null,
    scopes: args.scope ? args.scope.split(",").map((s) => s.trim()) : [],
    is_active: true,
    last_synced_at: null,
    refresh_error: null,
  };
  if (args.externalAccountId) patch.external_account_id = args.externalAccountId;

  if (existing) {
    const { error } = await supabaseAdmin
      .from("marketplace_connections")
      .update(patch)
      .eq("id", (existing as { id: string }).id);
    if (error) {
      throw new Error(`Failed to update Shopify connection: ${error.message}`);
    }
    return;
  }
  const { error } = await supabaseAdmin
    .from("marketplace_connections")
    .insert({
      user_id: args.userId,
      marketplace: "shopify",
      account_handle: args.shop,
      ...patch,
    });
  if (error) {
    throw new Error(`Failed to insert Shopify connection: ${error.message}`);
  }
}

export interface ShopifyConnection {
  id: string;
  shop: string;
  token: string;
}

// Returns the owner's active Shopify connection with a DECRYPTED access token,
// or null when none is connected. Tenant-scoped: caller passes the workspace
// owner id (connections live on the owner, like eBay).
export async function getShopifyConnection(
  userId: string,
): Promise<ShopifyConnection | null> {
  const { data: row, error } = await supabaseAdmin
    .from("marketplace_connections")
    .select("id, account_handle, access_token_encrypted")
    .eq("user_id", userId)
    .eq("marketplace", "shopify")
    .eq("is_active", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new Error(`Failed to load Shopify connection: ${error.message}`);
  }
  if (!row) return null;
  const r = row as {
    id: string;
    account_handle: string | null;
    access_token_encrypted: string | null;
  };
  if (!r.account_handle || !r.access_token_encrypted) return null;
  const token = await decryptToken(r.access_token_encrypted, { aad: userId });
  return { id: r.id, shop: r.account_handle, token };
}

// ── Admin REST helpers ───────────────────────────────────────────────

function adminFetch(
  shop: string,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const url = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}${path}`;
  const init: RequestInit = {
    method,
    headers: {
      "X-Shopify-Access-Token": token,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return fetchWithTimeout(url, init, SHOPIFY_TIMEOUT_MS);
}

export interface ShopifyProductInput {
  title: string;
  bodyHtml: string;
  vendor?: string | null;
  productType?: string | null;
  tags?: string[];
  price: number;
  sku?: string | null;
  quantity?: number | null;
  imageUrls?: string[];
  /** active = published to the online store; draft = hidden. */
  status?: "active" | "draft";
}

export interface ShopifyProductResult {
  productId: string;
  handle: string | null;
  listingUrl: string | null;
}

// Pure: builds the Admin API `{ product: {...} }` payload from our normalized
// input. Split out so it's unit-testable without the network. Shopify ingests
// images by public `src` URL (item-photos is a public bucket), so no upload.
export function buildProductPayload(
  input: ShopifyProductInput,
): { product: Record<string, unknown> } {
  const product: Record<string, unknown> = {
    title: input.title,
    body_html: input.bodyHtml,
    status: input.status ?? "active",
    variants: [
      {
        price: input.price.toFixed(2),
        sku: input.sku ?? undefined,
        inventory_quantity: input.quantity ?? 1,
        // Let Shopify track stock so a sale flips the product out of stock.
        inventory_management: "shopify",
      },
    ],
  };
  if (input.vendor) product.vendor = input.vendor;
  if (input.productType) product.product_type = input.productType;
  if (input.tags && input.tags.length > 0) product.tags = input.tags.join(", ");
  const images = (input.imageUrls ?? []).filter((u) => !!u);
  if (images.length > 0) product.images = images.map((src) => ({ src }));
  return { product };
}

function productResult(
  shop: string,
  raw: { id?: number; handle?: string } | undefined,
): ShopifyProductResult {
  const productId = raw?.id != null ? String(raw.id) : "";
  const handle = raw?.handle ?? null;
  return {
    productId,
    handle,
    listingUrl: handle ? `https://${shop}/products/${handle}` : null,
  };
}

export async function createProduct(
  shop: string,
  token: string,
  input: ShopifyProductInput,
): Promise<ShopifyProductResult> {
  const res = await adminFetch(
    shop,
    token,
    "POST",
    "/products.json",
    buildProductPayload(input),
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify create product failed (${res.status}): ${text}`);
  }
  const body = (await res.json()) as { product?: { id?: number; handle?: string } };
  return productResult(shop, body.product);
}

export async function updateProduct(
  shop: string,
  token: string,
  productId: string,
  input: ShopifyProductInput,
): Promise<ShopifyProductResult> {
  // PUT replaces the editable fields. We re-send the full normalized payload so
  // a re-push from the composer (sync) reconciles title/price/images on Shopify.
  const payload = buildProductPayload(input);
  (payload.product as Record<string, unknown>).id = Number(productId);
  const res = await adminFetch(
    shop,
    token,
    "PUT",
    `/products/${encodeURIComponent(productId)}.json`,
    payload,
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify update product failed (${res.status}): ${text}`);
  }
  const body = (await res.json()) as { product?: { id?: number; handle?: string } };
  return productResult(shop, body.product);
}

// Delist. Returns "deleted" normally; "gone" when Shopify reports the product
// already absent (404) — the caller treats both as success so a double-delist
// (e.g. auto-end after a manual end) is idempotent.
export async function deleteProduct(
  shop: string,
  token: string,
  productId: string,
): Promise<"deleted" | "gone"> {
  const res = await adminFetch(
    shop,
    token,
    "DELETE",
    `/products/${encodeURIComponent(productId)}.json`,
  );
  if (res.ok) {
    await res.body?.cancel();
    return "deleted";
  }
  if (res.status === 404) {
    await res.body?.cancel();
    return "gone";
  }
  const text = await res.text();
  throw new Error(`Shopify delete product failed (${res.status}): ${text}`);
}

export interface ShopifyProductStatus {
  productId: string;
  status: string | null;
  handle: string | null;
  /** Total inventory across variants; 0 means sold-out. */
  totalInventory: number | null;
}

export async function getProductStatus(
  shop: string,
  token: string,
  productId: string,
): Promise<ShopifyProductStatus | "gone" | null> {
  const res = await adminFetch(
    shop,
    token,
    "GET",
    `/products/${encodeURIComponent(productId)}.json`,
  );
  if (res.status === 404) {
    await res.body?.cancel();
    return "gone";
  }
  if (!res.ok) {
    await res.body?.cancel();
    return null;
  }
  const body = (await res.json()) as {
    product?: {
      id?: number;
      status?: string;
      handle?: string;
      variants?: Array<{ inventory_quantity?: number }>;
    };
  };
  const p = body.product;
  if (!p) return null;
  const totalInventory = Array.isArray(p.variants)
    ? p.variants.reduce((sum, v) => sum + (v.inventory_quantity ?? 0), 0)
    : null;
  return {
    productId: p.id != null ? String(p.id) : productId,
    status: p.status ?? null,
    handle: p.handle ?? null,
    totalInventory,
  };
}

// ── Orders (reconciliation feed) ─────────────────────────────────────

export interface ShopifyOrderLineItem {
  productId: string | null;
  quantity: number;
  price: number;
}

export interface ShopifyOrder {
  id: string;
  name: string;
  financialStatus: string | null;
  totalPrice: number;
  /** Shopify's processing fee on this order, when expanded; null otherwise. */
  processedAt: string | null;
  /** Set when the order was cancelled; null for live orders (US-711 refunds). */
  cancelledAt: string | null;
  lineItems: ShopifyOrderLineItem[];
}

// Pulls recent PAID orders for reconciliation. `sinceIso` floors processed_at
// so re-syncs only fetch the new window. Returns up to `limit` (Shopify caps
// at 250/page; one page is plenty for a reseller's cadence).
export async function listPaidOrders(
  shop: string,
  token: string,
  sinceIso: string | null,
  limit = 250,
): Promise<ShopifyOrder[]> {
  const params = new URLSearchParams({
    status: "any",
    financial_status: "paid",
    limit: String(Math.min(limit, 250)),
  });
  if (sinceIso) params.set("processed_at_min", sinceIso);
  const res = await adminFetch(
    shop,
    token,
    "GET",
    `/orders.json?${params.toString()}`,
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify orders fetch failed (${res.status}): ${text}`);
  }
  const body = (await res.json()) as {
    orders?: Array<{
      id?: number;
      name?: string;
      financial_status?: string;
      total_price?: string;
      processed_at?: string;
      created_at?: string;
      cancelled_at?: string | null;
      line_items?: Array<{
        product_id?: number | null;
        quantity?: number;
        price?: string;
      }>;
    }>;
  };
  return (body.orders ?? []).map((o) => ({
    id: o.id != null ? String(o.id) : "",
    name: o.name ?? "",
    financialStatus: o.financial_status ?? null,
    totalPrice: o.total_price != null ? Number(o.total_price) : 0,
    processedAt: o.processed_at ?? o.created_at ?? null,
    cancelledAt: o.cancelled_at ?? null,
    lineItems: (o.line_items ?? []).map((li) => ({
      productId: li.product_id != null ? String(li.product_id) : null,
      quantity: li.quantity ?? 1,
      price: li.price != null ? Number(li.price) : 0,
    })),
  }));
}

// Shopify Payments default processing fee in the US is 2.9% + $0.30 per order.
// We can't read the exact fee without the Shopify Payments balance API (a
// separate grant), so we ESTIMATE the seller's net for the reconciliation
// matcher — the same role saleNetEstimate() plays for eBay. Pure + unit-tested.
export function estimateShopifyNet(grossLineRevenue: number): number {
  if (!(grossLineRevenue > 0)) return 0;
  const net = grossLineRevenue - (grossLineRevenue * 0.029 + 0.3);
  return Math.max(0, Math.round(net * 100) / 100);
}
