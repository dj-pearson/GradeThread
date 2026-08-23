import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  estimateParcel,
  PARCEL_TABLE_VERSION,
  type ParcelEstimate,
  type ParcelGarmentCategory,
} from "../lib/parcel-estimate.ts";
import { resolveShoeSizeScale } from "../lib/shoe-size-scale.ts";
import { resolveDepartment } from "../lib/aspect-registry.ts";
import { failSafe, jsonError } from "../lib/http-errors.ts";
import { isEbayConfigured, isLogisticsScopeAvailable } from "../lib/ebay-client.ts";
import {
  cancelShipment,
  createShipmentFromQuote,
  createShippingQuote,
  findRate,
  getShipment,
  getShippingQuote,
  isLogisticsScopeError,
  quoteCoversOrder,
  type LogisticsAddress,
  type ParcelSpec,
  type ShippingRate,
} from "../lib/ebay-logistics.ts";
import { createShippingFulfillment } from "../lib/ebay-client.ts";
import { decryptBusinessPhone, decryptShipFrom } from "../lib/user-shipping-pii.ts";

// eBay shipping labels inside FlipDesk (US-2160).
//
// The ship step used to leave the app: FlipDesk could push a tracking number the
// seller bought elsewhere, but not price or buy the postage — so the real label
// cost reached Expenses only if the seller retyped it from memory. These routes
// close that loop:
//
//   GET  /capabilities            can this seller buy labels at all?
//   POST /sales/:saleId/rates     price the parcel → quote id + rate options
//   POST /sales/:saleId/label     buy a rate → tracking, label, recorded cost
//   GET  /sales/:saleId/label     reprint (eBay label URLs expire)
//   POST /sales/:saleId/label/void  cancel the shipment, undo the recorded cost
//
// SECURITY (US-268): the edge uses the service-role client, which BYPASSES RLS.
// Every route here resolves the sale THROUGH inventory_items.user_id before it
// touches eBay or writes anything — a saleId from the request body is never
// trusted on its own.
//
// CAPABILITY (AC5, mirroring US-1967): sell.logistics is a limited-release
// scope granted per keyset, so it is absent from the default consent list —
// requesting an unlicensed scope fails the WHOLE consent screen. Clients ask
// /capabilities first and hide the entry point, instead of discovering the
// truth from a 403 in the middle of buying postage.

export const flipdeskLogisticsRoutes = new Hono<{
  Variables: { userId: string; workspaceOwnerId: string };
}>();

// ── Capability ────────────────────────────────────────────────────

export interface LogisticsCapability {
  label_purchase_available: boolean;
  /** Machine-readable reason when unavailable; null when it works. */
  code: "feature_unavailable" | "reconnect_required" | null;
  /** Honest, seller-facing copy for the disabled state; null when available. */
  detail: string | null;
}

const LOGISTICS_UNAVAILABLE = {
  code: "feature_unavailable" as const,
  detail:
    "Buying shipping labels in GradeThread isn't switched on for this server yet. Buy your label in eBay and paste the tracking number here.",
};

const LOGISTICS_RECONNECT = {
  code: "reconnect_required" as const,
  detail:
    "Your eBay connection predates label purchasing. Reconnect your eBay account in Marketplaces to buy labels here.",
};

/**
 * Pure capability resolution — exported for tests.
 * - deployment lacks the scope → permanently unavailable for everyone, so the
 *   copy must NOT suggest reconnecting; nothing the seller does can fix it.
 * - deployment has it but THIS token 403'd → the token predates the grant, and
 *   a re-consent genuinely fixes it.
 */
export function logisticsCapability(
  deploymentHasScope: boolean,
  connectionDenied: boolean,
): LogisticsCapability {
  if (!deploymentHasScope) {
    return {
      label_purchase_available: false,
      code: LOGISTICS_UNAVAILABLE.code,
      detail: LOGISTICS_UNAVAILABLE.detail,
    };
  }
  if (connectionDenied) {
    return {
      label_purchase_available: false,
      code: LOGISTICS_RECONNECT.code,
      detail: LOGISTICS_RECONNECT.detail,
    };
  }
  return { label_purchase_available: true, code: null, detail: null };
}

