import { Hono } from "hono";
import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  estimateParcel,
  PARCEL_TABLE_VERSION,
  type ParcelEstimate,
  type ParcelGarmentCategory,
} from "../lib/parcel-estimate.ts";
import { resolveShoeSizeScaleForItem } from "../lib/shoe-size-scale.ts";
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
import { featureAllowedForUser } from "../lib/plan-gate.ts";
import {
  buyEasyPostShipment,
  createEasyPostQuote,
  getEasyPostQuote,
  getEasyPostShipment,
  isEasyPostConfigured,
  isPaymentMethodError,
  quoteCoversSale,
  refundEasyPostShipment,
  shipmentWasPurchased,
} from "../lib/easypost.ts";
import {
  easypostReadiness,
  ensureEasyPostAccount,
  loadEasyPostAccount,
} from "../lib/easypost-account.ts";
import type { LabelProvider } from "../lib/logistics-types.ts";

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
// PLAN (US-3011): label buying is a Pro capability — the `shippingLabels` gate
// flag. The postage itself is passed through at eBay's rate with no markup, so
// the subscription is the entire money model; eBay's own label flow and Pirate
// Ship are both free, and a margin on postage would be found and resented.
// The gate covers the two routes that SPEND money (rates and buy). Reprint and
// void stay open on every plan on purpose: a seller who downgrades after buying
// a label must still be able to print it and to claim the refund. Locking a
// void would strand their money behind an upsell.
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
  code:
    | "feature_unavailable"
    | "plan_locked"
    | "reconnect_required"
    | "easypost_onboarding_required"
    | null;
  /** Honest, seller-facing copy for the disabled state; null when available. */
  detail: string | null;
  /**
   * US-3015: which provider would buy this label. Null when none can. Additive
   * -- the two booleans above kept their meaning, so no client had to change.
   */
  provider: LabelProvider | null;
}

const LOGISTICS_UNAVAILABLE = {
  code: "feature_unavailable" as const,
  detail:
    "Buying shipping labels in GradeThread isn't switched on for this server yet. Buy your label on the marketplace and paste the tracking number here.",
};

const LOGISTICS_PLAN_LOCKED = {
  code: "plan_locked" as const,
  detail:
    "Buying shipping labels here is part of Pro. Upgrade to buy postage in the app, or buy your label on the marketplace and paste the tracking number here.",
};

const LOGISTICS_RECONNECT = {
  code: "reconnect_required" as const,
  detail:
    "Your eBay connection predates label purchasing. Reconnect your eBay account in Marketplaces to buy labels here.",
};

const EASYPOST_ONBOARDING = {
  code: "easypost_onboarding_required" as const,
  detail:
    "Add a card with EasyPost to buy postage here. You pay EasyPost directly at their rates -- GradeThread never handles the postage money.",
};

/**
 * US-3015: everything the provider decision reads, in one shape.
 *
 * It is an object rather than six positional booleans because the old
 * three-argument form already had two adjacent booleans that meant opposite
 * things, and this adds three more.
 */
export interface LabelCapabilityInput {
  /** This deployment requested sell.logistics AND eBay granted the keyset. */
  ebayScope: boolean;
  /** This seller's eBay token has 403'd a logistics call (the sticky flag). */
  ebayDenied: boolean;
  /** EASYPOST_API_KEY is set on this deployment (AC12). */
  easypostConfigured: boolean;
  /** This seller has an EasyPost customer WITH a payment method on it. */
  easypostReady: boolean;
  /**
   * The sale being shipped is an eBay order. False for a Shopify sale, an
   * extension-listed Poshmark sale, or a sale recorded by hand -- none of which
   * eBay will price a label for at any scope.
   */
  saleIsEbay: boolean;
  /** The workspace OWNER's plan includes shippingLabels (US-3011). */
  planAllows: boolean;
}

/**
 * Which provider buys this label, or null when none can. Pure (AC4).
 *
 * THE FALLBACK IS THE POINT. eBay wins only when it actually works: the sale
 * is an eBay order, the deployment holds the scope, and this seller's token has
 * not been refused. Anything else -- a Shopify sale, a deployment eBay never
 * licensed, a token that 403'd -- goes to EasyPost when EasyPost is configured.
 *
 * The last branch is the one that is easy to get wrong. A refused eBay token
 * with NO EasyPost configured still resolves to eBay, because "reconnect your
 * eBay account" is then a true and actionable thing to tell the seller. Drop
 * that branch and the same seller is told the feature does not exist.
 */
