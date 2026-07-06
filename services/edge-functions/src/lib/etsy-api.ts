// Etsy Open API v3 data client for FlipDesk (US-1659) — the transport primitive
// (etsyFetch) + connect-time shop identity resolution. The LISTING + RECEIPT
// write/read path (create/update/delist listings, taxonomy + shipping-profile
// resolution, binary image upload, order sync) is US-1660 and lands on top of
// this.
//
// ⚠️ AUTH: every Etsy DATA API call requires BOTH headers:
//   Authorization: Bearer <oauth access token>
//   x-api-key: <app keystring>   (etsy-client.getEtsyKeystring())
// The keystring identifies the app; the Bearer token identifies the seller. A
// call missing x-api-key 401s even with a valid token.
//
// SECURITY (US-268): this module is transport-only — it takes a token + keystring
// + ids and talks to Etsy. It performs NO tenant-scoped DB access. The caller
// (etsy adapter / the routes) loads rows scoped to the workspace owner and passes
// the verified token in.

import { fetchWithTimeout } from "./circuit-breaker.ts";
import { getEtsyKeystring } from "./etsy-client.ts";

const ETSY_TIMEOUT_MS = 25_000;

// Base URL for the data API. Overridable so a sandbox host can be pointed at
// without a code change (mirrors etsy-client's ETSY_AUTH_URL/ETSY_TOKEN_URL).
const DEFAULT_API_BASE = "https://api.etsy.com";

function apiBase(): string {
  const v = Deno.env.get("ETSY_API_BASE")?.trim();
  return (v && v !== "" ? v : DEFAULT_API_BASE).replace(/\/$/, "");
}

export class EtsyApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body = "") {
    super(message);
    this.name = "EtsyApiError";
    this.status = status;
    this.body = body;
  }
}

// Core authed JSON call. Sends the OAuth Bearer token AND the app keystring as
// x-api-key. Throws EtsyApiError on a non-2xx so callers can branch on .status
// (e.g. treat 404 as already-gone for an idempotent delete). Throws before any
// network call if the keystring is not configured (the connector is off).
export async function etsyFetch<T = unknown>(
  token: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const keystring = getEtsyKeystring();
  if (!keystring) {
    throw new EtsyApiError("Etsy keystring (ETSY_KEYSTRING) is not configured.", 503);
  }
  const url = path.startsWith("http") ? path : `${apiBase()}${path}`;
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "x-api-key": keystring,
      Accept: "application/json",
      ...(body != null ? { "Content-Type": "application/json" } : {}),
    },
    ...(body != null ? { body: JSON.stringify(body) } : {}),
  };
  const res = await fetchWithTimeout(url, init, ETSY_TIMEOUT_MS);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new EtsyApiError(
      `Etsy ${method} ${path} failed (${res.status})`,
      res.status,
      text.slice(0, 1000),
    );
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined as T;
  }
}

// ── Shop identity (shops_r) ──────────────────────────────────────────────────

export interface EtsyShopIdentity {
  /** Stable numeric shop id — stored as marketplace_connections.external_account_id. */
  shopId: string | null;
  /** Shop name (@handle equivalent) — stored as account_handle. */
  shopName: string | null;
  /** The Etsy user id that owns the token. */
  userId: string | null;
}

// GET /v3/application/users/me → { user_id, shop_id }. The Etsy access token is
// formatted "{user_id}.{secret}", so the user id is also recoverable from the
// token prefix; we prefer the API response and fall back to the prefix.
export async function getEtsyMe(
  token: string,
): Promise<{ userId: string | null; shopId: string | null }> {
  const body = await etsyFetch<Record<string, unknown>>(
    token,
    "GET",
    "/v3/application/users/me",
  );
  const o = (body ?? {}) as Record<string, unknown>;
  const userId = o.user_id != null ? String(o.user_id) : tokenUserId(token);
  const shopId = o.shop_id != null ? String(o.shop_id) : null;
  return { userId, shopId };
}

