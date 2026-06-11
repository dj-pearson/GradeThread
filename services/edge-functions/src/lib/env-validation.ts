// Boot-time env validation + feature-aware readiness (US-777).
//
// Two tiers:
//   • REQUIRED — the service cannot safely run without these. Missing one in
//     PRODUCTION is FATAL: assertRequiredEnv throws before Deno.serve so the
//     container crash-loops loudly (Coolify surfaces it) instead of silently
//     mis-serving. Dev/test stay permissive (warn, never throw).
//   • FEATURE GROUPS — a missing group disables just that feature: a loud
//     startup warning + a degraded flag on /health/ready, NOT a crash. (No point
//     refusing to start the whole edge service because, say, eBay isn't wired.)
//
// Pure + injectable (env getter + env name) so every branch is unit-testable.

import { edgeEnv } from "./env.ts";

type EnvGetter = (k: string) => string | undefined;
const realEnv: EnvGetter = (k) => Deno.env.get(k);
const has = (get: EnvGetter, k: string): boolean => Boolean(get(k)?.trim());

// Required in EVERY environment — without DB access nothing works.
const CORE_REQUIRED = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;

// Anthropic accepts either historical name.
const hasAnthropic = (get: EnvGetter): boolean =>
  has(get, "ANTHROPIC_API_KEY") || has(get, "CLAUDE_API_KEY");

// Additional vars required in PRODUCTION: money (Stripe), webhook auth, the
// cross-tenant token crypto (EDGE_ENCRYPTION_KEY), certificate signing
// (CERT_SIGNING_KEY), API-key hashing pepper, and the internal-job secret that
// gates every cron. A prod deploy missing any of these is a latent outage.
const PROD_REQUIRED = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "FLIPDESK_INTERNAL_JOB_SECRET",
  "EDGE_ENCRYPTION_KEY",
  "CERT_SIGNING_KEY",
  "API_KEY_PEPPER",
] as const;

export interface FeatureGroup {
  name: string;
  vars: string[];
}

// Feature groups — missing → that feature degrades, the service still boots.
export const FEATURE_GROUPS: FeatureGroup[] = [
  {
    name: "stripe_prices",
    vars: [
      "STRIPE_PRICE_FLIPDESK_STARTER_MONTHLY",
      "STRIPE_PRICE_FLIPDESK_STARTER_YEARLY",
      "STRIPE_PRICE_FLIPDESK_PRO_MONTHLY",
      "STRIPE_PRICE_FLIPDESK_PRO_YEARLY",
      "STRIPE_PRICE_FLIPDESK_BUSINESS_MONTHLY",
      "STRIPE_PRICE_FLIPDESK_BUSINESS_YEARLY",
      "STRIPE_PRICE_GRADE_STANDARD",
      "STRIPE_PRICE_GRADE_PREMIUM",
      "STRIPE_PRICE_GRADE_EXPRESS",
    ],
  },
  { name: "ebay", vars: ["EBAY_APP_ID", "EBAY_CERT_ID", "EBAY_DEV_ID", "EBAY_VERIFICATION_TOKEN"] },
  { name: "smtp", vars: ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_ADMIN_EMAIL"] },
  { name: "google_photos", vars: ["GOOGLE_PHOTOS_CLIENT_ID", "GOOGLE_PHOTOS_CLIENT_SECRET"] },
  // US-146: Google Sheets sync. Falls back to the shared GOOGLE_CLIENT_* if the
  // Sheets-specific override isn't set, so the group lists the override pair.
  { name: "google_sheets", vars: ["GOOGLE_SHEETS_CLIENT_ID", "GOOGLE_SHEETS_CLIENT_SECRET"] },
  { name: "observability", vars: ["SENTRY_DSN"] },
  // US-788: StoreKit / App Store Server Notifications V2. Missing → IAP receipt
  // verification + the appstore webhook can't validate Apple's JWS. Surfaced on
  // /health/ready so a deploy with IAP "on" but these unset is visible (the
  // verifier also warns at init when APPLE_APP_APPLE_ID is unset in Production).
  {
    name: "appstore",
    vars: ["APPLE_APP_APPLE_ID", "APPLE_BUNDLE_ID", "APPLE_ROOT_CA_G3_B64", "APPSTORE_ENVIRONMENT"],
  },
];

// Required vars missing for the current environment (core always; prod-required
// only in production).
export function missingRequiredEnv(get: EnvGetter = realEnv, env: string = edgeEnv()): string[] {
  const missing: string[] = CORE_REQUIRED.filter((k) => !has(get, k));
  if (!hasAnthropic(get)) missing.push("ANTHROPIC_API_KEY");
  if (env === "production") {
    for (const k of PROD_REQUIRED) if (!has(get, k)) missing.push(k);
  }
  return missing;
}

// Boot assertion. FATAL in production; permissive (warn-only) in dev/test.
export function assertRequiredEnv(get: EnvGetter = realEnv, env: string = edgeEnv()): void {
  const missing = missingRequiredEnv(get, env);
  if (missing.length === 0) return;
  const msg = `[BOOT] Missing required env: ${missing.join(", ")}`;
  if (env === "production") {
    throw new Error(`${msg} — refusing to start.`);
  }
  console.warn(`${msg} (non-production: starting anyway).`);
}

// Per-feature readiness: "ok" or "missing: A, B". Drives /health/ready.
export function computeFeatureReadiness(get: EnvGetter = realEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const g of FEATURE_GROUPS) {
    const miss = g.vars.filter((v) => !has(get, v));
    out[g.name] = miss.length === 0 ? "ok" : `missing: ${miss.join(", ")}`;
  }
  return out;
}

// Loud, non-fatal startup log of feature-group gaps so a half-configured deploy
// is visible without crashing.
export function warnMissingFeatureGroups(get: EnvGetter = realEnv): void {
  for (const g of FEATURE_GROUPS) {
    const miss = g.vars.filter((v) => !has(get, v));
    if (miss.length > 0) {
      console.warn(`[BOOT] feature '${g.name}' is not fully configured — missing: ${miss.join(", ")}`);
    }
  }
}
