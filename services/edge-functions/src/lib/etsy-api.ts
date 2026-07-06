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