// The Etsy access token is "{user_id}.{secret}"; recover the user id from the
// prefix as a fallback when /users/me omits it. Pure + unit-tested.
export function tokenUserId(token: string): string | null {
  const prefix = token.split(".")[0];
  return prefix && /^\d+$/.test(prefix) ? prefix : null;
}

// GET /v3/application/shops/{shop_id} → { shop_id, shop_name }.
export async function getEtsyShopName(
  token: string,
  shopId: string,
): Promise<string | null> {
  const body = await etsyFetch<Record<string, unknown>>(
    token,
    "GET",
    `/v3/application/shops/${encodeURIComponent(shopId)}`,
  );
  const o = (body ?? {}) as Record<string, unknown>;
  return typeof o.shop_name === "string" ? o.shop_name : null;
}

// Resolve the connected seller's shop identity, captured at connect time so a
// later order sync can match the seller. Best-effort: a failure to resolve the
// shop name still returns the ids. Tolerant of a seller with no shop yet
// (shopId null → shopName null).
export async function getEtsyShopIdentity(token: string): Promise<EtsyShopIdentity> {
  const me = await getEtsyMe(token);
  let shopName: string | null = null;
  if (me.shopId) {
    try {
      shopName = await getEtsyShopName(token, me.shopId);
    } catch {
      shopName = null;
    }
  }
  return { shopId: me.shopId, shopName, userId: me.userId };
}

// ── Fee estimate (pure) ──────────────────────────────────────────────────────
//
// Etsy's seller fees (2026): 6.5% transaction fee + $0.20 listing fee + payment
// processing (~3% + $0.25 in the US). This is an ESTIMATE for the P&L until the
// real payout lands via reconciliation (mirrors estimateDepopNet's role).
// ⚠️ VERIFY the current rates per region.
const ETSY_TRANSACTION_RATE = 0.065;
const ETSY_PROCESSING_RATE = 0.03;
const ETSY_PROCESSING_FLAT = 0.25;
const ETSY_LISTING_FEE = 0.20;

export function estimateEtsyNet(gross: number): number {
  const fee = gross * (ETSY_TRANSACTION_RATE + ETSY_PROCESSING_RATE) +
    ETSY_PROCESSING_FLAT + ETSY_LISTING_FEE;
  return Math.max(0, Math.round((gross - fee) * 100) / 100);
}

// ── Listing lifecycle (US-1660) ──────────────────────────────────────────────
//
// ⚠️ VERIFY: the exact field names below are modeled from the Etsy Open API v3
// docs (2026-06). They MUST be reconciled against the live API once a sandbox /
// approved app lands. Etsy specifics that shape this module:
//   • Listing create/update take application/x-www-form-urlencoded (NOT JSON).
//   • Money in RESPONSES is {amount, divisor, currency_code}; in create REQUESTS
//     `price` is a plain decimal string.
//   • Images must be uploaded as BINARY multipart to a separate endpoint — Etsy
//     does NOT accept image URLs. Publish is therefore: create (draft) → upload
//     each image → PATCH state=active.
//   • A physical listing REQUIRES taxonomy_id + shipping_profile_id +
//     who_made/when_made + type=physical.

// Authed form-urlencoded call (Bearer + x-api-key). Etsy create/update use this.
async function etsyFetchForm<T = unknown>(
  token: string,
  method: "POST" | "PUT" | "PATCH",
  path: string,
  params: URLSearchParams,
): Promise<T> {
  const keystring = getEtsyKeystring();
  if (!keystring) {
    throw new EtsyApiError("Etsy keystring (ETSY_KEYSTRING) is not configured.", 503);
  }
  const url = path.startsWith("http") ? path : `${apiBase()}${path}`;
  const res = await fetchWithTimeout(
    url,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "x-api-key": keystring,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: params,
    },
    ETSY_TIMEOUT_MS,
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new EtsyApiError(
      `Etsy ${method} ${path} failed (${res.status})`,
      res.status,
      text.slice(0, 1000),
    );
  }
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined as T;
  }
}

