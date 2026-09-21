// EasyPost as the second shipping-label provider (US-3015).
//
// The eBay path (lib/ebay-logistics.ts) can only price a label for an eBay
// order on a connection that holds the sell.logistics grant, and that grant is
// limited-release. So a Shopify sale, an extension-listed Poshmark sale, or any
// sale at all on a deployment eBay never granted the scope to had no way to buy
// postage in FlipDesk. This module is the answer for all of them.
//
// ── THE BILLING MODEL IS THE WHOLE DESIGN (AC2) ─────────────────────────────
// Sellers are EasyPost REFERRAL CUSTOMERS under our partner account, on
// EasyPost-Managed Billing. The seller enters their own card with EasyPost
// (through EasyPost's Stripe flow, which this code never touches) and EasyPost
// charges THEM for postage. GradeThread never fronts postage, never holds a
// balance, and carries no liability for a carrier reweigh that lands three
// weeks after delivery.
//
// That one choice deletes the prepaid wallet, the Stripe top-up and the
// adjustment-chargeback ledger that an earlier draft of the shipping work
// called for, and those were most of it. There is deliberately NO code here
// that holds, moves or reconciles a seller's postage money, and there should
// never be: grep this file for "balance" and find nothing.
//
// ── PASS-THROUGH AT COST (AC13) ─────────────────────────────────────────────
// Nothing in this module adds a percentage, a per-label fee or a handling
// charge to a carrier rate. The subscription is the entire money model, the
// same as the eBay path. EasyPost bills the seller directly, so a markup here
// would not even reach us — it would only make our prices wrong.
//
// ── THE SHAPE DIFFERENCE FROM eBay, AND WHY IT SIMPLIFIES THINGS ────────────
// eBay is two objects: a shipping_quote you create, then a shipment you buy off
// it. EasyPost is ONE: you create a Shipment, it comes back carrying rates, and
// buying is a POST to that same shipment. So `shippingQuoteId` and `shipmentId`
// are the same `shp_...` id here, which is what makes AC10 cheap — see below.
//
// ── NEVER RETRY A BUY (AC10) ────────────────────────────────────────────────
// buyShipment goes out with retries OFF. EasyPost's buy is idempotent only on
// its own terms, and a retried purchase can bill a second label. Because the
// shipment id exists BEFORE the buy, an unclear 5xx is settled by reading the
// shipment back (getShipment) and looking at postage_label — never by
// re-posting. getEasyPostShipment() + shipmentWasPurchased() below are that
// procedure, written down rather than left to whoever hits it at 2am.
//
// ── TENANCY (AC11, US-268) ──────────────────────────────────────────────────
// Every function here takes an EasyPost API key and EasyPost-side ids only, and
// performs NO ownership check. The caller resolves the local sale, verifies the
// owner, and loads that owner's referral-customer key. An EasyPost id off a
// request body is never enough on its own.

import type {
  LogisticsAddress,
  ParcelSpec,
  PurchasedShipment,
  ShippingQuote,
  ShippingRate,
} from "./logistics-types.ts";

const EASYPOST_BASE = "https://api.easypost.com/v2";
const EASYPOST_TIMEOUT_MS = 25_000;

