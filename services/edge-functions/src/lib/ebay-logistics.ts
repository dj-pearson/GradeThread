// eBay Sell Logistics API v1 client (US-2160): rate-shop and buy a shipping
// label without leaving FlipDesk.
//
// The ship step was the one pipeline step that left the app. FlipDesk could push
// a tracking number the seller bought somewhere else (createShippingFulfillment,
// US-1039) but it could not price or buy the postage — so the real label cost
// was typed into Expenses from memory, or not at all, and every per-item P&L was
// wrong by whatever the seller misremembered.
//
// The flow is two calls, in this order, and the order matters:
//   1. POST /sell/logistics/v1/shipping_quote — describe the parcel and the two
//      addresses; eBay returns a quote id and a list of RATES (carrier, service,
//      price, delivery window). A quote EXPIRES, so rates are not durable.
//   2. POST /sell/logistics/v1/shipment with { shippingQuoteId, rateId } —
//      BUYS the chosen rate. This is the step that charges the seller. It
//      returns the shipment id, the tracking number, and a label download URL.
// Plus the two lifecycle calls: cancel a shipment (voids the label, refunds the
// postage within eBay's window) and re-download the label for a reprint.
//
// MONEY MOVES IN createShipmentFromQuote. It is deliberately NOT retried the way
// a read is: buying twice bills twice and leaves an orphan label. It goes
// through ebayResilientFetch with retry disabled, mirroring why
// publishOfferByInventoryItemGroup uses fetchAuthedOnce.
//
// SCOPE: the Logistics API needs `sell.logistics`, which — like sell.negotiation
// (US-1967) — is NOT on the default consent list, because requesting a scope the
// production keyset isn't licensed for fails the WHOLE consent screen and blocks
// every (re)connect. So callers must gate on isLogisticsScopeAvailable() and the
// per-connection denial flag rather than letting a seller round-trip into a
// guaranteed 403. See logisticsCapability() in routes/flipdesk-logistics.ts.
//
// TENANCY: every function here takes eBay-side ids only and performs NO
// ownership check. Callers MUST resolve the local sale and verify ownership
// first (US-268).

import {
  apiHost,
  ebayResilientFetch,
  getConnectionAccessToken,
  getMarketplaceId,
  getUserAccessToken,
  localeForMarketplace,
} from "./ebay-client.ts";

const LOGISTICS_TIMEOUT_MS = 25_000;

export interface LogisticsError extends Error {
  status: number;
  ebayErrorIds?: number[];
}

/** True when this eBay error is the "you don't hold sell.logistics" 403. */
export function isLogisticsScopeError(err: unknown): boolean {
  const e = err as LogisticsError | undefined;
  if (!e || typeof e.status !== "number") return false;
  if (e.status !== 403) return false;
  return true;
}

async function logisticsFetch<T>(
  userId: string,
  path: string,
  init: RequestInit & { retry?: boolean } = {},
  connectionId?: string,
): Promise<T> {
  const { retry = true, ...requestInit } = init;
  const token = connectionId
    ? await getConnectionAccessToken(connectionId, userId)
    : await getUserAccessToken(userId);
  const locale = localeForMarketplace();
  const method = requestInit.method ?? "GET";
  // A non-retried call still gets the breaker and the timeout — it just never
  // repeats the request, because repeating a purchase bills the seller twice.
  const res = await ebayResilientFetch(
    `${apiHost()}/sell/logistics/v1${path}`,
    {
      ...requestInit,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-EBAY-C-MARKETPLACE-ID": getMarketplaceId(),
        "Accept-Language": locale,
        "Content-Language": locale,
        ...(requestInit.headers ?? {}),
      },
    },
    {
      label: `Logistics${retry ? "" : "(no-retry)"} ${method} ${path}`,
      timeoutMs: LOGISTICS_TIMEOUT_MS,
      ...(retry ? {} : { retry: { maxAttempts: 1 } }),
    },
  );

  if (!res.ok) {
    const text = await res.text();
    const err = new Error(
      `eBay Logistics ${method} ${path} failed (${res.status}): ${
        text.slice(0, 500)
      }`,
    ) as LogisticsError;
    err.status = res.status;
    try {
      const parsed = JSON.parse(text) as { errors?: Array<{ errorId?: number }> };
      if (Array.isArray(parsed.errors)) {
        err.ebayErrorIds = parsed.errors
          .map((e) => e.errorId)
          .filter((id): id is number => typeof id === "number");
      }
    } catch {
      // Non-JSON error body — leave ebayErrorIds undefined.
    }
    throw err;
  }
  const body = await res.text();
  return (body ? JSON.parse(body) : {}) as T;
}

