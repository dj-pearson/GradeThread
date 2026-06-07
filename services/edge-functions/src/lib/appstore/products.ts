// iOS StoreKit 2 product catalog (pure). Mirrored by the iOS client
// (ios/GradeThread/Billing/IAPProduct.swift) — keep the two in sync.
//
// Six auto-renewable subscriptions (one Subscription Group) + four consumable
// credit packs. Product ids are the App Store Connect identifiers.

export type FlipdeskPlan = "starter" | "pro" | "business";
export type BillingInterval = "monthly" | "yearly";

export type ProductMapping =
  | { kind: "subscription"; plan: FlipdeskPlan; interval: BillingInterval }
  | { kind: "consumable"; credits: number };

export const PRODUCT_MAP: Record<string, ProductMapping> = {
  "com.gradethread.sub.starter.monthly": { kind: "subscription", plan: "starter", interval: "monthly" },
  "com.gradethread.sub.starter.yearly": { kind: "subscription", plan: "starter", interval: "yearly" },
  "com.gradethread.sub.pro.monthly": { kind: "subscription", plan: "pro", interval: "monthly" },
  "com.gradethread.sub.pro.yearly": { kind: "subscription", plan: "pro", interval: "yearly" },
  "com.gradethread.sub.business.monthly": { kind: "subscription", plan: "business", interval: "monthly" },
  "com.gradethread.sub.business.yearly": { kind: "subscription", plan: "business", interval: "yearly" },
  "com.gradethread.credits.10": { kind: "consumable", credits: 10 },
  "com.gradethread.credits.25": { kind: "consumable", credits: 25 },
  "com.gradethread.credits.50": { kind: "consumable", credits: 50 },
  "com.gradethread.credits.100": { kind: "consumable", credits: 100 },
};

/** Fail-closed: unknown product ids return null (never entitle). */
export function classifyProduct(productId: string): ProductMapping | null {
  return PRODUCT_MAP[productId] ?? null;
}

export const SUBSCRIPTION_PRODUCT_IDS: string[] = Object.entries(PRODUCT_MAP)
  .filter(([, m]) => m.kind === "subscription")
  .map(([id]) => id);

export const CONSUMABLE_PRODUCT_IDS: string[] = Object.entries(PRODUCT_MAP)
  .filter(([, m]) => m.kind === "consumable")
  .map(([id]) => id);