function readEnv(name: string): string | undefined {
  const v = Deno.env.get(name);
  if (v == null) return undefined;
  const trimmed = v.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Our PARTNER key — the one that creates referral customers. It is never used
 * to buy a label: a purchase always runs on the seller's own referral key, so
 * the charge lands on the seller's card (AC2).
 */
export function partnerApiKey(): string | undefined {
  return readEnv("EASYPOST_API_KEY");
}

/**
 * AC12: with the key absent the EasyPost path must report unavailable rather
 * than throw a 500. Callers check this before anything else, exactly the way
 * the eBay routes check isEbayConfigured().
 */
export function isEasyPostConfigured(): boolean {
  return !!partnerApiKey();
}

export interface EasyPostError extends Error {
  status: number;
  /** EasyPost's own error code, e.g. "PAYMENT.NOT_FOUND". */
  easypostCode?: string;
}

/**
 * True when this failure means "the seller has no usable payment method on
 * their EasyPost account", which is an ONBOARDING state and not an outage.
 *
 * EasyPost answers a buy with no card on file as a 422 in the PAYMENT.* family.
 * AC3 says a seller in that state gets a clean prompt rather than a failed
 * purchase, so this is checked before the buy renders — but it is also checked
 * on the failure, because a card can be removed between the two.
 */
export function isPaymentMethodError(err: unknown): boolean {
  const e = err as EasyPostError | undefined;
  if (!e || typeof e.status !== "number") return false;
  const code = typeof e.easypostCode === "string" ? e.easypostCode : "";
  if (code.startsWith("PAYMENT")) return true;
  if (e.status !== 422) return false;
  return /payment method|billing|credit card/i.test(e.message ?? "");
}

interface FetchOptions {
  method?: string;
  body?: string;
  /**
   * Off by default on purpose. Only the read paths turn it on; a buy must never
   * be retried (AC10).
   */
  retry?: boolean;
}

function authHeader(apiKey: string): string {
  // EasyPost takes the API key as the Basic-auth USERNAME with an empty
  // password. btoa is fine here: an API key is ASCII by construction.
  return `Basic ${btoa(`${apiKey}:`)}`;
}

function easypostError(status: number, body: string): EasyPostError {
  let message = `EasyPost request failed (${status})`;
  let code: string | undefined;
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown; code?: unknown };
    };
    const raw = parsed?.error?.message;
    // EasyPost returns `message` as either a string or an array of strings.
    if (typeof raw === "string" && raw) message = raw;
    else if (Array.isArray(raw) && raw.length) message = raw.map(String).join("; ");
    if (typeof parsed?.error?.code === "string") code = parsed.error.code;
  } catch {
    // Non-JSON body (an edge proxy, a 502 page). Keep the generic message.
    if (body) message = `${message}: ${body.slice(0, 200)}`;
  }
  const err = new Error(message) as EasyPostError;
  err.status = status;
  if (code) err.easypostCode = code;
  return err;
}

async function easypostFetch<T>(
  apiKey: string,
  path: string,
  opts: FetchOptions = {},
): Promise<T> {
  const attempts = opts.retry ? 3 : 1;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EASYPOST_TIMEOUT_MS);
    try {
      const res = await fetch(`${EASYPOST_BASE}${path}`, {
        method: opts.method ?? "GET",
        headers: {
          Authorization: authHeader(apiKey),
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: opts.body,
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        const err = easypostError(res.status, text);
        // A 4xx is the caller's problem and re-sending it changes nothing.
        if (res.status < 500 || attempt === attempts) throw err;
        lastErr = err;
      } else {
        return (text ? JSON.parse(text) : {}) as T;
      }
    } catch (err) {
      if (attempt === attempts) throw err;
      lastErr = err;
    } finally {
      clearTimeout(timer);
    }
    // Linear backoff; the read paths are not latency-critical.
    await new Promise((r) => setTimeout(r, 400 * attempt));
  }
  throw lastErr instanceof Error ? lastErr : new Error("EasyPost request failed");
}

// ── Pure normalizers (unit-tested without a network) ────────────────

/**
 * EasyPost returns money as a decimal STRING of dollars ("7.35"). Read the
 * digits rather than multiplying, for the same reason ebay-logistics.ts does:
 * Number("1.15") * 100 is 114.99999999999999, and a floor on that
 * under-records a cent on some prices and not others.
 */
export function rateToCents(raw: unknown): number | null {
  if (typeof raw !== "string" && typeof raw !== "number") return null;
  const s = String(raw).trim();
  if (!s) return null;
  const m = /^(-?)(\d+)(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) {
    const n = Number(s);
    return Number.isFinite(n) ? Math.round(n * 100) : null;
  }
  const sign = m[1] === "-" ? -1 : 1;
  const whole = Number(m[2]);
  const frac = Number((m[3] ?? "").padEnd(2, "0"));
  return sign * (whole * 100 + frac);
}

/**
 * Every parcel weight EasyPost sees is in OUNCES, whatever unit the caller
 * speaks. Converting here rather than at the route keeps one conversion in the
 * codebase: a 2 lb parcel sent as "2" would be 1/16th of the real weight and
 * would price a label the carrier then bills a reweigh on.
 */