export function resolveLabelProvider(
  input: LabelCapabilityInput,
): LabelProvider | null {
  if (input.saleIsEbay && input.ebayScope && !input.ebayDenied) return "ebay";
  if (input.easypostConfigured) return "easypost";
  if (input.saleIsEbay && input.ebayScope) return "ebay";
  return null;
}

/**
 * Which provider ALREADY bought this sale's label, or null when none did.
 *
 * US-3015: reprint and void dispatch on this, NEVER on what
 * resolveLabelProvider() would choose today. A seller whose deployment gains
 * eBay's scope next month must still be able to reprint and refund the EasyPost
 * label they bought this month -- and today's preference would send both calls
 * to the wrong API, where the id does not exist.
 *
 * label_provider is read first because it is the recorded fact. The id columns
 * are the fallback for rows written before 00816's backfill, and for a row
 * where the backfill has not run yet.
 */
export function providerOfPurchase(sale: {
  label_provider: string | null;
  ebay_shipment_id: string | null;
  easypost_shipment_id: string | null;
}): { provider: LabelProvider; shipmentId: string } | null {
  if (sale.label_provider === "easypost" && sale.easypost_shipment_id) {
    return { provider: "easypost", shipmentId: sale.easypost_shipment_id };
  }
  if (sale.label_provider === "ebay" && sale.ebay_shipment_id) {
    return { provider: "ebay", shipmentId: sale.ebay_shipment_id };
  }
  if (sale.easypost_shipment_id) {
    return { provider: "easypost", shipmentId: sale.easypost_shipment_id };
  }
  if (sale.ebay_shipment_id) {
    return { provider: "ebay", shipmentId: sale.ebay_shipment_id };
  }
  return null;
}

/**
 * Pure capability resolution -- exported for tests.
 *
 * THE ORDER IS THE POINT, and US-3015 added one step to it without changing
 * the reasoning behind the other three.
 *
 * 1. NO PROVIDER can serve -> permanently unavailable for this sale, so the
 *    copy must NOT suggest reconnecting or upgrading; nothing the seller does
 *    fixes it. US-3015 is what made this state rare: it used to mean "this
 *    deployment has no eBay scope", which left the EasyPost fallback
 *    unreachable behind a check about eBay (AC5). It now means what it says.
 * 2. PLAN doesn't include it -> an upgrade fixes it, and only then. Checked
 *    before the two seller-action prompts because asking someone to re-consent
 *    or to add a card for a capability their plan excludes is wasted effort on
 *    their part. Checked AFTER the provider resolution for the older reason:
 *    selling Pro for a feature no plan can currently reach is the one failure
 *    mode this function exists to prevent.
 * 3. eBay is the provider and THIS token 403'd -> the token predates the
 *    grant, and a re-consent genuinely fixes it.
 * 4. EasyPost is the provider and the seller has no card on file -> onboarding,
 *    which is a prompt rather than a failed purchase (AC3).
 */