// ── Wire shapes ─────────────────────────────────────────────────────

export interface LogisticsAddress {
  fullName?: string | null;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  stateOrProvince: string;
  postalCode: string;
  countryCode: string;
  phoneNumber?: string | null;
}

export interface ParcelSpec {
  /** Weight in the unit eBay expects for the marketplace (POUND for US). */
  weightValue: number;
  weightUnit: "POUND" | "KILOGRAM" | "OUNCE" | "GRAM";
  lengthValue?: number | null;
  widthValue?: number | null;
  heightValue?: number | null;
  dimensionUnit?: "INCH" | "CENTIMETER";
}

/** One purchasable rate off a quote, normalized to what the UI needs. */
export interface ShippingRate {
  rateId: string;
  carrier: string | null;
  serviceName: string | null;
  /** Total the seller pays, in whole cents. */
  totalCostCents: number | null;
  currency: string | null;
  /** eBay's min/max delivery estimate, ISO dates, when supplied. */
  minDeliveryDate: string | null;
  maxDeliveryDate: string | null;
  /** True when eBay flags the rate as requiring extra seller action. */
  additionalOptions: string[];
}

export interface ShippingQuote {
  shippingQuoteId: string;
  /** ISO expiry — a rate cannot be bought after this. */
  expiresAt: string | null;
  rates: ShippingRate[];
}

export interface PurchasedShipment {
  shipmentId: string;
  trackingNumber: string | null;
  carrier: string | null;
  labelDownloadUrl: string | null;
  /** What eBay actually charged, in whole cents. */
  totalCostCents: number | null;
  currency: string | null;
}

// ── Pure normalizers (unit-tested without a network) ────────────────

/**
 * eBay returns money as `{ value: "7.35", currency: "USD" }` decimal STRINGS.
 * Parse to whole cents by reading the digits, not by multiplying.
 *
 * `Number("1.15") * 100` is 114.99999999999999, and the same holds for 4.35,
 * 2.03, 19.99 and plenty of ordinary postage prices. `Math.round` happens to
 * rescue all of those, but the very common `| 0` / `Math.floor` does not — it
 * under-records a cent, silently and only on some prices, which is the worst
 * shape a money bug can have. Reading the integer and fractional parts out of
 * the string is exact and doesn't depend on picking the right rounding.
 */
export function moneyToCents(
  money: { value?: unknown; currency?: unknown } | null | undefined,
): number | null {
  const raw = money?.value;
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = /^(-?)(\d+)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) {
    // Fall back to float parsing for an unexpected shape (e.g. more decimal
    // places) rather than dropping the cost entirely.
    const n = Number(s);
    return Number.isFinite(n) ? Math.round(n * 100) : null;
  }
  const sign = m[1] === "-" ? -1 : 1;
  const whole = Number(m[2]);
  const frac = Number((m[3] ?? "").padEnd(2, "0"));
  return sign * (whole * 100 + frac);
}

interface RawRate {
  rateId?: string;
  shippingCarrierCode?: string;
  shippingCarrierName?: string;
  shippingServiceName?: string;
  shippingServiceCode?: string;
  baseShippingCost?: { value?: string; currency?: string };
  totalShippingCost?: { value?: string; currency?: string };
  minEstimatedDeliveryDate?: { value?: string } | string;
  maxEstimatedDeliveryDate?: { value?: string } | string;
  additionalOptions?: Array<{ additionalOptionType?: string }>;
}

function dateValue(v: { value?: string } | string | undefined): string | null {
  if (typeof v === "string") return v || null;
  return v?.value ?? null;
}

