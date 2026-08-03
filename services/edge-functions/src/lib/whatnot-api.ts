// Whatnot partner API data client for FlipDesk (US-1661) — the transport
// primitive (whatnotFetch) + connect-time shop identity. The LISTING + ORDER
// write/read path is US-1662 and lands on top of this.
//
// ⚠️ MODELED: Whatnot's partner API is private with no public docs. The base URL,
// endpoints, and field names here are MODELED and MUST be reconciled against the
// live API once partner access lands. Kept narrow + tolerant so a rename is a
// one-line change, not a refactor (mirrors the depop-api approach).
//
// SECURITY (US-268): transport-only — takes a token + ids and talks to Whatnot.
// No tenant-scoped DB access; the caller loads owner-scoped rows and passes the
// verified token in.

import { fetchWithTimeout } from "./circuit-breaker.ts";
import { fetchWithRateLimitRetry } from "./http-retry.ts";

const WHATNOT_TIMEOUT_MS = 25_000;
const DEFAULT_API_BASE = "https://api.whatnot.com";

function apiBase(): string {
  const v = Deno.env.get("WHATNOT_API_BASE")?.trim();
  return (v && v !== "" ? v : DEFAULT_API_BASE).replace(/\/$/, "");
}

export class WhatnotApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(message: string, status: number, body = "") {
    super(message);
    this.name = "WhatnotApiError";
    this.status = status;
    this.body = body;
  }
}

// Core authed JSON call (Bearer token). Throws WhatnotApiError on a non-2xx so
// callers can branch on .status (e.g. 404 as already-gone for idempotent delete).
export async function whatnotFetch<T = unknown>(
  token: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
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
    () => fetchWithTimeout(url, init, WHATNOT_TIMEOUT_MS),
    { label: `Whatnot ${method} ${path}` },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new WhatnotApiError(
      `Whatnot ${method} ${path} failed (${res.status})`,
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

export interface WhatnotShop {
  /** Stable shop/seller id — stored as marketplace_connections.external_account_id. */
  id: string | null;
  /** Seller @handle — stored as account_handle. */
  username: string | null;
}

// GET /api/v1/me (MODELED) — the authenticated seller. Captured at connect time
// so a later order sync can resolve the seller. Tolerant of field-name variants.
export async function getWhatnotShop(token: string): Promise<WhatnotShop> {
  const body = await whatnotFetch<Record<string, unknown>>(token, "GET", `/api/v1/me`);
  const o = (body ?? {}) as Record<string, unknown>;
  const shop = (o.shop ?? o.user ?? o) as Record<string, unknown>;
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

// ── Fee estimate (pure) ──────────────────────────────────────────────────────
//
// Whatnot's seller fee (2026, MODELED): ~8% commission + payment processing
// (~2.9% + $0.30). An ESTIMATE for the P&L until the real payout reconciles.
// ⚠️ VERIFY the current rates.
const WHATNOT_COMMISSION_RATE = 0.08;
const WHATNOT_PROCESSING_RATE = 0.029;
const WHATNOT_PROCESSING_FLAT = 0.30;

export function estimateWhatnotNet(gross: number): number {
  const fee = gross * (WHATNOT_COMMISSION_RATE + WHATNOT_PROCESSING_RATE) +
    WHATNOT_PROCESSING_FLAT;
  return Math.max(0, Math.round((gross - fee) * 100) / 100);
}