export function logisticsCapability(
  input: LabelCapabilityInput,
): LogisticsCapability {
  const provider = resolveLabelProvider(input);
  if (!provider) {
    return {
      label_purchase_available: false,
      code: LOGISTICS_UNAVAILABLE.code,
      detail: LOGISTICS_UNAVAILABLE.detail,
      provider: null,
    };
  }
  if (!input.planAllows) {
    return {
      label_purchase_available: false,
      code: LOGISTICS_PLAN_LOCKED.code,
      detail: LOGISTICS_PLAN_LOCKED.detail,
      provider,
    };
  }
  if (provider === "ebay" && input.ebayDenied) {
    return {
      label_purchase_available: false,
      code: LOGISTICS_RECONNECT.code,
      detail: LOGISTICS_RECONNECT.detail,
      provider,
    };
  }
  if (provider === "easypost" && !input.easypostReady) {
    return {
      label_purchase_available: false,
      code: EASYPOST_ONBOARDING.code,
      detail: EASYPOST_ONBOARDING.detail,
      provider,
    };
  }
  return {
    label_purchase_available: true,
    code: null,
    detail: null,
    provider,
  };
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
  // US-3015: no eBay guard here any more. An EasyPost-only deployment is a
  // valid one, and a 503 keyed on eBay's configuration is exactly the shape
  // AC5 exists to remove -- the fallback unreachable behind a check about
  // eBay. When neither provider can serve, logisticsCapability() says so in
  // seller-facing copy, which is a better answer than a 503.
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  // The plan is resolved on the OWNER, not the acting member, so a team seat
  // inherits the workspace's plan rather than their own (which is Free).
  const [denied, planAllows, easypost] = await Promise.all([
    readLogisticsDenied(ownerId),
    featureAllowedForUser(ownerId, "shippingLabels"),
    easypostReadiness(ownerId),
  ]);
  // US-3015: with no sale named this answers "can this seller buy labels at
  // all", which is what the composer asks before rendering the entry point.
  // saleIsEbay is TRUE here on purpose rather than optimistically: eBay is
  // preferred only when it actually works, so every other combination still
  // falls through to EasyPost and the answer is the same one a real eBay sale
  // would get. A non-eBay sale can only do BETTER than this, never worse.
  const cap = logisticsCapability({
    ebayScope: isLogisticsScopeAvailable(),
    ebayDenied: denied,
    easypostConfigured: easypost.configured,
    easypostReady: easypost.ready,
    saleIsEbay: true,
    planAllows,
  });
  return c.json({
    ...cap,
    easypost: {
      configured: easypost.configured,
      onboarded: easypost.hasAccount,
      ready: easypost.ready,
    },
  });
});