/** Normalize eBay's rate array into the shape the route and UI speak. */
export function normalizeRates(raw: unknown): ShippingRate[] {
  if (!Array.isArray(raw)) return [];
  const out: ShippingRate[] = [];
  for (const r of raw as RawRate[]) {
    if (!r || typeof r.rateId !== "string" || !r.rateId) continue;
    // Prefer the TOTAL (what the seller is charged); base excludes surcharges,
    // and pricing off base would understate every label.
    const cost = moneyToCents(r.totalShippingCost) ??
      moneyToCents(r.baseShippingCost);
    out.push({
      rateId: r.rateId,
      carrier: r.shippingCarrierName ?? r.shippingCarrierCode ?? null,
      serviceName: r.shippingServiceName ?? r.shippingServiceCode ?? null,
      totalCostCents: cost,
      currency: r.totalShippingCost?.currency ?? r.baseShippingCost?.currency ??
        null,
      minDeliveryDate: dateValue(r.minEstimatedDeliveryDate),
      maxDeliveryDate: dateValue(r.maxEstimatedDeliveryDate),
      additionalOptions: (r.additionalOptions ?? [])
        .map((o) => o?.additionalOptionType)
        .filter((t): t is string => typeof t === "string"),
    });
  }
  return out;
}

/**
 * Cheapest rate with a known price.
 *
 * A rate whose cost we could not parse is NOT a candidate — treating an unknown
 * as free would make it win every comparison and auto-select the one rate we
 * cannot record a cost for, which is exactly the manual-entry problem this story
 * exists to remove. Ties break on the earlier delivery estimate.
 */
export function cheapestRate(rates: ShippingRate[]): ShippingRate | null {
  let best: ShippingRate | null = null;
  for (const r of rates) {
    if (r.totalCostCents == null) continue;
    if (best == null || r.totalCostCents < best.totalCostCents!) {
      best = r;
      continue;
    }
    if (r.totalCostCents === best.totalCostCents) {
      const a = r.maxDeliveryDate ?? "";
      const b = best.maxDeliveryDate ?? "";
      if (a && (!b || a < b)) best = r;
    }
  }
  return best;
}

/** Find a rate by id — the purchase path must never buy an id it didn't show. */
export function findRate(
  rates: ShippingRate[],
  rateId: string,
): ShippingRate | null {
  return rates.find((r) => r.rateId === rateId) ?? null;
}

// ── API calls ───────────────────────────────────────────────────────

export interface ShippingQuoteInput {
  orderId: string;
  shipFrom: LogisticsAddress;
  /**
   * Omit it. eBay derives the destination from the order id, so we never have
   * to read, pass, or store the buyer's address to price a label — the PII stays
   * on eBay's side. Present only for the rare case of quoting to a
   * seller-supplied address.
   */
  shipTo?: LogisticsAddress;
  parcel: ParcelSpec;
}

/**
 * Step 1: price the parcel. Returns the quote id plus every purchasable rate.
 * Safe to retry — a quote reserves nothing and costs nothing.
 */
export async function createShippingQuote(
  userId: string,
  input: ShippingQuoteInput,
  connectionId?: string,
): Promise<ShippingQuote> {
  const body = {
    orders: [{ orderId: input.orderId }],
    shipFrom: input.shipFrom,
    ...(input.shipTo ? { shipTo: input.shipTo } : {}),
    packageSpecification: {
      weight: {
        value: input.parcel.weightValue,
        unit: input.parcel.weightUnit,
      },
      ...(input.parcel.lengthValue != null &&
          input.parcel.widthValue != null &&
          input.parcel.heightValue != null
        ? {
          dimensions: {
            length: input.parcel.lengthValue,
            width: input.parcel.widthValue,
            height: input.parcel.heightValue,
            unit: input.parcel.dimensionUnit ?? "INCH",
          },
        }
        : {}),
    },
  };
  const raw = await logisticsFetch<{
    shippingQuoteId?: string;
    expirationDate?: { value?: string } | string;
    rates?: unknown;
  }>(userId, "/shipping_quote", {
    method: "POST",
    body: JSON.stringify(body),
  }, connectionId);
  return {
    shippingQuoteId: raw.shippingQuoteId ?? "",
    expiresAt: dateValue(raw.expirationDate),
    rates: normalizeRates(raw.rates),
  };
}

/**
 * Step 2: BUY the chosen rate. This charges the seller.
 *
 * NOT retried: eBay has no idempotency key here, so a retried purchase buys a
 * second label and bills a second time. A timeout therefore surfaces as an
 * error the seller must resolve by re-checking, which is the correct failure
 * mode for money — the alternative silently double-charges.
 */