// Etsy money → decimal. Responses carry {amount, divisor, currency_code}; the
// value is amount/divisor (divisor is usually 100). Pure + unit-tested.
export function etsyMoney(
  m: { amount?: unknown; divisor?: unknown } | number | null | undefined,
): number {
  if (m == null) return 0;
  if (typeof m === "number") return m;
  const amount = typeof m.amount === "number" ? m.amount : Number(m.amount ?? 0);
  const divisor = typeof m.divisor === "number" && m.divisor > 0
    ? m.divisor
    : Number(m.divisor) || 100;
  if (!Number.isFinite(amount)) return 0;
  return Math.round((amount / divisor) * 100) / 100;
}

export interface EtsyListingInput {
  /** Draft listing text. */
  title: string;
  description: string;
  price: number;
  currency?: string;
  quantity?: number;
  /** Etsy taxonomy leaf id (numeric). Required for a physical listing. */
  taxonomyId: number;
  /** The seller's shipping profile id. Required for a physical listing. */
  shippingProfileId: number;
  /** i_did | someone_else | collective. Reseller default: someone_else. */
  whoMade?: string;
  /** made_to_order | YYYY_YYYY | before_YYYY. Reseller default: before_2005 (vintage) or a recent range. */
  whenMade?: string;
  /** Craft supply flag — false for finished garments. */
  isSupply?: boolean;
  materials?: string[];
  /** Up to 13 tags, each ≤20 chars, no commas. */
  tags?: string[];
}

// Builds the form body for POST/PATCH a listing. Pure: no env, no I/O, so it
// unit-tests directly. Omits empty optionals. Arrays (tags/materials) are sent as
// repeated params (Etsy v3's array-in-form convention). Tags are sanitized to
// Etsy's rules (≤13, ≤20 chars, no commas).
export function buildEtsyListingParams(input: EtsyListingInput): URLSearchParams {
  const p = new URLSearchParams();
  p.set("quantity", String(input.quantity && input.quantity > 0 ? Math.round(input.quantity) : 1));
  p.set("title", input.title.slice(0, 140));
  p.set("description", input.description);
  p.set("price", input.price.toFixed(2));
  p.set("who_made", input.whoMade ?? "someone_else");
  p.set("when_made", input.whenMade ?? "before_2005");
  p.set("taxonomy_id", String(input.taxonomyId));
  p.set("shipping_profile_id", String(input.shippingProfileId));
  p.set("type", "physical");
  p.set("is_supply", String(input.isSupply ?? false));
  for (const m of (input.materials ?? []).filter(Boolean).slice(0, 13)) {
    p.append("materials", m.slice(0, 45));
  }
  const tags = (input.tags ?? [])
    .map((t) => t.replace(/,/g, " ").trim())
    .filter(Boolean)
    .map((t) => t.slice(0, 20))
    .slice(0, 13);
  for (const t of tags) p.append("tags", t);
  return p;
}

export interface EtsyListingResult {
  /** The Etsy listing id we persist as platform_listing_id. */
  listingId: string | null;
  listingUrl: string | null;
}

function parseListingResult(body: unknown): EtsyListingResult {
  const o = (body ?? {}) as Record<string, unknown>;
  const listingId = o.listing_id != null ? String(o.listing_id) : null;
  const listingUrl = typeof o.url === "string"
    ? o.url
    : (listingId ? `https://www.etsy.com/listing/${listingId}` : null);
  return { listingId, listingUrl };
}

// Create a DRAFT listing. Returns its listing id + url. Images + activation are
// separate steps (uploadEtsyListingImage + setEtsyListingState).
export async function createEtsyListing(
  token: string,
  shopId: string,
  input: EtsyListingInput,
): Promise<EtsyListingResult> {
  const body = await etsyFetchForm(
    token,
    "POST",
    `/v3/application/shops/${encodeURIComponent(shopId)}/listings`,
    buildEtsyListingParams(input),
  );
  return parseListingResult(body);
}

