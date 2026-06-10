import Stripe from "stripe";

// Shared Stripe client factory (US-771). Returns null when STRIPE_SECRET_KEY is
// unset so callers degrade gracefully (a refund/charge becomes operator-handled)
// rather than throwing. Mirrors the per-route getStripe() the billing routes
// already use; centralized so the grading pipeline can issue auto-refunds with
// the same config.
export function getStripe(): Stripe | null {
  const key = Deno.env.get("STRIPE_SECRET_KEY");
  if (!key) {
    console.error("[stripe] STRIPE_SECRET_KEY not configured");
    return null;
  }
  return new Stripe(key, {
    apiVersion: "2024-04-10",
    timeout: 20_000,
    maxNetworkRetries: 2,
  });
}
