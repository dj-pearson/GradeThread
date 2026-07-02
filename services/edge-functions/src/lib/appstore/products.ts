// iOS StoreKit 2 product catalog (pure) — THE canonical server-side source.
// The iOS client (ios/GradeThread/Billing/IAPProduct.swift) mirrors this map and
// fetches the serialized CATALOG from GET /api/payments/catalog; its hardcoded
// entries are the OFFLINE FALLBACK only. The drift test
// (services/edge-functions/src/tests/iap-catalog-drift_test.ts) fails the build
// if the two diverge on product ids, credits, plan/interval, or fallback price.
//
// Six auto-renewable subscriptions (one Subscription Group) + four consumable
// credit packs. Product ids are the App Store Connect identifiers.
//
// Reference USD prices mirror the web Stripe display prices in
// src/lib/constants.ts (FLIPDESK_PLANS priceMonthly/YearlyCents, CREDIT_PACKS
// priceCents). Apple controls the REAL charged price in App Store Connect; these
// values are reference + offline fallback only (see US-808). Keep them in sync
// with constants.ts; any intentional divergence must be documented here.

export type FlipdeskPlan = "starter" | "pro" | "business";
export type BillingInterval = "monthly" | "yearly";

export type ProductMapping =
  | { kind: "subscription"; plan: FlipdeskPlan; interval: BillingInterval }
  | { kind: "consumable"; credits: number };

/** Canonical catalog entry: id → mapping + display metadata + reference price. */
export interface CatalogEntry {
  productId: string;
  mapping: ProductMapping;
  /** Display title (tier name or pack label). */
  title: string;
  /** Short marketing blurb shown on the paywall. */
  blurb: string;
  /** Reference price in USD cents — mirrors src/lib/constants.ts. */
  referencePriceCents: number;
  /** Pre-formatted offline fallback price the iOS client shows when StoreKit
   *  prices can't load (mirrors IAPProduct.swift `fallbackPrice`). */
  referencePriceDisplay: string;
}

// The single source of truth. PRODUCT_MAP and the id lists below are derived
// from this array — there is no second server-side copy.
export const CATALOG: CatalogEntry[] = [
  {
    productId: "com.gradethread.sub.starter.monthly",
    mapping: { kind: "subscription", plan: "starter", interval: "monthly" },
    title: "Starter",
    blurb: "250 listings · 200 AI actions · 10 grades/mo",
    referencePriceCents: 2900,
    referencePriceDisplay: "$29/mo",
  },
  {
    productId: "com.gradethread.sub.starter.yearly",
    mapping: { kind: "subscription", plan: "starter", interval: "yearly" },
    title: "Starter",
    blurb: "250 listings · 200 AI actions · 10 grades/mo",
    referencePriceCents: 29000,
    referencePriceDisplay: "$290/yr",
  },
  {
    productId: "com.gradethread.sub.pro.monthly",
    mapping: { kind: "subscription", plan: "pro", interval: "monthly" },
    title: "Pro",
    blurb: "1,000 listings · 750 AI actions · 30 grades · AutoLister",
    referencePriceCents: 5900,
    referencePriceDisplay: "$59/mo",
  },
  {
    productId: "com.gradethread.sub.pro.yearly",
    mapping: { kind: "subscription", plan: "pro", interval: "yearly" },
    title: "Pro",
    blurb: "1,000 listings · 750 AI actions · 30 grades · AutoLister",
    referencePriceCents: 59000,
    referencePriceDisplay: "$590/yr",
  },
  {
    productId: "com.gradethread.sub.business.monthly",
    mapping: { kind: "subscription", plan: "business", interval: "monthly" },
    title: "Business",
    blurb: "Unlimited listings · team seats · API · reconciliation",
    referencePriceCents: 9900,
    referencePriceDisplay: "$99/mo",
  },
  {
    productId: "com.gradethread.sub.business.yearly",
    mapping: { kind: "subscription", plan: "business", interval: "yearly" },
    title: "Business",
    blurb: "Unlimited listings · team seats · API · reconciliation",
    referencePriceCents: 99000,
    referencePriceDisplay: "$990/yr",
  },
  {
    productId: "com.gradethread.credits.10",
    mapping: { kind: "consumable", credits: 10 },
    title: "10 grade credits",
    blurb: "Never expire",
    referencePriceCents: 2499,
    referencePriceDisplay: "$24.99",
  },
  {
    productId: "com.gradethread.credits.25",
    mapping: { kind: "consumable", credits: 25 },
    title: "25 grade credits",
    blurb: "Never expire",
    referencePriceCents: 5999,
    referencePriceDisplay: "$59.99",
  },
  {
    productId: "com.gradethread.credits.50",
    mapping: { kind: "consumable", credits: 50 },
    title: "50 grade credits",
    blurb: "Never expire",
    referencePriceCents: 10999,
    referencePriceDisplay: "$109.99",
  },
  {
    productId: "com.gradethread.credits.100",
    mapping: { kind: "consumable", credits: 100 },
    title: "100 grade credits",
    blurb: "Never expire",
    referencePriceCents: 19999,
    referencePriceDisplay: "$199.99",
  },
];

export const PRODUCT_MAP: Record<string, ProductMapping> = Object.fromEntries(
  CATALOG.map((e) => [e.productId, e.mapping]),
);

/** Fail-closed: unknown product ids return null (never entitle). */
export function classifyProduct(productId: string): ProductMapping | null {
  return PRODUCT_MAP[productId] ?? null;
}

export const SUBSCRIPTION_PRODUCT_IDS: string[] = CATALOG
  .filter((e) => e.mapping.kind === "subscription")
  .map((e) => e.productId);

export const CONSUMABLE_PRODUCT_IDS: string[] = CATALOG
  .filter((e) => e.mapping.kind === "consumable")
  .map((e) => e.productId);

/** Flat DTO served to clients (mapping fields hoisted for easy decoding). */
export interface CatalogProductDTO {
  productId: string;
  kind: "subscription" | "consumable";
  plan?: FlipdeskPlan;
  interval?: BillingInterval;
  credits?: number;
  title: string;
  blurb: string;
  referencePriceCents: number;
  referencePriceDisplay: string;
}

/** Bump when the catalog shape or contents change (clients cache by version). */
export const CATALOG_VERSION = 1;

/** Serialize the canonical catalog for GET /api/payments/catalog. */
export function serializeCatalog(): CatalogProductDTO[] {
  return CATALOG.map((e) => {
    const base = {
      productId: e.productId,
      title: e.title,
      blurb: e.blurb,
      referencePriceCents: e.referencePriceCents,
      referencePriceDisplay: e.referencePriceDisplay,
    };
    return e.mapping.kind === "subscription"
      ? { ...base, kind: "subscription" as const, plan: e.mapping.plan, interval: e.mapping.interval }
      : { ...base, kind: "consumable" as const, credits: e.mapping.credits };
  });
}
