// US-1792: B2B API overage credit packs. Prepaid, never expire, volume discount.
// 1 credit = 1 API call beyond the monthly included quota (US-1791). A partner
// buys a pack via one-time Stripe checkout; the webhook grants credits into the
// api_credit_wallet (00415); the quota middleware debits 1 per over-quota call.
//
// Stripe price ids come from env (created by scripts/setup-stripe-pricing.mjs
// API_OVERAGE catalog) — the code is inert until they're configured.

export type ApiOveragePackKey = "10" | "50" | "100" | "200";

export interface ApiOveragePack {
  key: ApiOveragePackKey;
  priceCents: number;
  credits: number;
  /** Env var holding the Stripe (one-time) price id for this pack. */
  priceEnv: string;
}

export const API_OVERAGE_PACKS: Record<ApiOveragePackKey, ApiOveragePack> = {
  "10": { key: "10", priceCents: 1000, credits: 2_500, priceEnv: "STRIPE_PRICE_API_OVERAGE_10" },
  "50": { key: "50", priceCents: 5000, credits: 14_000, priceEnv: "STRIPE_PRICE_API_OVERAGE_50" },
  "100": { key: "100", priceCents: 10000, credits: 30_000, priceEnv: "STRIPE_PRICE_API_OVERAGE_100" },
  "200": { key: "200", priceCents: 20000, credits: 65_000, priceEnv: "STRIPE_PRICE_API_OVERAGE_200" },
};

export function isApiOveragePackKey(v: unknown): v is ApiOveragePackKey {
  return v === "10" || v === "50" || v === "100" || v === "200";
}
