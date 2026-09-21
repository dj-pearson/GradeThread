// The shapes a shipping-label provider speaks to the route layer (US-3015).
//
// These lived inside ebay-logistics.ts until EasyPost arrived as a second
// provider. They moved here for one reason: AC1 asks that one route surface
// serve both providers, and two parallel-but-separate type sets is how that
// quietly stops being true. A field added to eBay's ShippingRate and not to
// EasyPost's would compile on both sides and render on one.
//
// ebay-logistics.ts re-exports every name below, so nothing that imported them
// from there had to change.
//
// UNITS ARE PART OF THE CONTRACT. Money is whole CENTS, never a float and never
// a decimal string — see moneyToCents() in ebay-logistics.ts for why reading
// digits beats multiplying. Dates are ISO strings as the provider gave them.

/** A postal address either provider can print on a label. */
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
  /** The provider's min/max delivery estimate, ISO dates, when supplied. */
  minDeliveryDate: string | null;
  maxDeliveryDate: string | null;
  /** True when the provider flags the rate as requiring extra seller action. */
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
  /** What the provider actually charged, in whole cents. */
  totalCostCents: number | null;
  currency: string | null;
}

/**
 * Which provider bought (or would buy) a label.
 *
 * Stored on sales.label_provider so a reprint or a void knows which API to call
 * years later, rather than inferring it from which id column is populated.
 */
export type LabelProvider = "ebay" | "easypost";