// Update an existing listing's fields (idempotent create-or-replace of content).
export async function updateEtsyListing(
  token: string,
  shopId: string,
  listingId: string,
  input: EtsyListingInput,
): Promise<EtsyListingResult> {
  const body = await etsyFetchForm(
    token,
    "PATCH",
    `/v3/application/shops/${encodeURIComponent(shopId)}/listings/${encodeURIComponent(listingId)}`,
    buildEtsyListingParams(input),
  );
  return parseListingResult(body);
}

// Set a listing's state (active | inactive | draft). Publish flips a completed
// draft to active; delist flips it to inactive. A 404 (listing gone) is returned
// as "gone" so an idempotent delist doesn't error.
export async function setEtsyListingState(
  token: string,
  shopId: string,
  listingId: string,
  state: "active" | "inactive" | "draft",
): Promise<"ok" | "gone"> {
  const p = new URLSearchParams();
  p.set("state", state);
  try {
    await etsyFetchForm(
      token,
      "PATCH",
      `/v3/application/shops/${encodeURIComponent(shopId)}/listings/${encodeURIComponent(listingId)}`,
      p,
    );
    return "ok";
  } catch (err) {
    if (err instanceof EtsyApiError && err.status === 404) return "gone";
    throw err;
  }
}

// Upload one image (binary multipart) to a listing. Etsy rejects image URLs, so
// we fetch the bytes from our public item-photos URL and POST the blob. `rank`
// orders the images (1 = primary). Best-effort: the caller collects failures.
export async function uploadEtsyListingImage(
  token: string,
  shopId: string,
  listingId: string,
  imageUrl: string,
  rank: number,
): Promise<boolean> {
  const keystring = getEtsyKeystring();
  if (!keystring) return false;
  // Fetch the source bytes (public item-photos URL).
  const imgRes = await fetchWithTimeout(imageUrl, { method: "GET" }, ETSY_TIMEOUT_MS);
  if (!imgRes.ok) return false;
  const blob = await imgRes.blob();
  const form = new FormData();
  form.append("image", blob, `image_${rank}.jpg`);
  form.append("rank", String(rank));
  // NOTE: do NOT set Content-Type — fetch derives the multipart boundary.
  const res = await fetchWithTimeout(
    `${apiBase()}/v3/application/shops/${encodeURIComponent(shopId)}/listings/${encodeURIComponent(listingId)}/images`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "x-api-key": keystring,
        Accept: "application/json",
      },
      body: form,
    },
    ETSY_TIMEOUT_MS,
  );
  if (!res.ok) {
    await res.body?.cancel();
    return false;
  }
  await res.body?.cancel();
  return true;
}

// ── Shipping profiles (US-1660) ───────────────────────────────────────────────

export interface EtsyShippingProfile {
  shippingProfileId: string;
  title: string | null;
}

// A physical listing requires a shipping_profile_id. Resolve the seller's
// profiles; the caller picks one (default: the first).
export async function getEtsyShippingProfiles(
  token: string,
  shopId: string,
): Promise<EtsyShippingProfile[]> {
  const body = await etsyFetch<{ results?: unknown[] }>(
    token,
    "GET",
    `/v3/application/shops/${encodeURIComponent(shopId)}/shipping-profiles`,
  );
  const rows = body?.results ?? [];
  return rows
    .map((r) => {
      const o = (r ?? {}) as Record<string, unknown>;
      const id = o.shipping_profile_id != null ? String(o.shipping_profile_id) : null;
      if (!id) return null;
      const title = typeof o.title === "string" ? o.title : null;
      return { shippingProfileId: id, title };
    })
    .filter((x): x is EtsyShippingProfile => x !== null);
}