export function toOunces(value: number, unit: ParcelSpec["weightUnit"]): number {
  switch (unit) {
    case "OUNCE":
      return value;
    case "POUND":
      return value * 16;
    case "GRAM":
      return value / 28.349523125;
    case "KILOGRAM":
      return (value * 1000) / 28.349523125;
  }
}

/** Our address shape → EasyPost's. */
export function toEasyPostAddress(
  a: LogisticsAddress,
): Record<string, string | undefined> {
  return {
    name: a.fullName ?? undefined,
    street1: a.addressLine1,
    street2: a.addressLine2 ?? undefined,
    city: a.city,
    state: a.stateOrProvince,
    zip: a.postalCode,
    country: a.countryCode || "US",
    phone: a.phoneNumber ?? undefined,
  };
}

/** Our parcel shape → EasyPost's. Dimensions are all-or-nothing, as on eBay. */
export function toEasyPostParcel(p: ParcelSpec): Record<string, number> {
  const parcel: Record<string, number> = {
    weight: toOunces(p.weightValue, p.weightUnit),
  };
  const toInches = (v: number) =>
    p.dimensionUnit === "CENTIMETER" ? v / 2.54 : v;
  if (p.lengthValue != null && p.widthValue != null && p.heightValue != null) {
    parcel.length = toInches(p.lengthValue);
    parcel.width = toInches(p.widthValue);
    parcel.height = toInches(p.heightValue);
  }
  return parcel;
}

interface RawEasyPostRate {
  id?: string;
  carrier?: string;
  service?: string;
  rate?: string;
  currency?: string;
  delivery_date?: string | null;
  est_delivery_days?: number | null;
  delivery_days?: number | null;
  delivery_date_guaranteed?: boolean;
}

/**
 * Normalize EasyPost's rate array into the shape the route and UI already
 * speak, so the client cannot tell which provider answered except by the
 * `provider` field the route adds.
 *
 * A rate with no id is dropped, same as on the eBay side: an unbuyable rate on
 * the list is a price we would show and then refuse.
 */
export function normalizeEasyPostRates(raw: unknown): ShippingRate[] {
  if (!Array.isArray(raw)) return [];
  const out: ShippingRate[] = [];
  for (const r of raw as RawEasyPostRate[]) {
    if (!r || typeof r.id !== "string" || !r.id) continue;
    const delivery = typeof r.delivery_date === "string" && r.delivery_date
      ? r.delivery_date
      : null;
    out.push({
      rateId: r.id,
      carrier: r.carrier ?? null,
      serviceName: r.service ?? null,
      totalCostCents: rateToCents(r.rate),
      currency: r.currency ?? null,
      // EasyPost gives one estimated delivery date rather than a window.
      // Reporting it as both bounds is honest — it is the estimate — and keeps
      // cheapestRate()'s tie-break working across providers.
      minDeliveryDate: delivery,
      maxDeliveryDate: delivery,
      additionalOptions: r.delivery_date_guaranteed === true
        ? ["GUARANTEED_DELIVERY"]
        : [],
    });
  }
  return out;
}

interface RawEasyPostShipment {
  id?: string;
  reference?: string | null;
  rates?: unknown;
  tracking_code?: string | null;
  selected_rate?: RawEasyPostRate | null;
  postage_label?: { label_url?: string | null } | null;
  refund_status?: string | null;
  status?: string | null;
}

/** A shipment read-back, normalized. Used by the reprint and the AC10 recovery. */
export function normalizeEasyPostShipment(
  raw: unknown,
  fallbackId = "",
): PurchasedShipment {
  const s = (raw ?? {}) as RawEasyPostShipment;
  return {
    shipmentId: s.id ?? fallbackId,
    trackingNumber: s.tracking_code ?? null,
    carrier: s.selected_rate?.carrier ?? null,
    labelDownloadUrl: s.postage_label?.label_url ?? null,
    totalCostCents: rateToCents(s.selected_rate?.rate),
    currency: s.selected_rate?.currency ?? null,
  };
}

/**
 * Did a buy actually land? The single question an unclear 5xx has to answer.
 *
 * A shipment that carries a postage_label URL was bought; one that does not was
 * not. Pure, so the rule is testable without a network and without anyone
 * having to reproduce a timeout.
 */