// ── POST /easypost/onboard ───────────────────────────────
// US-3015 AC3: create this seller's EasyPost referral customer, once.
//
// The seller adds their CARD afterwards, at EasyPost, through EasyPost's own
// Stripe flow. Nothing in this route, this file or this service sees a card
// number, a Stripe token or a billing address, and nothing holds a balance --
// that is the whole reason referral customers were chosen over a wallet.
//
// NOT gated on the Pro plan. Onboarding spends nothing; gating it would mean a
// seller upgrades and THEN discovers a second setup step, which is the shape
// this AC exists to remove.
flipdeskLogisticsRoutes.post("/easypost/onboard", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  if (!isEasyPostConfigured()) {
    return c.json({
      error: "EasyPost isn't switched on for this server.",
      code: "feature_unavailable",
    }, 501);
  }
  const { data: userRow } = await supabaseAdmin
    .from("users")
    .select("email, business_name, full_name")
    .eq("id", ownerId) // US-268: the owner from the context, never from a body
    .maybeSingle();
  const u = userRow as
    | { email: string | null; business_name: string | null; full_name: string | null }
    | null;
  if (!u?.email) {
    return c.json({
      error: "Your account has no email address, so EasyPost can't bill you directly.",
      code: "email_missing",
    }, 409);
  }
  try {
    const account = await ensureEasyPostAccount(ownerId, {
      name: u.business_name ?? u.full_name ?? null,
      email: u.email,
    });
    const readiness = await easypostReadiness(ownerId);
    return c.json({
      ok: true,
      // The id, never the key. A client that could read the key could spend
      // this seller's postage money from anywhere.
      easypost_user_id: account.easypostUserId,
      ready: readiness.ready,
    });
  } catch (err) {
    console.error("[flipdesk-logistics] easypost onboarding failed:", err);
    return c.json({
      error: "EasyPost couldn't set up your account.",
      detail: err instanceof Error ? err.message.slice(0, 500) : String(err),
    }, 502);
  }
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
  platform: string | null;
  platform_order_id: string | null;
  tracking_number: string | null;
  shipped_at: string | null;
  ebay_shipment_id: string | null;
  /** US-3015: set once a label is bought here, so a reprint years later knows
   * which API to call rather than guessing from which id column is filled. */
  label_provider: string | null;
  easypost_shipment_id: string | null;
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
      "id, platform, platform_order_id, tracking_number, shipped_at, ebay_shipment_id, label_provider, easypost_shipment_id, shipping_cost, inventory_item_id, inventory_items!inner(user_id)",
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
      // US-2796: which scale the stamped shoe number is on — what the item SAYS
      // (attributes.shoe_size_scale), else what its brand's curated chart
      // implies. Resolved unconditionally because it is cheap and because
      // sizeFactor() only consults it inside its shoe branch — passing it for a
      // hoodie is inert, and gating here would mean a third copy of the
      // SHOE_SIZED list to keep in step with parcel-estimate's.
      //
      // Null for anything uncertain, and null is exactly today's behaviour: a
      // shoe with no scale is read as US men's, which is what every existing
      // row was recorded under.
      sizeScale: resolveShoeSizeScaleForItem({
        brand: row.brand,
        attributes: row.attributes,
        item_category: row.item_category,
        title: row.title,
        style: row.style,
        description: row.description,
        condition_notes: row.condition_notes,
        size: row.size,
      }),
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
    // US-3015: resolved with the flag we just set AND the real EasyPost state,
    // so the copy is whatever is TRUE after the denial -- "reconnect eBay" when
    // eBay is the only provider, the EasyPost state when there is a fallback.
    // The old call could only ever say reconnect, which on an EasyPost
    // deployment sent the seller to re-consent for a provider they were about
    // to stop using. The extra read is on a failure path, not a hot one.
    const easypost = await easypostReadiness(ownerId);
    const cap = logisticsCapability({
      ebayScope: isEbayConfigured() && isLogisticsScopeAvailable(),
      ebayDenied: true,
      easypostConfigured: easypost.configured,
      easypostReady: easypost.ready,
      saleIsEbay: true,
      // planAllows stays true: this path is only reached AFTER the plan let
      // the seller through, and false here would relabel a scope error as an
      // upsell (US-3011's note, unchanged).
      planAllows: true,
    });
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

/**
 * Shared preflight: capability + eBay config + owned sale with an order id.
 *
 * `spendsMoney` (US-3011) selects whether the Pro gate applies. True on the two
 * routes that buy postage; false on reprint and void, which a downgraded seller
 * must keep — see the PLAN note at the top of this file.
 */
async function preflight(
  ownerId: string,
  saleId: string,
  spendsMoney = true,
): Promise<
  | {
    ok: true;
    sale: SaleRow;
    provider: LabelProvider;
    /** eBay's order id. Non-null exactly when provider is "ebay". */
    orderId: string | null;
  }
  | {
    ok: false;
    status: 402 | 404 | 409 | 501 | 503;
    body: Record<string, unknown>;
  }
> {
  // US-3015: THE SALE IS LOADED FIRST NOW, and the order matters. The provider
  // decision reads whether this is an eBay sale, so a capability resolved
  // before the sale was known could only ever be about eBay -- which is the
  // bug AC5 names. The extra cost is nothing: the sale was loaded a few lines
  // later anyway.
  const sale = await loadOwnedSale(ownerId, saleId);
  if (!sale) return { ok: false, status: 404, body: { error: "Sale not found." } };

  const saleIsEbay = !!sale.platform_order_id &&
    (sale.platform == null || sale.platform === "ebay");

  const planAllows = spendsMoney
    ? await featureAllowedForUser(ownerId, "shippingLabels")
    : true;
  const [denied, easypost] = await Promise.all([
    readLogisticsDenied(ownerId),
    easypostReadiness(ownerId),
  ]);
  const cap = logisticsCapability({
    ebayScope: isEbayConfigured() && isLogisticsScopeAvailable(),
    ebayDenied: denied,
    easypostConfigured: easypost.configured,
    easypostReady: easypost.ready,
    saleIsEbay,
    planAllows,
  });
  if (!cap.label_purchase_available || !cap.provider) {
    // 402 for the plan lock, so a client can tell "upgrade and this works" from
    // "this server can never do it" (501) without string-matching the copy.
    // 409 for the EasyPost onboarding prompt, because it is the seller's own
    // next action rather than a statement about the server.
    const status = cap.code === "plan_locked"
      ? 402 as const
      : cap.code === "easypost_onboarding_required"
      ? 409 as const
      : 501 as const;
    return { ok: false, status, body: { error: cap.detail, code: cap.code } };
  }

  if (cap.provider === "ebay" && !sale.platform_order_id) {
    return {
      ok: false,
      status: 409,
      body: {
        error: "This sale has no eBay order, so there's no label to buy here.",
      },
    };
  }

  return {
    ok: true,
    sale,
    provider: cap.provider,
    orderId: cap.provider === "ebay" ? sale.platform_order_id : null,
  };
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
        "Add your ship-from address in Settings before buying a label — the carrier needs it to price postage.",
      code: "ship_from_missing",
    }, 409);
  }

  // US-3015: the EasyPost branch. It needs a destination, which the eBay
  // branch never does -- eBay derives it from the order id, so that path never
  // reads or stores a buyer's address. EasyPost has no order to derive from,
  // so the caller supplies one and NOTHING PERSISTS IT: it lives for the
  // length of this request and is not written to any column.
  if (pre.provider === "easypost") {
    const shipTo = toLogisticsAddress(
      (body as Record<string, unknown> | null)?.ship_to ?? null,
      typeof (body as Record<string, unknown> | null)?.ship_to_name === "string"
        ? String((body as Record<string, unknown>).ship_to_name)
        : null,
      null,
    );
    if (!shipTo) {
      return c.json({
        error:
          "Add the buyer's shipping address to price this label — this sale didn't come from eBay, so we can't look it up.",
        code: "ship_to_missing",
      }, 409);
    }
    const account = await loadEasyPostAccount(ownerId);
    if (!account?.apiKey) {
      // preflight already resolved readiness, so reaching here means the row
      // went away between the two reads. Report the onboarding state rather
      // than a 500 -- it is the action that fixes it either way.
      return c.json({
        error: "Add a card with EasyPost to buy postage here.",
        code: "easypost_onboarding_required",
      }, 409);
    }
    try {
      const quote = await createEasyPostQuote(account.apiKey, {
        shipFrom,
        shipTo,
        parcel,
        reference: saleId.slice(0, 50),
      });
      return c.json({
        provider: "easypost",
        shipping_quote_id: quote.shippingQuoteId,
        expires_at: quote.expiresAt,
        rates: quote.rates,
      });
    } catch (err) {
      console.error("[flipdesk-logistics] easypost quote failed:", err);
      if (isPaymentMethodError(err)) {
        return c.json({
          error: "Add a card with EasyPost to buy postage here.",
          code: "easypost_onboarding_required",
        }, 409);
      }
      return c.json({
        error: "EasyPost couldn't price this shipment.",
        detail: err instanceof Error ? err.message.slice(0, 500) : String(err),
      }, 502);
    }
  }

  try {
    const quote = await createShippingQuote(ownerId, {
      orderId: pre.orderId!,
      shipFrom,
      parcel,
    });
    // A successful call proves the scope works — clear any stale denial.
    await setLogisticsDenied(ownerId, false);
    return c.json({
      provider: "ebay",
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

/**
 * US-3015: push the tracking number to eBay after a label is bought.
 *
 * AC8: an eBay-sourced sale whose label came from EasyPost still reaches eBay
 * through the EXISTING createShippingFulfillment call, not a second
 * implementation. So this is shared by both providers and keyed on whether the
 * sale has an eBay order, never on which provider bought the label.
 *
 * Best-effort on purpose: the label is already paid for, so a fulfillment
 * hiccup must not read as "the purchase failed" -- the seller can still mark
 * shipped from the normal button.
 */
async function pushTrackingToEbay(
  ownerId: string,
  sale: SaleRow,
  trackingNumber: string | null,
  carrier: string | null,
): Promise<boolean> {
  if (!trackingNumber) return false;
  if (!sale.platform_order_id) return false;
  if (sale.platform != null && sale.platform !== "ebay") return false;
  if (!isEbayConfigured()) return false;
  try {
    await createShippingFulfillment(ownerId, sale.platform_order_id, {
      trackingNumber,
      carrier,
    });
    await supabaseAdmin
      .from("sales")
      .update({ shipped_at: sale.shipped_at ?? new Date().toISOString() })
      .eq("id", sale.id)
      .eq("user_id", ownerId); // US-268 belt and braces
    return true;
  } catch (err) {
    console.error(
      "[flipdesk-logistics] fulfillment push after label purchase failed:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/**
 * Buy a label through EasyPost. Split out of the route body because the two
 * providers share nothing but their shape, and a single function alternating
 * between them is where a write meant for one lands on the other.
 */
async function buyEasyPostLabel(
  c: Context,
  ownerId: string,
  sale: SaleRow,
  shipmentId: string,
  rateId: string,
): Promise<Response> {
  const account = await loadEasyPostAccount(ownerId);
  if (!account?.apiKey) {
    return c.json({
      error: "Add a card with EasyPost to buy postage here.",
      code: "easypost_onboarding_required",
    }, 409);
  }

  // Bind the shipment to THIS sale before spending anything -- the same guard
  // the eBay path runs with quoteCoversOrder(), built on the reference we
  // stamped when we created it.
  try {
    const quote = await getEasyPostQuote(account.apiKey, shipmentId);
    if (!quoteCoversSale(quote.reference, sale.id)) {
      return c.json({
        error: "That shipping quote isn't for this sale. Get rates again.",
        code: "quote_order_mismatch",
      }, 409);
    }
    if (!assertRateOnQuote(quote.rates, rateId)) {
      return c.json({
        error: "That shipping rate is no longer on the quote. Get rates again.",
        code: "rate_not_on_quote",
      }, 409);
    }
  } catch (err) {
    console.error("[flipdesk-logistics] easypost quote re-read failed:", err);
    return c.json({
      error: "EasyPost couldn't confirm this shipping quote.",
      detail: err instanceof Error ? err.message.slice(0, 500) : String(err),
    }, 502);
  }

  let shipment;
  try {
    shipment = await buyEasyPostShipment(account.apiKey, shipmentId, rateId);
  } catch (err) {
    console.error("[flipdesk-logistics] easypost label purchase failed:", err);
    if (isPaymentMethodError(err)) {
      return c.json({
        error:
          "EasyPost couldn't charge your card. Check your payment method with EasyPost and try again.",
        code: "easypost_onboarding_required",
      }, 409);
    }
    // AC10: NEVER retry here. An unclear failure is settled by reading the
    // shipment back, because the id existed before the buy -- a re-post would
    // bill a second label. If the read says it landed, the purchase SUCCEEDED
    // and the seller must be told so; reporting a failure on a label they paid
    // for is how a seller buys the same postage twice by hand.
    try {
      const readBack = await getEasyPostShipment(account.apiKey, shipmentId);
      if (shipmentWasPurchased(readBack)) {
        console.warn(
          "[flipdesk-logistics] easypost buy errored but the label exists:",
          shipmentId,
        );
        shipment = readBack;
      }
    } catch (readErr) {
      console.error(
        "[flipdesk-logistics] easypost read-back after unclear buy failed:",
        readErr instanceof Error ? readErr.message : String(readErr),
      );
    }
    if (!shipment) {
      return c.json({
        error: "EasyPost couldn't buy this label.",
        detail: err instanceof Error ? err.message.slice(0, 500) : String(err),
      }, 502);
    }
  }

  // AC7: the same columns the eBay path writes, and never a 0 over a real cost.
  const patch: Record<string, unknown> = {
    label_provider: "easypost",
    easypost_shipment_id: shipment.shipmentId,
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
    .eq("user_id", ownerId); // US-268 belt and braces: this write records money
  if (updErr) {
    // The label IS bought and the seller HAS been charged -- never report that
    // as a failure. Log loudly; the shipment id is in the response either way.
    console.error(
      "[flipdesk-logistics] easypost label bought but sale write-back failed:",
      updErr.message,
    );
  }

  const pushedToEbay = await pushTrackingToEbay(
    ownerId,
    sale,
    shipment.trackingNumber,
    shipment.carrier,
  );

  return c.json({
    ok: true,
    provider: "easypost",
    shipment_id: shipment.shipmentId,
    tracking_number: shipment.trackingNumber,
    carrier: shipment.carrier,
    label_download_url: shipment.labelDownloadUrl,
    cost_cents: shipment.totalCostCents,
    currency: shipment.currency,
    marked_shipped_on_ebay: pushedToEbay,
  });
}

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
  // US-3015: BOTH id columns are checked. Checking only eBay's would let a
  // seller who bought through EasyPost buy a second label from the same page.
  const boughtId = sale.ebay_shipment_id ?? sale.easypost_shipment_id;
  if (boughtId) {
    return c.json({
      already_purchased: true,
      provider: sale.label_provider ??
        (sale.ebay_shipment_id ? "ebay" : "easypost"),
      shipment_id: boughtId,
      tracking_number: sale.tracking_number,
    });
  }

  if (pre.provider === "easypost") {
    return await buyEasyPostLabel(c, ownerId, sale, quoteId, rateId);
  }

  // Bind the quote to THIS sale before spending anything. The two ids come
  // straight off the request, and nothing else ties them to the sale being
  // charged — without this, a seller could buy against a quote created for a
  // different one of their own sales and the postage would land on whichever
  // sale is in the URL. That is the mis-attribution this story removes, so the
  // extra read is worth it on the one route that spends money.
  try {
    const quote = await getShippingQuote(ownerId, quoteId);
    if (!quoteCoversOrder(quote.orderIds, pre.orderId!)) {
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
    // US-3015: say WHICH provider bought it. A reprint two years from now reads
    // this rather than inferring the provider from which id column is filled.
    label_provider: "ebay",
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
  // seller keeps late-shipment protection. US-3015 moved the body of this into
  // pushTrackingToEbay() so the EasyPost path uses the same one call (AC8)
  // instead of growing a second implementation of exactly what this warns
  // against.
  const pushedToEbay = await pushTrackingToEbay(
    ownerId,
    sale,
    shipment.trackingNumber,
    shipment.carrier,
  );

  return c.json({
    ok: true,
    provider: "ebay",
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
  // spendsMoney=false: reprinting a label already paid for is not a purchase,
  // and a downgrade must not take away a label the seller owns.
  const pre = await preflight(ownerId, saleId, false);
  if (!pre.ok) return c.json(pre.body, pre.status);
  const bought = providerOfPurchase(pre.sale);
  if (!bought) {
    return c.json({ error: "No label was bought here for this sale." }, 404);
  }
  if (bought.provider === "easypost") {
    const account = await loadEasyPostAccount(ownerId);
    if (!account?.apiKey) {
      return c.json({
        error: "Your EasyPost account isn't available, so this label can't be re-read.",
        code: "easypost_account_missing",
      }, 409);
    }
    try {
      const shipment = await getEasyPostShipment(account.apiKey, bought.shipmentId);
      return c.json({
        provider: "easypost",
        shipment_id: shipment.shipmentId,
        tracking_number: shipment.trackingNumber,
        carrier: shipment.carrier,
        label_download_url: shipment.labelDownloadUrl,
        cost_cents: shipment.totalCostCents,
        currency: shipment.currency,
      });
    } catch (err) {
      console.error("[flipdesk-logistics] easypost reprint failed:", err);
      return c.json({
        error: "EasyPost couldn't return this label.",
        detail: err instanceof Error ? err.message.slice(0, 500) : String(err),
      }, 502);
    }
  }
  const shipmentId = bought.shipmentId;
  try {
    const shipment = await getShipment(ownerId, shipmentId);
    return c.json({
      provider: "ebay",
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
  // spendsMoney=false: a void RETURNS money. Gating it behind a plan would
  // strand a downgraded seller's postage refund behind an upsell.
  const pre = await preflight(ownerId, saleId, false);
  if (!pre.ok) return c.json(pre.body, pre.status);
  const bought = providerOfPurchase(pre.sale);
  if (!bought) {
    return c.json({ error: "No label was bought here for this sale." }, 404);
  }
  if (bought.provider === "easypost") {
    const account = await loadEasyPostAccount(ownerId);
    if (!account?.apiKey) {
      return c.json({
        error: "Your EasyPost account isn't available, so this label can't be refunded here.",
        code: "easypost_account_missing",
      }, 409);
    }
    try {
      // EasyPost refunds asynchronously, so the answer is usually `submitted`
      // rather than `refunded`. The local record is cleared on ACCEPTANCE of
      // the request, the same point the eBay path clears it -- what neither
      // provider gives us is a synchronous confirmation that money moved.
      await refundEasyPostShipment(account.apiKey, bought.shipmentId);
    } catch (err) {
      console.error("[flipdesk-logistics] easypost refund failed:", err);
      return c.json({
        error: "EasyPost wouldn't cancel this label.",
        detail: err instanceof Error ? err.message.slice(0, 500) : String(err),
      }, 502);
    }
  } else {
    try {
      await cancelShipment(ownerId, bought.shipmentId);
    } catch (err) {
      console.error("[flipdesk-logistics] label void failed:", err);
      const f = await logisticsFailure(
        ownerId,
        err,
        "eBay wouldn't cancel this label.",
      );
      return c.json(f.body, f.status);
    }
  }
  const { error } = await supabaseAdmin
    .from("sales")
    .update({
      ebay_shipment_id: null,
      easypost_shipment_id: null,
      label_provider: null,
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
      "The label was canceled but we couldn't update the sale.",
      error,
      "logistics.void",
    );
  }
  return c.json({ ok: true });
});

