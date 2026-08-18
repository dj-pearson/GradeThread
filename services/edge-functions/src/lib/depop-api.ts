// Depop Selling API client for FlipDesk (US-714) — the LISTING + ORDER write
// path that sits on top of the US-713 connection layer (depop-client.ts owns
// OAuth/token storage; this module owns everything you do WITH a valid token).
//
// Endpoints (per vault/30-platform/cross-listing.md §2 / partnerapi.depop.com OpenAPI):
//   PUT    /api/v1/products/{sku}                                  upsert (create OR update)
//   DELETE /api/v1/products/{sku}                                  delist
//   GET    /api/v1/products?cursor&limit                           list (sync)
//   GET    /api/v1/orders                                          order sync (orders_read)
//   GET    /api/v1/shop/seller-addresses/                          fulfillment setup
//   GET    /api/v1/shop/seller-addresses/{id}/shipping-providers/  fulfillment setup
//   POST   /api/v1/orders/{purchase_id}/parcels/{parcel_id}/mark-as-shipped/
//
// ⚠️ VERIFY: Depop's partner API is private (US-712 application pending), so the
// exact product/order field names below are modeled from the public docs + the
// shared marketplace spec (marketplace-specs.ts) and MUST be reconciled against
// the live OpenAPI (https://partnerapi.depop.com/api-docs/openapi.yaml) once
// sandbox access lands. The shapes are kept narrow + pure-buildable so a field
// rename is a one-line change here, not a refactor across the adapter.
//
// SECURITY (US-268): this module is transport-only — it takes a token + ids and
// talks to Depop. It performs NO tenant-scoped DB access. The caller
// (depop adapter / depop-orders / the routes) is responsible for loading rows
// scoped to the workspace owner and passing the verified token in.

import { fetchWithTimeout } from "./circuit-breaker.ts";
import { fetchWithRateLimitRetry } from "./http-retry.ts";

const DEPOP_TIMEOUT_MS = 25_000;

// Base URL for the data API. Overridable so the sandbox host can be pointed at
// without a code change (mirrors depop-client's DEPOP_AUTH_URL/DEPOP_TOKEN_URL).
const DEFAULT_API_BASE = "https://partnerapi.depop.com";

function apiBase(): string {
  const v = Deno.env.get("DEPOP_API_BASE")?.trim();
  return (v && v !== "" ? v : DEFAULT_API_BASE).replace(/\/$/, "");
}

export class DepopApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body = "") {
    super(message);
    this.name = "DepopApiError";
    this.status = status;
    this.body = body;
  }
}

// Core authed JSON call. Bearer token (OAuth access token OR a pak_ partner
// key). Throws DepopApiError on a non-2xx so callers can branch on .status
// (e.g. treat 404 as already-gone for an idempotent delete).
export async function depopFetch<T = unknown>(
  token: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const url = path.startsWith("http") ? path : `${apiBase()}${path}`;
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body != null ? { "Content-Type": "application/json" } : {}),
    },
    ...(body != null ? { body: JSON.stringify(body) } : {}),
  };
  // US-2324 AC4: retry 429 and 5xx, honouring Retry-After. This used to be a
  // bare fetchWithTimeout followed by `throw on !ok`, so a rate-limit reply —
  // the one failure guaranteed to clear if you wait — aborted the whole sync,
  // and the server's own Retry-After was discarded. Only 429/5xx retry; every
  // other status is returned unchanged so the handling below still runs.
  const res = await fetchWithRateLimitRetry(
    () => fetchWithTimeout(url, init, DEPOP_TIMEOUT_MS),
    { label: `Depop ${method} ${path}` },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new DepopApiError(
      `Depop ${method} ${path} failed (${res.status})`,
      res.status,
      text.slice(0, 1000),
    );
  }
  // 204 No Content (mark-as-shipped / delete) has no body to parse.
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined as T;
  }
}

// ── Product upsert payload (pure builder, unit-tested) ───────────────────────

export interface DepopProductInput {
  /** The stable SKU the product is upserted by (PUT /products/{sku}). */
  sku: string;
  /** Depop has no title field — the description is the listing text. */
  description: string;
  price: number;
  currency?: string;
  /** Depop condition value (one of marketplace-specs depop.conditions). */
  condition?: string | null;
  /** Resolved category id/path (US-722); platform-specific. */
  categoryId?: string | null;
  brand?: string | null;
  size?: string | null;
  colour?: string | null;
  /** Up to 5 hashtags (no leading '#'). */
  tags?: string[];
  /** Public image URLs, ordered. Depop accepts up to 8. */
  pictureUrls?: string[];
  /** Quantity available — reseller items are single-unit. */
  quantity?: number;
}