export function shipmentWasPurchased(shipment: PurchasedShipment): boolean {
  return !!shipment.labelDownloadUrl;
}

// ── API calls ───────────────────────────────────────────────────────

export interface EasyPostQuoteInput {
  shipFrom: LogisticsAddress;
  /**
   * REQUIRED, unlike the eBay path. eBay derives the destination from the order
   * id, so that path never reads or stores a buyer's address. EasyPost has no
   * order to derive from, so the caller supplies one — and the route that does
   * so takes it from the request and NEVER persists it. The PII lives for the
   * length of one rate call.
   */
  shipTo: LogisticsAddress;
  parcel: ParcelSpec;
  /** Printed on the label; usually the item SKU. */
  reference?: string | null;
}

/**
 * Price the parcel. Creates an EasyPost Shipment, which buys nothing — the
 * shipment is unpurchased until buyShipment() is called against it, so this is
 * safe to re-run as the seller adjusts the weight.
 */
export async function createEasyPostQuote(
  apiKey: string,
  input: EasyPostQuoteInput,
): Promise<ShippingQuote> {
  const raw = await easypostFetch<RawEasyPostShipment>(apiKey, "/shipments", {
    method: "POST",
    retry: true,
    body: JSON.stringify({
      shipment: {
        to_address: toEasyPostAddress(input.shipTo),
        from_address: toEasyPostAddress(input.shipFrom),
        parcel: toEasyPostParcel(input.parcel),
        ...(input.reference ? { reference: input.reference.slice(0, 50) } : {}),
      },
    }),
  });
  return {
    shippingQuoteId: raw.id ?? "",
    // EasyPost rates go stale rather than carrying an explicit expiry. Null is
    // the honest answer; inventing a timestamp would be worse than none.
    expiresAt: null,
    rates: normalizeEasyPostRates(raw.rates),
  };
}

/**
 * Re-read a shipment before buying off it, with the reference we stamped on it.
 *
 * THE REFERENCE IS THE BINDING. The shipment id and the rate id both come
 * straight off the request, and nothing else ties either to the sale being
 * charged -- so without this a seller could buy against a shipment they created
 * for a DIFFERENT one of their own sales, and the postage would land on
 * whichever sale is in the URL. EasyPost would not stop it: the shipment is
 * theirs. This is the same guard quoteCoversOrder() is on the eBay side, built
 * on the one field we control.
 */
export async function getEasyPostQuote(
  apiKey: string,
  shipmentId: string,
): Promise<ShippingQuote & { reference: string | null }> {
  const raw = await easypostFetch<RawEasyPostShipment>(
    apiKey,
    `/shipments/${encodeURIComponent(shipmentId)}`,
    { retry: true },
  );
  return {
    shippingQuoteId: raw.id ?? shipmentId,
    expiresAt: null,
    reference: raw.reference ?? null,
    rates: normalizeEasyPostRates(raw.rates),
  };
}

/**
 * Is this shipment actually for this sale? Pure, so the binding rule is
 * testable without a network.
 *
 * An EMPTY reference fails closed, exactly as quoteCoversOrder() does with an
 * empty order list: a shipment we cannot tie to a sale must not be chargeable
 * against one. That also covers a shipment created before this reference was
 * stamped -- re-quoting costs a second and buying the wrong one does not.
 */
export function quoteCoversSale(
  reference: string | null,
  saleId: string,
): boolean {
  if (!saleId || !reference) return false;
  // createEasyPostQuote truncates to 50 characters, so compare on the prefix
  // the wire can actually carry rather than on the full uuid.
  return reference === saleId.slice(0, 50);
}

/**
 * BUY the chosen rate. This charges the SELLER's card, at EasyPost, directly.
 *
 * NOT retried (AC10). On an unclear failure the caller reads the shipment back
 * with getEasyPostShipment() and checks shipmentWasPurchased() — never
 * re-posts.
 */
export async function buyEasyPostShipment(
  apiKey: string,
  shipmentId: string,
  rateId: string,
): Promise<PurchasedShipment> {
  const raw = await easypostFetch<RawEasyPostShipment>(
    apiKey,
    `/shipments/${encodeURIComponent(shipmentId)}/buy`,
    {
      method: "POST",
      retry: false,
      body: JSON.stringify({ rate: { id: rateId } }),
    },
  );
  return normalizeEasyPostShipment(raw, shipmentId);
}