async function readLogisticsDenied(ownerId: string): Promise<boolean> {
  try {
    // supabase-js reports query failures in `error` rather than throwing, so the
    // fail-open has to check it explicitly — the catch below only covers a
    // transport-level throw. Before 00509 applies, an unknown-column error lands
    // here, and "not denied" is the right answer: the capability then rests on
    // the deployment scope alone, which is the honest signal at that point.
    const { data, error } = await supabaseAdmin
      .from("marketplace_connections")
      .select("logistics_access_denied")
      .eq("user_id", ownerId) // US-268
      // The column is `marketplace`, NOT `platform` (00008). supabaseAdmin is
      // untyped, so a wrong name is a silent 42703 that reads as "no row".
      .eq("marketplace", "ebay")
      .eq("is_active", true)
      // A seller may hold more than one eBay connection (US-671); without this
      // maybeSingle() errors on the second row and the gate silently opens.
      .limit(1)
      .maybeSingle();
    if (error) {
      console.warn(
        "[flipdesk-logistics] capability flag read failed:",
        error.message,
      );
      return false;
    }
    return (data as { logistics_access_denied: boolean | null } | null)
      ?.logistics_access_denied === true;
  } catch (err) {
    // Fail OPEN on a transport blip too: a momentary DB outage must not
    // permanently hide a working feature.
    console.warn(
      "[flipdesk-logistics] capability flag read threw:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/** Set/clear the sticky denial flag. Best-effort — never fails the request. */
async function setLogisticsDenied(
  ownerId: string,
  denied: boolean,
): Promise<void> {
  try {
    let q = supabaseAdmin
      .from("marketplace_connections")
      .update({ logistics_access_denied: denied })
      .eq("user_id", ownerId) // US-268
      .eq("marketplace", "ebay");
    // Only clear rows that are actually set, so a success doesn't rewrite every
    // connection row on every call.
    if (!denied) q = q.eq("logistics_access_denied", true);
    await q;
  } catch (err) {
    console.warn(
      "[flipdesk-logistics] denial flag write failed:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

flipdeskLogisticsRoutes.get("/capabilities", async (c) => {
  if (!isEbayConfigured()) {
    return c.json({ error: "eBay is not configured on this server." }, 503);
  }
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const denied = await readLogisticsDenied(ownerId);
  return c.json(logisticsCapability(isLogisticsScopeAvailable(), denied));
});

/**
 * The rate a purchase is about to buy, or null when that id was never on this
 * quote. Called by the purchase path (not just tests) — buying an id we never
 * showed the seller would charge them a price they never saw.
 */
export function assertRateOnQuote(
  rates: ShippingRate[],
  rateId: string,
): ShippingRate | null {
  return findRate(rates, rateId);
}

// ── Shared loading + validation ───────────────────────────────────

interface SaleRow {
  id: string;
  platform_order_id: string | null;
  tracking_number: string | null;
  shipped_at: string | null;
  ebay_shipment_id: string | null;
  shipping_cost: number | null;
  inventory_item_id: string | null;
}

/**
 * Load a sale the caller actually owns. Joins through inventory_items.user_id —
 * the sale row is never fetched by id alone (US-268).
 */
async function loadOwnedSale(
  ownerId: string,
  saleId: string,
): Promise<SaleRow | null> {
  const { data } = await supabaseAdmin
    .from("sales")
    .select(
      "id, platform_order_id, tracking_number, shipped_at, ebay_shipment_id, shipping_cost, inventory_item_id, inventory_items!inner(user_id)",
    )
    .eq("id", saleId)
    .eq("inventory_items.user_id", ownerId)
    .maybeSingle();
  return (data as unknown as SaleRow | null) ?? null;
}

interface ShipFromRow {
  line1?: unknown;
  line2?: unknown;
  city?: unknown;
  state?: unknown;
  postal_code?: unknown;
  country?: unknown;
}

/**
 * The seller's ship-from address (US-1442, users.ship_from_address). Returns
 * null when it is missing or incomplete — eBay rejects a partial address with an
 * opaque error, so the route says which field is missing instead.
 */
export function toLogisticsAddress(
  raw: unknown,
  name: string | null,
  phone: string | null,
): LogisticsAddress | null {
  if (!raw || typeof raw !== "object") return null;
  const a = raw as ShipFromRow;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const line1 = str(a.line1);
  const city = str(a.city);
  const state = str(a.state);
  const postalCode = str(a.postal_code);
  const countryCode = str(a.country) || "US";
  if (!line1 || !city || !state || !postalCode) return null;
  return {
    fullName: name,
    addressLine1: line1,
    addressLine2: str(a.line2) || null,
    city,
    stateOrProvince: state,
    postalCode,
    countryCode,
    phoneNumber: phone,
  };
}

/**
 * Parse the parcel spec off a request body.
 *
 * US-2790: `fallbackOz` is a PREDICTED weight from the garment's own
 * measurements, used only when the body carries none. Before it, a seller
 * retyped a weight on every single sale, and the route simply refused without
 * one — for a garment the system had already measured.
 *
 * The body still WINS whenever it has a weight. A caller that names a number is
 * making a statement about this parcel, and a prediction must never overwrite a
 * seller who put the thing on a scale. The fallback only fills a hole.
 */
export function parseParcel(
  body: unknown,
  fallbackOz?: number | null,
): ParcelSpec | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
  const supplied = num(b.weight_value);
  const predicted = num(fallbackOz);
  const weight = supplied ?? predicted;
  if (weight == null) {
    return { error: "A parcel weight above zero is required." };
  }
  // The predicted value is in OUNCES by construction, so a body that named no
  // weight also named no unit worth honouring. Reading b.weight_unit here would
  // let a stale "POUND" from an earlier request turn 12 oz into 12 lb.
  const unit = supplied == null
    ? "OUNCE"
    : b.weight_unit === "OUNCE"
    ? "OUNCE"
    : b.weight_unit === "KILOGRAM"
    ? "KILOGRAM"
    : b.weight_unit === "GRAM"
    ? "GRAM"
    : "POUND";
  const length = num(b.length_value);
  const width = num(b.width_value);
  const height = num(b.height_value);
  // eBay wants all three dimensions or none — sending one is an error there and
  // a confusing one, so drop a partial set rather than pass it through.
  const complete = length != null && width != null && height != null;
  return {
    weightValue: weight,
    weightUnit: unit,
    lengthValue: complete ? length : null,
    widthValue: complete ? width : null,
    heightValue: complete ? height : null,
    dimensionUnit: b.dimension_unit === "CENTIMETER" ? "CENTIMETER" : "INCH",
  };
}

/**
 * Billable ounces predicted from the garment's own record, or null.
 *
 * Best-effort by design: this exists so a seller who never typed a weight can
 * still price a label. A read failure returns null, which puts the route back
 * to asking for a weight — the behaviour it had before — rather than failing
 * the rate call over a prediction.
 */
async function predictedParcel(
  ownerId: string,
  inventoryItemId: string | null,
): Promise<ParcelEstimate | null> {
  if (!inventoryItemId) return null;
  try {
    const { data, error } = await supabaseAdmin
      .from("inventory_items")
      .select(
        "garment_category, material, measurements, size, brand, title, style, description, condition_notes, item_category, attributes",
      )
      .eq("id", inventoryItemId)
      .eq("user_id", ownerId)
      .maybeSingle();
    if (error || !data) return null;
    const row = data as {
      garment_category: ParcelGarmentCategory | null;
      material: string | null;
      measurements: Record<string, number | string> | null;
      size: string | null;
      brand: string | null;
      title: string | null;
      style: string | null;
      description: string | null;
      condition_notes: string | null;
      item_category: string | null;
      attributes: Record<string, string | string[]> | null;
    };
    return estimateParcel({
      garmentCategory: row.garment_category,
      material: row.material,
      measurements: row.measurements,
      size: row.size,
      // US-2796: which scale the stamped shoe number is on, read from the
      // brand's curated chart. Resolved unconditionally because it is cheap and
      // because sizeFactor() only consults it inside its shoe branch — passing
      // it for a hoodie is inert, and gating here would mean a third copy of
      // the SHOE_SIZED list to keep in step with parcel-estimate's.
      //
      // Null for anything uncertain, and null is exactly today's behaviour: a
      // shoe with no scale is read as US men's, which is what every existing
      // row was recorded under.
      sizeScale: resolveShoeSizeScale(
        row.brand,
        resolveDepartment({
          item_category: row.item_category,
          attributes: row.attributes,
          title: row.title,
          style: row.style,
          description: row.description,
          condition_notes: row.condition_notes,
          size: row.size,
        }),
      ),
    });
  } catch {
    return null;
  }
}

/**
 * The shape stored in sales.predicted_parcel (US-2790, migration 00649).
 *
 * THE TABLE VERSION IS NOT DECORATION. Rows predicted under different weights
 * or multipliers are not comparable, and averaging them makes the error look
 * smaller than it is on both. Without this field a later correction cannot be
 * attributed to the table that produced it, and the whole predicted-vs-actual
 * loop degrades into one undated average.
 */
interface PredictedParcelRecord {
  weightOz: number;
  billableWeightOz: number;
  pack: string;
  confidence: string;
  basis: string[];
  tableVersion: string;
  predictedAt: string;
}

/**
 * Record what was predicted, beside what the carrier will later charge.
 *
 * BEST-EFFORT AND NEVER FATAL. This is a measurement of our own accuracy; a
 * seller pricing a label must not see an error because we failed to write our
 * own telemetry.
 *
 * WRITTEN ONLY WHEN THE PREDICTION WAS ACTUALLY USED. A row recording a number
 * the seller overrode is not a prediction that was tested — it is a prediction
 * nobody shipped — and mixing those into the comparison measures the estimator
 * against parcels it never described.
 *
 * FIRST WRITE WINS, for the same reason the column is written at pre-fill
 * rather than at purchase: the value worth keeping is what we said when the
 * seller was deciding, not what we would say now. Re-running the rates call
 * after they adjust something must not overwrite the original claim.
 */
async function recordPrediction(
  ownerId: string,
  saleId: string,
  parcel: ParcelEstimate,
): Promise<void> {
  const record: PredictedParcelRecord = {
    weightOz: parcel.weightOz,
    billableWeightOz: parcel.billableWeightOz,
    pack: parcel.pack,
    confidence: parcel.confidence,
    basis: parcel.basis,
    tableVersion: PARCEL_TABLE_VERSION,
    predictedAt: new Date().toISOString(),
  };
  try {
    await supabaseAdmin
      .from("sales")
      .update({ predicted_parcel: record })
      .eq("id", saleId)
      .eq("user_id", ownerId)
      .is("predicted_parcel", null);
  } catch (err) {
    console.error(
      `[logistics] predicted_parcel write failed for sale ${saleId}:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Translate an eBay logistics failure into a client response, flipping the
 * sticky denial flag on a scope 403 so every later render can gate cheaply.
 * Returns the (status, body) pair rather than a Response so callers keep
 * control of the shape.
 */
async function logisticsFailure(
  ownerId: string,
  err: unknown,
  fallback: string,
): Promise<{ status: 501 | 502; body: Record<string, unknown> }> {
  if (isLogisticsScopeError(err)) {
    await setLogisticsDenied(ownerId, true);
    const cap = logisticsCapability(isLogisticsScopeAvailable(), true);
    return {
      status: 501,
      body: { error: cap.detail, code: cap.code },
    };
  }
  return {
    status: 502,
    body: {
      error: fallback,
      detail: err instanceof Error ? err.message.slice(0, 500) : String(err),
    },
  };
}

/** Shared preflight: capability + eBay config + owned sale with an order id. */
async function preflight(
  ownerId: string,
  saleId: string,
): Promise<
  | { ok: true; sale: SaleRow; orderId: string }
  | { ok: false; status: 404 | 409 | 501 | 503; body: Record<string, unknown> }
> {
  if (!isEbayConfigured()) {
    return {
      ok: false,
      status: 503,
      body: { error: "eBay is not configured on this server." },
    };
  }
  const cap = logisticsCapability(
    isLogisticsScopeAvailable(),
    await readLogisticsDenied(ownerId),
  );
  if (!cap.label_purchase_available) {
    return { ok: false, status: 501, body: { error: cap.detail, code: cap.code } };
  }
  const sale = await loadOwnedSale(ownerId, saleId);
  if (!sale) return { ok: false, status: 404, body: { error: "Sale not found." } };
  if (!sale.platform_order_id) {
    return {
      ok: false,
      status: 409,
      body: {
        error: "This sale has no eBay order, so there's no label to buy here.",
      },
    };
  }
  return { ok: true, sale, orderId: sale.platform_order_id };
}

// ── POST /sales/:saleId/rates ─────────────────────────────────────
// Price the parcel. Buys nothing and reserves nothing, so it is safe to re-run
// as the seller adjusts the weight.
flipdeskLogisticsRoutes.post("/sales/:saleId/rates", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const saleId = c.req.param("saleId");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }

  const pre = await preflight(ownerId, saleId);
  if (!pre.ok) return c.json(pre.body, pre.status);

  // US-2790: predict the parcel from the garment we already measured, so a
  // seller who has not typed a weight still gets rates. Owner-scoped on
  // user_id even though preflight already proved ownership of the SALE — the
  // service-role client bypasses RLS, and an id taken from a joined row is
  // still an id from a request (US-268).
  const predicted = await predictedParcel(ownerId, pre.sale.inventory_item_id);
  const parcel = parseParcel(body, predicted?.billableWeightOz ?? null);
  if ("error" in parcel) return jsonError(c, 400, parcel.error);

  // US-2790: record the prediction only when it was the number actually USED.
  // A body that named its own weight overrode us, and storing our guess beside
  // a parcel it never described would measure the estimator against shipments
  // it did not predict. `suppliedWeight` is the same test parseParcel applied.
  const suppliedWeight = (body as Record<string, unknown> | null)?.weight_value;
  const usedPrediction = predicted != null &&
    !(typeof suppliedWeight === "number" && Number.isFinite(suppliedWeight) &&
      suppliedWeight > 0);
  if (usedPrediction) await recordPrediction(ownerId, saleId, predicted);

  const { data: userRow } = await supabaseAdmin
    .from("users")
    .select("ship_from_address, business_name, business_phone, full_name")
    .eq("id", ownerId)
    .maybeSingle();
  const u = userRow as
    | {
      ship_from_address: unknown;
      business_name: string | null;
      business_phone: string | null;
      full_name: string | null;
    }
    | null;
  // US-2417 AC1/AC6: both of these are now ciphertext bound to the owner, so the
  // label path decrypts before it builds the address. A decrypt failure must NOT
  // read as "no address" — that renders as the 409 below telling the seller to
  // add one in Settings, where they would find it already filled in. Fail loud.
  let shipFromRaw: unknown;
  let phone: string | null;
  try {
    shipFromRaw = await decryptShipFrom(ownerId, u?.ship_from_address);
    phone = await decryptBusinessPhone(ownerId, u?.business_phone ?? null);
  } catch (err) {
    console.error(
      `[logistics] ship-from decrypt failed for ${ownerId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return c.json({
      error: "Your ship-from address could not be unlocked. Support has been notified.",
      code: "ship_from_locked",
    }, 503);
  }
  const shipFrom = toLogisticsAddress(
    shipFromRaw,
    u?.business_name ?? u?.full_name ?? null,
    phone,
  );
  if (!shipFrom) {
    // A 409, not a 500: nothing is broken, the seller just hasn't told us where
    // they ship from. The message names the exact place to fix it.
    return c.json({
      error:
        "Add your ship-from address in Settings before buying a label — eBay needs it to price postage.",
      code: "ship_from_missing",
    }, 409);
  }

  try {
    const quote = await createShippingQuote(ownerId, {
      orderId: pre.orderId,
      shipFrom,
      parcel,
    });
    // A successful call proves the scope works — clear any stale denial.
    await setLogisticsDenied(ownerId, false);
    return c.json({
      shipping_quote_id: quote.shippingQuoteId,
      expires_at: quote.expiresAt,
      rates: quote.rates,
    });
  } catch (err) {
    console.error("[flipdesk-logistics] shipping quote failed:", err);
    const f = await logisticsFailure(
      ownerId,
      err,
      "eBay couldn't price this shipment.",
    );
    return c.json(f.body, f.status);
  }
});

// ── POST /sales/:saleId/label ─────────────────────────────────────
// BUY the chosen rate. This charges the seller, so the shape is strict: the
// caller must name both the quote and the rate it was shown. Nothing is
// defaulted, and the cheapest rate is never auto-picked server-side — a wrong
// default here spends the seller's money.
flipdeskLogisticsRoutes.post("/sales/:saleId/label", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const saleId = c.req.param("saleId");
  let body: {
    shipping_quote_id?: unknown;
    rate_id?: unknown;
    rates?: unknown;
    label_message?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, "Invalid JSON body");
  }
  const quoteId = typeof body.shipping_quote_id === "string"
    ? body.shipping_quote_id.trim()
    : "";
  const rateId = typeof body.rate_id === "string" ? body.rate_id.trim() : "";
  if (!quoteId || !rateId) {
    return jsonError(c, 400, "shipping_quote_id and rate_id are required");
  }

  const pre = await preflight(ownerId, saleId);
  if (!pre.ok) return c.json(pre.body, pre.status);
  const { sale } = pre;

  // Already bought → return what we have rather than buying a second label.
  // Without this, a double-click or a retried request bills the seller twice.
  if (sale.ebay_shipment_id) {
    return c.json({
      already_purchased: true,
      shipment_id: sale.ebay_shipment_id,
      tracking_number: sale.tracking_number,
    });
  }

  // Bind the quote to THIS sale before spending anything. The two ids come
  // straight off the request, and nothing else ties them to the sale being
  // charged — without this, a seller could buy against a quote created for a
  // different one of their own sales and the postage would land on whichever
  // sale is in the URL. That is the mis-attribution this story removes, so the
  // extra read is worth it on the one route that spends money.
  try {
    const quote = await getShippingQuote(ownerId, quoteId);
    if (!quoteCoversOrder(quote.orderIds, pre.orderId)) {
      return c.json({
        error: "That shipping quote isn't for this sale. Get rates again.",
        code: "quote_order_mismatch",
      }, 409);
    }
    if (!assertRateOnQuote(quote.rates, rateId)) {
      // Also catches an EXPIRED quote whose rates eBay no longer returns —
      // better a re-quote than a purchase at a price we never showed.
      return c.json({
        error: "That shipping rate is no longer on the quote. Get rates again.",
        code: "rate_not_on_quote",
      }, 409);
    }
  } catch (err) {
    console.error("[flipdesk-logistics] quote re-read failed:", err);
    const f = await logisticsFailure(
      ownerId,
      err,
      "eBay couldn't confirm this shipping quote.",
    );
    return c.json(f.body, f.status);
  }

  let shipment;
  try {
    shipment = await createShipmentFromQuote(ownerId, {
      shippingQuoteId: quoteId,
      rateId,
      labelCustomMessage: typeof body.label_message === "string"
        ? body.label_message.slice(0, 50)
        : null,
    });
    await setLogisticsDenied(ownerId, false);
  } catch (err) {
    console.error("[flipdesk-logistics] label purchase failed:", err);
    const f = await logisticsFailure(
      ownerId,
      err,
      "eBay couldn't buy this label.",
    );
    return c.json(f.body, f.status);
  }

  // AC2: the real postage becomes the sale's shipping cost, so Finances and the
  // per-item P&L stop depending on the seller retyping it. Only write a cost we
  // actually got back — overwriting a real number with 0 would be worse than
  // leaving it alone.
  const patch: Record<string, unknown> = {
    ebay_shipment_id: shipment.shipmentId,
    label_purchased_at: new Date().toISOString(),
  };
  if (shipment.totalCostCents != null) {
    patch.shipping_cost = shipment.totalCostCents / 100;
  }
  if (shipment.trackingNumber) patch.tracking_number = shipment.trackingNumber;
  if (shipment.carrier) patch.carrier = shipment.carrier;
  const { error: updErr } = await supabaseAdmin
    .from("sales")
    .update(patch)
    .eq("id", sale.id)
    // Belt and braces (US-268): preflight already proved ownership through
    // inventory_items, but this write records money, and the predicate is free
    // and index-backed. It keeps the write self-evidently safe instead of safe
    // by reference to a helper sixty lines away.
    .eq("user_id", ownerId);
  if (updErr) {
    // The label IS bought and the seller HAS been charged — never report that as
    // a failure. Log loudly; the shipment id is in the response either way.
    console.error(
      "[flipdesk-logistics] label bought but sale write-back failed:",
      updErr.message,
    );
  }

  // AC3: the tracking number goes to eBay through the EXISTING fulfillment path
  // rather than a second implementation, so the buyer sees tracking and the
  // seller keeps late-shipment protection. Best-effort: the label is already
  // paid for, so a fulfillment hiccup must not read as "the purchase failed" —
  // the seller can still mark shipped from the normal button.
  let pushedToEbay = false;
  if (shipment.trackingNumber) {
    try {
      await createShippingFulfillment(ownerId, pre.orderId, {
        trackingNumber: shipment.trackingNumber,
        carrier: shipment.carrier,
      });
      pushedToEbay = true;
      await supabaseAdmin
        .from("sales")
        .update({ shipped_at: sale.shipped_at ?? new Date().toISOString() })
        .eq("id", sale.id)
        .eq("user_id", ownerId); // US-268 belt and braces
    } catch (err) {
      console.error(
        "[flipdesk-logistics] fulfillment push after label purchase failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return c.json({
    ok: true,
    shipment_id: shipment.shipmentId,
    tracking_number: shipment.trackingNumber,
    carrier: shipment.carrier,
    label_download_url: shipment.labelDownloadUrl,
    cost_cents: shipment.totalCostCents,
    currency: shipment.currency,
    marked_shipped_on_ebay: pushedToEbay,
  });
});

// ── GET /sales/:saleId/label ──────────────────────────────────────
// Reprint. eBay's label URLs expire, so this re-reads the shipment for a fresh
// one instead of handing back a stored link that 404s a week later.
flipdeskLogisticsRoutes.get("/sales/:saleId/label", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const saleId = c.req.param("saleId");
  const pre = await preflight(ownerId, saleId);
  if (!pre.ok) return c.json(pre.body, pre.status);
  const shipmentId = pre.sale.ebay_shipment_id;
  if (!shipmentId) {
    return c.json({ error: "No label was bought here for this sale." }, 404);
  }
  try {
    const shipment = await getShipment(ownerId, shipmentId);
    return c.json({
      shipment_id: shipment.shipmentId,
      tracking_number: shipment.trackingNumber,
      carrier: shipment.carrier,
      label_download_url: shipment.labelDownloadUrl,
      cost_cents: shipment.totalCostCents,
      currency: shipment.currency,
    });
  } catch (err) {
    console.error("[flipdesk-logistics] label reprint failed:", err);
    const f = await logisticsFailure(
      ownerId,
      err,
      "eBay couldn't return this label.",
    );
    return c.json(f.body, f.status);
  }
});

// ── POST /sales/:saleId/label/void ────────────────────────────────
// Cancel the shipment. eBay refunds the postage inside its window and refuses
// outside it — either way, only clear the local record when eBay accepted, so a
// refused void never leaves the sale looking label-less while the charge stands.
flipdeskLogisticsRoutes.post("/sales/:saleId/label/void", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  const saleId = c.req.param("saleId");
  const pre = await preflight(ownerId, saleId);
  if (!pre.ok) return c.json(pre.body, pre.status);
  const shipmentId = pre.sale.ebay_shipment_id;
  if (!shipmentId) {
    return c.json({ error: "No label was bought here for this sale." }, 404);
  }
  try {
    await cancelShipment(ownerId, shipmentId);
  } catch (err) {
    console.error("[flipdesk-logistics] label void failed:", err);
    const f = await logisticsFailure(
      ownerId,
      err,
      "eBay wouldn't cancel this label.",
    );
    return c.json(f.body, f.status);
  }
  const { error } = await supabaseAdmin
    .from("sales")
    .update({
      ebay_shipment_id: null,
      label_purchased_at: null,
      // The postage is refunded, so the recorded cost is no longer real.
      shipping_cost: 0,
    })
    .eq("id", pre.sale.id)
    // US-268 belt and braces: this zeroes a financial column, so it must not
    // rest solely on an ownership check made in another function.
    .eq("user_id", ownerId);
  if (error) {
    return failSafe(
      c,
      500,
      "The label was cancelled but we couldn't update the sale.",
      error,
      "logistics.void",
    );
  }
  return c.json({ ok: true });
});