export async function createShipmentFromQuote(
  userId: string,
  args: {
    shippingQuoteId: string;
    rateId: string;
    /** Printed on the label; usually the buyer's reference or the item SKU. */
    labelCustomMessage?: string | null;
  },
  connectionId?: string,
): Promise<PurchasedShipment> {
  const raw = await logisticsFetch<{
    shipmentId?: string;
    trackingNumber?: string;
    shipmentTrackingNumber?: string;
    labelDownloadUrl?: string;
    labelDownloadURL?: string;
    rate?: RawRate;
    totalShippingCost?: { value?: string; currency?: string };
  }>(userId, "/shipment", {
    method: "POST",
    retry: false,
    body: JSON.stringify({
      shippingQuoteId: args.shippingQuoteId,
      rateId: args.rateId,
      ...(args.labelCustomMessage
        ? { labelCustomMessage: args.labelCustomMessage }
        : {}),
    }),
  }, connectionId);
  const cost = moneyToCents(raw.totalShippingCost) ??
    moneyToCents(raw.rate?.totalShippingCost);
  return {
    shipmentId: raw.shipmentId ?? "",
    trackingNumber: raw.trackingNumber ?? raw.shipmentTrackingNumber ?? null,
    carrier: raw.rate?.shippingCarrierName ?? raw.rate?.shippingCarrierCode ??
      null,
    labelDownloadUrl: raw.labelDownloadUrl ?? raw.labelDownloadURL ?? null,
    totalCostCents: cost,
    currency: raw.totalShippingCost?.currency ??
      raw.rate?.totalShippingCost?.currency ?? null,
  };
}

/**
 * Re-read a quote before buying off it.
 *
 * The purchase takes a quote id and a rate id straight from the client, and
 * nothing on our side ties either to the sale being charged. Without this read,
 * a seller can buy against a quote created for a DIFFERENT one of their own
 * sales and the postage is recorded on whichever sale is in the URL — the exact
 * mis-attribution the story exists to remove. eBay would stop a cross-account
 * quote (the token is the seller's own), but nothing would stop this one.
 */
export async function getShippingQuote(
  userId: string,
  shippingQuoteId: string,
  connectionId?: string,
): Promise<ShippingQuote & { orderIds: string[] }> {
  const raw = await logisticsFetch<{
    shippingQuoteId?: string;
    expirationDate?: { value?: string } | string;
    rates?: unknown;
    orders?: Array<{ orderId?: string }>;
  }>(
    userId,
    `/shipping_quote/${encodeURIComponent(shippingQuoteId)}`,
    {},
    connectionId,
  );
  return {
    shippingQuoteId: raw.shippingQuoteId ?? shippingQuoteId,
    expiresAt: dateValue(raw.expirationDate),
    rates: normalizeRates(raw.rates),
    orderIds: (raw.orders ?? [])
      .map((o) => o?.orderId)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  };
}

/**
 * Is this quote actually for this order? Pure, so the binding rule is testable
 * without a network. An EMPTY orderIds list fails closed: a quote we cannot tie
 * to an order must not be chargeable against one.
 */
export function quoteCoversOrder(
  orderIds: readonly string[],
  orderId: string,
): boolean {
  if (!orderId) return false;
  return orderIds.includes(orderId);
}

/** Re-read a purchased shipment — the reprint path (label URLs expire). */
export async function getShipment(
  userId: string,
  shipmentId: string,
  connectionId?: string,
): Promise<PurchasedShipment> {
  const raw = await logisticsFetch<{
    shipmentId?: string;
    trackingNumber?: string;
    labelDownloadUrl?: string;
    rate?: RawRate;
    totalShippingCost?: { value?: string; currency?: string };
  }>(userId, `/shipment/${encodeURIComponent(shipmentId)}`, {}, connectionId);
  return {
    shipmentId: raw.shipmentId ?? shipmentId,
    trackingNumber: raw.trackingNumber ?? null,
    carrier: raw.rate?.shippingCarrierName ?? raw.rate?.shippingCarrierCode ??
      null,
    labelDownloadUrl: raw.labelDownloadUrl ?? null,
    totalCostCents: moneyToCents(raw.totalShippingCost) ??
      moneyToCents(raw.rate?.totalShippingCost),
    currency: raw.totalShippingCost?.currency ?? null,
  };
}

/**
 * Void a purchased label. eBay refunds the postage when it's inside their
 * cancellation window; outside it, this fails and the seller keeps the charge.
 * Not retried, same reason as the purchase.
 */
export async function cancelShipment(
  userId: string,
  shipmentId: string,
  connectionId?: string,
): Promise<void> {
  await logisticsFetch<unknown>(
    userId,
    `/shipment/${encodeURIComponent(shipmentId)}/cancel`,
    { method: "POST", retry: false },
    connectionId,
  );
}