/** Re-read a purchased shipment — the reprint path, and the AC10 recovery. */
export async function getEasyPostShipment(
  apiKey: string,
  shipmentId: string,
): Promise<PurchasedShipment> {
  const raw = await easypostFetch<RawEasyPostShipment>(
    apiKey,
    `/shipments/${encodeURIComponent(shipmentId)}`,
    { retry: true },
  );
  return normalizeEasyPostShipment(raw, shipmentId);
}

/**
 * Void a purchased label. EasyPost refunds the postage to the seller's own
 * account when the carrier accepts the refund; it is asynchronous, so the
 * returned status is `submitted` far more often than `refunded`.
 *
 * Not retried, same reason as the buy.
 */
export async function refundEasyPostShipment(
  apiKey: string,
  shipmentId: string,
): Promise<{ refundStatus: string | null }> {
  const raw = await easypostFetch<RawEasyPostShipment>(
    apiKey,
    `/shipments/${encodeURIComponent(shipmentId)}/refund`,
    { method: "POST", retry: false },
  );
  return { refundStatus: raw.refund_status ?? null };
}

// ── Referral customers (AC2) ────────────────────────────────────────

export interface ReferralCustomer {
  easypostUserId: string;
  /**
   * EasyPost returns the new customer's production API key ONCE, at creation.
   * It is stored encrypted and never returned to a client.
   */
  apiKey: string | null;
}

interface RawReferralCustomer {
  id?: string;
  api_keys?: Array<{ key?: string; mode?: string; active?: boolean }>;
}

/**
 * Pick the production key off a referral-customer response.
 *
 * Exported and pure because getting this wrong is invisible until a seller buys
 * a real label with a test key and it never ships. A test-mode key is never
 * returned, even when it is the only one present — no key at all is a state the
 * caller handles (onboarding), and a test key is one it cannot.
 */
export function productionKeyOf(raw: unknown): string | null {
  const keys = (raw as RawReferralCustomer | null)?.api_keys;
  if (!Array.isArray(keys)) return null;
  for (const k of keys) {
    if (!k || typeof k.key !== "string" || !k.key) continue;
    if (k.active === false) continue;
    if (k.mode === "production") return k.key;
  }
  return null;
}

/**
 * Create a referral customer under our partner account.
 *
 * The seller's own card is attached AFTER this, by the seller, through
 * EasyPost's hosted Stripe flow. GradeThread never sees a card number, a Stripe
 * token or a billing address — which is the whole reason this shape was chosen
 * over a wallet.
 */
export async function createReferralCustomer(
  args: { name: string | null; email: string; phone?: string | null },
): Promise<ReferralCustomer> {
  const partner = partnerApiKey();
  if (!partner) throw new Error("EasyPost is not configured on this server.");
  const raw = await easypostFetch<RawReferralCustomer>(
    partner,
    "/referral_customers",
    {
      method: "POST",
      retry: false,
      body: JSON.stringify({
        user: {
          ...(args.name ? { name: args.name } : {}),
          email: args.email,
          ...(args.phone ? { phone_number: args.phone } : {}),
        },
      }),
    },
  );
  return {
    easypostUserId: raw.id ?? "",
    apiKey: productionKeyOf(raw),
  };
}

interface RawPaymentMethods {
  id?: string;
  primary_payment_method?: unknown;
  secondary_payment_method?: unknown;
}

/**
 * Does this seller have a card EasyPost can charge?
 *
 * AC3: checked BEFORE the buy button renders, so a seller who never finished
 * onboarding gets a prompt instead of a failed purchase. EasyPost answers a
 * never-set-up account with a 404, which is an answer rather than an outage —
 * so it maps to false, and only a different failure throws.
 */
export async function hasPaymentMethod(apiKey: string): Promise<boolean> {
  try {
    const raw = await easypostFetch<RawPaymentMethods>(
      apiKey,
      "/payment_methods",
      { retry: true },
    );
    return !!(raw.primary_payment_method ?? raw.secondary_payment_method);
  } catch (err) {
    const e = err as EasyPostError;
    if (e && (e.status === 404 || isPaymentMethodError(e))) return false;
    throw err;
  }
}