// Default taxonomy leaf when a per-platform variant carries none. Etsy REQUIRES a
// valid leaf id; the operator sets ETSY_DEFAULT_TAXONOMY_ID (e.g. a "Women's
// Clothing" leaf) so a reseller item without a resolved category still publishes.
export function defaultEtsyTaxonomyId(): number | null {
  const v = Deno.env.get("ETSY_DEFAULT_TAXONOMY_ID")?.trim();
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ── Receipts / orders (transactions_r) (US-1660) ──────────────────────────────

export interface EtsyTransaction {
  /** The listing id this line sold — links back to our listings.platform_listing_id. */
  listingId: string | null;
  sku: string | null;
  quantity: number;
  price: number;
}

export interface EtsyReceipt {
  receiptId: string;
  status: string | null;
  currency: string;
  total: number;
  buyerName: string | null;
  soldAt: string | null;
  isShipped: boolean;
  transactions: EtsyTransaction[];
}

function tsToIso(v: unknown): string | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}

// Pure: normalize an Etsy receipt resource into our internal EtsyReceipt. Returns
// null when there is no usable receipt id. Tolerant of field-name variants.
export function parseEtsyReceipt(payload: unknown): EtsyReceipt | null {
  const o = (payload ?? {}) as Record<string, unknown>;
  const receiptId = o.receipt_id != null ? String(o.receipt_id) : "";
  if (!receiptId) return null;

  const status = typeof o.status === "string" ? o.status : null;
  const total = etsyMoney(
    (o.grandtotal ?? o.total_price ?? o.totalPrice) as
      | { amount?: unknown; divisor?: unknown }
      | number
      | undefined,
  );
  const grand = (o.grandtotal ?? {}) as { currency_code?: unknown };
  const currency = typeof grand.currency_code === "string" ? grand.currency_code : "USD";

  const buyerName = (typeof o.name === "string" && o.name) ||
    (typeof o.buyer_email === "string" && o.buyer_email) || null;
  const soldAt = tsToIso(o.created_timestamp ?? o.create_timestamp);
  const isShipped = o.is_shipped === true;

  const txRaw = Array.isArray(o.transactions) ? o.transactions : [];
  const transactions: EtsyTransaction[] = txRaw.map((t) => {
    const tx = (t ?? {}) as Record<string, unknown>;
    const listingId = tx.listing_id != null ? String(tx.listing_id) : null;
    const sku = typeof tx.sku === "string" && tx.sku ? tx.sku : null;
    const quantity = tx.quantity != null ? Number(tx.quantity) || 1 : 1;
    const price = etsyMoney(
      (tx.price) as { amount?: unknown; divisor?: unknown } | number | undefined,
    );
    return { listingId, sku, quantity, price };
  });

  return { receiptId, status, currency, total, buyerName, soldAt, isShipped, transactions };
}

// Pure: map an Etsy receipt status to a terminal sale status, or null when it's
// still a live sale. Etsy marks refunds/cancellations via status.
export function etsyRefundStatus(receipt: EtsyReceipt): "cancelled" | "refunded" | null {
  const s = (receipt.status ?? "").toLowerCase();
  if (/cancel/.test(s)) return "cancelled";
  if (/refund/.test(s)) return "refunded";
  return null;
}

// GET /v3/application/shops/{shop_id}/receipts — paginated by offset/limit.
// Returns parsed receipts across pages (bounded by maxPages).
export async function listEtsyReceipts(
  token: string,
  shopId: string,
  opts: { limit?: number; maxPages?: number } = {},
): Promise<EtsyReceipt[]> {
  const limit = opts.limit ?? 50;
  const maxPages = opts.maxPages ?? 20;
  const out: EtsyReceipt[] = [];
  for (let page = 0; page < maxPages; page++) {
    const offset = page * limit;
    const body = await etsyFetch<{ count?: number; results?: unknown[] }>(
      token,
      "GET",
      `/v3/application/shops/${encodeURIComponent(shopId)}/receipts?limit=${limit}&offset=${offset}`,
    );
    const rows = body?.results ?? [];
    for (const r of rows) {
      const parsed = parseEtsyReceipt(r);
      if (parsed) out.push(parsed);
    }
    if (rows.length < limit) break;
  }
  return out;
}