// Builds the JSON body for PUT /api/v1/products/{sku}. Pure: no env, no I/O, so
// it unit-tests directly. Omits null/empty optionals so we never send a field
// Depop would reject as blank. The SKU travels in the URL path (the caller),
// not the body.
export function buildDepopProductPayload(
  input: DepopProductInput,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    description: input.description,
    price: { amount: Number(input.price.toFixed(2)), currency: input.currency ?? "USD" },
    quantity: input.quantity != null && input.quantity > 0 ? Math.round(input.quantity) : 1,
  };
  if (input.condition) body.condition = input.condition;
  if (input.categoryId) body.category_id = input.categoryId;
  if (input.brand) body.brand = input.brand;
  if (input.size) body.size = input.size;
  if (input.colour) body.colour = input.colour;
  const tags = (input.tags ?? []).map((t) => t.replace(/^#+/, "").trim()).filter(Boolean);
  if (tags.length > 0) body.tags = tags.slice(0, 5);
  const pics = (input.pictureUrls ?? []).filter((u) => !!u).slice(0, 8);
  if (pics.length > 0) body.pictures = pics.map((url) => ({ url }));
  return body;
}

export interface DepopProductResult {
  /** The product slug/id Depop returns; we persist it as platform_listing_id. */
  productId: string | null;
  /** Public listing URL when Depop returns one. */
  listingUrl: string | null;
}

// Extracts the product id + url from a PUT /products/{sku} response, tolerating
// the field-name variants the private API may use (id / slug / product_id).
export function parseProductResult(body: unknown, sku: string): DepopProductResult {
  const o = (body ?? {}) as Record<string, unknown>;
  const productId =
    (typeof o.id === "string" && o.id) ||
    (typeof o.slug === "string" && o.slug) ||
    (typeof o.product_id === "string" && o.product_id) ||
    sku ||
    null;
  const listingUrl =
    (typeof o.url === "string" && o.url) ||
    (typeof o.share_url === "string" && o.share_url) ||
    (typeof productId === "string" ? `https://www.depop.com/products/${productId}/` : null);
  return { productId: productId || null, listingUrl };
}

// Upsert (create OR update) a product by SKU. Idempotent by design — the same
// SKU re-PUT replaces the listing, so publish and updateListing share this call.
export async function upsertDepopProduct(
  token: string,
  input: DepopProductInput,
): Promise<DepopProductResult> {
  const body = await depopFetch(
    token,
    "PUT",
    `/api/v1/products/${encodeURIComponent(input.sku)}`,
    buildDepopProductPayload(input),
  );
  return parseProductResult(body, input.sku);
}

// Delist a product by SKU. Idempotent: a 404 (already removed) is treated as
// success ("gone") so a double-delist — e.g. auto-end after a manual end —
// doesn't error.
export async function deleteDepopProduct(
  token: string,
  sku: string,
): Promise<"deleted" | "gone"> {
  try {
    await depopFetch(token, "DELETE", `/api/v1/products/${encodeURIComponent(sku)}`);
    return "deleted";
  } catch (err) {
    if (err instanceof DepopApiError && err.status === 404) return "gone";
    throw err;
  }
}

// ── Orders (orders_read) ─────────────────────────────────────────────────────

export interface DepopParcel {
  parcelId: string | null;
  shipped: boolean;
}

export interface DepopOrderLineItem {
  /** The product SKU the buyer purchased — links back to our listing. */
  sku: string | null;
  quantity: number;
  price: number;
}

export interface DepopOrder {
  /** purchase_id — the id the mark-as-shipped endpoint is keyed by. */
  purchaseId: string;
  /** Order/transaction display id, when distinct from purchase_id. */
  orderId: string | null;
  status: string | null;
  currency: string;
  total: number;
  buyerUsername: string | null;
  soldAt: string | null;
  parcels: DepopParcel[];
  lineItems: DepopOrderLineItem[];
}

function num(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

// Pure: normalize a Depop order resource (REST list element OR webhook payload —
// the same shape) into our internal DepopOrder. Returns null when there is no
// usable purchase id. Tolerant of field-name variants (amount nesting, etc.).
export function parseDepopOrder(payload: unknown): DepopOrder | null {
  const o = (payload ?? {}) as Record<string, unknown>;
  const purchaseId =
    (o.purchase_id != null && String(o.purchase_id)) ||
    (o.purchaseId != null && String(o.purchaseId)) ||
    (o.id != null && String(o.id)) ||
    "";
  if (!purchaseId) return null;

  const orderId = o.order_id != null ? String(o.order_id) : null;
  const status = typeof o.status === "string" ? o.status : null;

  const totalObj = (o.total ?? o.amount ?? o.price) as
    | { amount?: unknown; currency?: unknown }
    | number
    | string
    | undefined;
  let total = 0;
  let currency = "USD";
  if (totalObj && typeof totalObj === "object") {
    total = num((totalObj as { amount?: unknown }).amount);
    if (typeof (totalObj as { currency?: unknown }).currency === "string") {
      currency = (totalObj as { currency: string }).currency;
    }
  } else {
    total = num(totalObj);
  }

  const buyer = (o.buyer ?? {}) as { username?: unknown };
  const buyerUsername =
    (typeof o.buyer_username === "string" && o.buyer_username) ||
    (typeof buyer.username === "string" && buyer.username) ||
    null;

  const soldAt =
    (typeof o.created_at === "string" && o.created_at) ||
    (typeof o.purchased_at === "string" && o.purchased_at) ||
    (typeof o.date === "string" && o.date) ||
    null;

  const parcelsRaw = Array.isArray(o.parcels) ? o.parcels : [];
  const parcels: DepopParcel[] = parcelsRaw.map((p) => {
    const pr = (p ?? {}) as Record<string, unknown>;
    const parcelId =
      (pr.parcel_id != null && String(pr.parcel_id)) ||
      (pr.id != null && String(pr.id)) ||
      null;
    const shipped =
      pr.shipped === true ||
      (typeof pr.status === "string" && /shipped|dispatched/i.test(pr.status));
    return { parcelId, shipped };
  });

  const itemsRaw = Array.isArray(o.items)
    ? o.items
    : Array.isArray(o.line_items)
    ? o.line_items
    : Array.isArray(o.products)
    ? o.products
    : [];
  const lineItems: DepopOrderLineItem[] = itemsRaw.map((li) => {
    const l = (li ?? {}) as Record<string, unknown>;
    const sku =
      (l.sku != null && String(l.sku)) ||
      (l.product_sku != null && String(l.product_sku)) ||
      (l.product_id != null && String(l.product_id)) ||
      null;
    const priceObj = (l.price ?? l.amount) as { amount?: unknown } | number | string | undefined;
    const price = priceObj && typeof priceObj === "object"
      ? num((priceObj as { amount?: unknown }).amount)
      : num(priceObj);
    return { sku, quantity: l.quantity != null ? num(l.quantity) : 1, price };
  });

  // If no line items but a single product SKU sits at the top level, synthesize one.
  if (lineItems.length === 0 && typeof o.sku === "string") {
    lineItems.push({ sku: o.sku, quantity: 1, price: total });
  }

  return {
    purchaseId,
    orderId,
    status,
    currency,
    total,
    buyerUsername,
    soldAt,
    parcels,
    lineItems,
  };
}

// Pure: map a Depop order status to a terminal sale status, or null when the
// order is still a live/real sale. Mirrors refundStatusForOrder (shopify-orders).
export function depopRefundStatus(order: DepopOrder): "cancelled" | "refunded" | null {
  const s = (order.status ?? "").toLowerCase();
  if (/cancel/.test(s)) return "cancelled";
  if (/refund/.test(s)) return "refunded";
  return null;
}

// GET /api/v1/orders — paginated by cursor. Returns the parsed orders across all
// pages (bounded by maxPages so a runaway cursor can't loop forever). `since` is
// passed through as a query param when supplied (incremental sync).
export async function listDepopOrders(
  token: string,
  opts: { since?: string | null; limit?: number; maxPages?: number } = {},
): Promise<DepopOrder[]> {
  const limit = opts.limit ?? 50;
  const maxPages = opts.maxPages ?? 20;
  const out: DepopOrder[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set("cursor", cursor);
    if (opts.since) params.set("since", opts.since);
    const body = await depopFetch<{
      orders?: unknown[];
      results?: unknown[];
      data?: unknown[];
      meta?: { cursor?: string | null; next_cursor?: string | null };
      next_cursor?: string | null;
    }>(token, "GET", `/api/v1/orders?${params.toString()}`);
    const rows = body?.orders ?? body?.results ?? body?.data ?? [];
    for (const r of rows) {
      const parsed = parseDepopOrder(r);
      if (parsed) out.push(parsed);
    }
    const next = body?.meta?.next_cursor ?? body?.meta?.cursor ?? body?.next_cursor ?? null;
    if (!next || rows.length === 0) break;
    cursor = next;
  }
  return out;
}

// ── Shop identity (shop_read) ────────────────────────────────────────────────

export interface DepopShop {
  /** Stable shop/seller id — stored as marketplace_connections.external_account_id. */
  id: string | null;
  /** Seller @handle — stored as account_handle (also a webhook-resolution key). */
  username: string | null;
}

// GET /api/v1/shop — the authenticated seller's shop. Captured at connect time so
// inbound order webhooks (which carry a seller id, not a token) can resolve which
// GradeThread user the event belongs to. Tolerant of field-name variants.
export async function getDepopShop(token: string): Promise<DepopShop> {
  const body = await depopFetch<Record<string, unknown>>(token, "GET", `/api/v1/shop`);
  const o = (body ?? {}) as Record<string, unknown>;
  const shop = (o.shop ?? o) as Record<string, unknown>;
  const id =
    (shop.id != null && String(shop.id)) ||
    (shop.shop_id != null && String(shop.shop_id)) ||
    (shop.seller_id != null && String(shop.seller_id)) ||
    null;
  const username =
    (typeof shop.username === "string" && shop.username) ||
    (typeof shop.handle === "string" && shop.handle) ||
    null;
  return { id, username };
}

// ── Fulfillment (mark-as-shipped) ────────────────────────────────────────────

export interface DepopSellerAddress {
  id: string;
  label: string | null;
}

export async function getSellerAddresses(token: string): Promise<DepopSellerAddress[]> {
  const body = await depopFetch<{ addresses?: unknown[]; results?: unknown[]; data?: unknown[] }>(
    token,
    "GET",
    `/api/v1/shop/seller-addresses/`,
  );
  const rows = body?.addresses ?? body?.results ?? body?.data ?? [];
  return rows
    .map((r) => {
      const o = (r ?? {}) as Record<string, unknown>;
      const id = o.id != null ? String(o.id) : null;
      if (!id) return null;
      const label =
        (typeof o.label === "string" && o.label) ||
        (typeof o.name === "string" && o.name) ||
        null;
      return { id, label };
    })
    .filter((x): x is DepopSellerAddress => x !== null);
}

export interface DepopShippingProvider {
  id: string;
  name: string | null;
}

export async function getShippingProviders(
  token: string,
  addressId: string,
): Promise<DepopShippingProvider[]> {
  const body = await depopFetch<{ providers?: unknown[]; results?: unknown[]; data?: unknown[] }>(
    token,
    "GET",
    `/api/v1/shop/seller-addresses/${encodeURIComponent(addressId)}/shipping-providers/`,
  );
  const rows = body?.providers ?? body?.results ?? body?.data ?? [];
  return rows
    .map((r) => {
      const o = (r ?? {}) as Record<string, unknown>;
      const id = o.id != null ? String(o.id) : null;
      if (!id) return null;
      const name = (typeof o.name === "string" && o.name) || null;
      return { id, name };
    })
    .filter((x): x is DepopShippingProvider => x !== null);
}

// POST /api/v1/orders/{purchase_id}/parcels/{parcel_id}/mark-as-shipped/. An
// optional tracking number + shipping-provider id are sent when provided
// (Depop requires them for some providers). Returns nothing on success.
export async function markDepopParcelShipped(
  token: string,
  purchaseId: string,
  parcelId: string,
  opts: { trackingNumber?: string | null; shippingProviderId?: string | null } = {},
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (opts.trackingNumber) body.tracking_number = opts.trackingNumber;
  if (opts.shippingProviderId) body.shipping_provider_id = opts.shippingProviderId;
  await depopFetch(
    token,
    "POST",
    `/api/v1/orders/${encodeURIComponent(purchaseId)}/parcels/${encodeURIComponent(parcelId)}/mark-as-shipped/`,
    Object.keys(body).length > 0 ? body : {},
  );
}

// ── Fee estimate (pure) ──────────────────────────────────────────────────────
//
// Depop's seller fee is the payment-processing fee only (the 10% selling fee was
// removed for US sellers in 2024); processing is ~3.3% + $0.45 (Depop Payments).
// This is an ESTIMATE for the P&L until the real payout lands via reconciliation
// (mirrors estimateShopifyNet's role). ⚠️ VERIFY the current rate per region.
const DEPOP_PROCESSING_RATE = 0.033;
const DEPOP_PROCESSING_FLAT = 0.45;

export function estimateDepopNet(gross: number): number {
  const fee = gross * DEPOP_PROCESSING_RATE + DEPOP_PROCESSING_FLAT;
  return Math.max(0, Math.round((gross - fee) * 100) / 100);
}

// ── Webhook verification ─────────────────────────────────────────────────────
//
// Depop signs webhook deliveries with an HMAC-SHA256 of the raw body using a
// shared secret configured at partner-onboarding time. We verify the signature
// over the EXACT bytes received (re-serializing would change them), constant-
// time, mirroring the Shopify HMAC path. ⚠️ VERIFY the header name + digest
// encoding (hex vs base64) against Depop's webhook docs when sandbox access
// lands; both encodings are accepted here so a sandbox handshake works either
// way.

export function depopWebhookSecret(): string | undefined {
  const v = Deno.env.get("DEPOP_WEBHOOK_SECRET")?.trim();
  return v && v !== "" ? v : undefined;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * How far a delivery's `X-Depop-Timestamp` may be from our clock (US-2326 AC5).
 *
 * Depop's guide says to "verify the timestamp is within an acceptable timeframe
 * to prevent replay attacks" and does not name a number, so this is ours. Five
 * minutes each way covers ordinary clock skew and retry latency without leaving
 * a captured delivery replayable for an afternoon. Symmetric on purpose: a
 * timestamp in the FUTURE is just as much a sign of a forged or skewed sender as
 * an old one, and accepting it would leave the window open from the other side.
 */
export const DEPOP_WEBHOOK_MAX_SKEW_MS = 5 * 60_000;

/** Pure: is a delivery's timestamp header inside the freshness window? */
export function depopTimestampFresh(
  timestamp: string,
  nowMs: number,
  maxSkewMs: number = DEPOP_WEBHOOK_MAX_SKEW_MS,
): boolean {
  const raw = timestamp.trim();
  if (!raw) return false;
  const n = Number(raw);
  if (!Number.isFinite(n)) return false;
  // Depop sends seconds; a 13-digit value is milliseconds. Distinguished by
  // magnitude rather than by length so it keeps working past the next decade.
  const ms = n > 1e11 ? n : n * 1000;
  return Math.abs(nowMs - ms) <= maxSkewMs;
}

/**
 * Verify a Depop webhook signature.
 *
 * ⚠ THE SIGNED STRING IS `<timestamp>.<body>`, NOT THE BODY (US-2326 AC5, from
 * Depop's own "Validate webhooks" guide, checked 2026-08-17). This function
 * used to HMAC the raw body alone, which was a guess made before the docs were
 * read — and it means every genuine Depop delivery would have been rejected as
 * a signature mismatch. It has never fired in anger only because the connector
 * is still gated off (DEPOP_ENABLED, US-2473), so the bug was queued rather than
 * live.
 *
 * Accepts the digest as hex or base64: the guide does not state which encoding
 * the header carries, and tolerating both costs nothing while a wrong guess
 * costs another silent rejection.
 *
 * Returns false when no secret is configured, so the receiver refuses the event
 * rather than trusting it.
 */
export async function verifyDepopWebhook(
  rawBody: string,
  signature: string,
  timestamp: string,
): Promise<boolean> {
  const secret = depopWebhookSecret();
  if (!secret || !signature || !timestamp.trim()) return false;
  const signed = `${timestamp.trim()}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed)),
  );
  const expectedHex = toHex(mac);
  const expectedB64 = toBase64(mac);
  const got = signature.trim().replace(/^sha256=/i, "");
  return timingSafeEqual(got, expectedHex) || timingSafeEqual(got, expectedB64);
}
