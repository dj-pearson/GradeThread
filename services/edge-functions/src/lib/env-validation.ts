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
import { deliverabilityWarnings } from "./email-transport.ts";

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
  /** Optional gate: when present and it returns false, the group is OFF — its
   *  missing vars produce neither a boot warning nor a "degraded" readiness line
   *  (the feature simply isn't in use). Omit for always-on optional features. */
  enabledWhen?: (get: EnvGetter) => boolean;
  /** Optional override for the "is this group configured?" check. When present,
   *  it REPLACES the default "every var in `vars` is set" rule — used when a
   *  feature accepts a fallback credential (e.g. the Google connectors fall back
   *  to the shared GOOGLE_CLIENT_* when the per-service override is unset). The
   *  `vars` list is still used to render the "missing: …" hint when it returns
   *  false. Pure (env-getter in, boolean out) so it stays unit-testable. */
  satisfiedWhen?: (get: EnvGetter) => boolean;
}

// The shared Google OAuth client serves every Google integration by default;
// the per-service GOOGLE_*_CLIENT_* pairs are optional overrides (see
// flipdesk-google.ts / flipdesk-google-photos.ts). A Google feature is therefore
// configured when EITHER its override pair OR the shared pair is set.
const hasGoogleShared = (get: EnvGetter): boolean =>
  has(get, "GOOGLE_CLIENT_ID") && has(get, "GOOGLE_CLIENT_SECRET");

// US-788: the appstore vars are only relevant when IAP is actually in use. We
// consider IAP "enabled" when the operator opts in explicitly (IAP_ENABLED
// truthy) OR has begun configuring it (any appstore var is set). A deploy with
// none of these set is not running IAP, so its missing appstore vars are noise —
// don't warn. A deploy that set SOME appstore vars (a half-configured IAP) IS
// warned, which is exactly the launch-blocker US-788 guards against.
const TRUTHY = new Set(["1", "true", "yes", "on"]);
const APPSTORE_VARS = [
  "APPLE_APP_APPLE_ID",
  "APPLE_BUNDLE_ID",
  "APPLE_ROOT_CA_G3_B64",
  "APPSTORE_ENVIRONMENT",
] as const;

export function isIapEnabled(get: EnvGetter = realEnv): boolean {
  if (TRUTHY.has((get("IAP_ENABLED") ?? "").trim().toLowerCase())) return true;
  return APPSTORE_VARS.some((k) => has(get, k));
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
  // US-599: Shopify connector. Missing → the Shopify OAuth/list/sync/delist
  // paths return 503; the rest of FlipDesk is unaffected.
  { name: "shopify", vars: ["SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "SHOPIFY_REDIRECT_URI"] },
  { name: "smtp", vars: ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_ADMIN_EMAIL"] },
  // Falls back to the shared GOOGLE_CLIENT_* when the Photos-specific override
  // isn't set (mirrors flipdesk-google-photos.ts), so it's "ok" either way.
  {
    name: "google_photos",
    vars: ["GOOGLE_PHOTOS_CLIENT_ID", "GOOGLE_PHOTOS_CLIENT_SECRET"],
    satisfiedWhen: (get) =>
      (has(get, "GOOGLE_PHOTOS_CLIENT_ID") &&
        has(get, "GOOGLE_PHOTOS_CLIENT_SECRET")) ||
      hasGoogleShared(get),
  },
  // US-146: Google Sheets sync. Falls back to the shared GOOGLE_CLIENT_* if the
  // Sheets-specific override isn't set (mirrors flipdesk-google.ts).
  {
    name: "google_sheets",
    vars: ["GOOGLE_SHEETS_CLIENT_ID", "GOOGLE_SHEETS_CLIENT_SECRET"],
    satisfiedWhen: (get) =>
      (has(get, "GOOGLE_SHEETS_CLIENT_ID") &&
        has(get, "GOOGLE_SHEETS_CLIENT_SECRET")) ||
      hasGoogleShared(get),
  },
  // US-2001: SENTRY_DSN alone is not enough to call observability "ok". Prod
  // measured release:"dev" while this line reported ok, because the Dockerfile's
  // ARG GIT_SHA=dev default survived into the image — so every edge error was
  // unattributable to a commit while the health endpoint said observability was
  // fine. A DSN with no release answers "is it erroring?" but not "did the fix
  // ship?", which is the question you actually have at 3am.
  {
    name: "observability",
    vars: ["SENTRY_DSN", "RELEASE_SHA"],
    satisfiedWhen: (get) => has(get, "SENTRY_DSN") && isRealReleaseSha(get),
  },
  // US-2003: an alert channel that is unset degrades to SILENCE. Every other
  // alerting improvement in the backlog is worthless without one, so a
  // production deploy with no channel is a degraded deploy and should say so
  // rather than reporting a healthy monitoring posture it does not have.
  // Non-production is exempt: a dev box has no business paging anyone.
  {
    name: "alerting",
    vars: ["MONITOR_ALERT_WEBHOOK", "MONITOR_ALERT_EMAIL", "SMTP_ADMIN_EMAIL"],
    enabledWhen: () => edgeEnv() === "production",
    // ANY channel counts — email or webhook. The failure this catches is
    // "none of them", not "not the one I expected".
    satisfiedWhen: (get) =>
      has(get, "MONITOR_ALERT_WEBHOOK") ||
      has(get, "MONITOR_ALERT_EMAIL") ||
      has(get, "SMTP_ADMIN_EMAIL"),
  },
  // US-788: StoreKit / App Store Server Notifications V2. Missing → IAP receipt
  // verification + the appstore webhook can't validate Apple's JWS. Surfaced on
  // /health/ready so a deploy with IAP "on" but these unset is visible (the
  // verifier also warns at init when APPLE_APP_APPLE_ID is unset in Production).
  {
    name: "appstore",
    vars: [...APPSTORE_VARS],
    enabledWhen: isIapEnabled,
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

// Per-feature readiness: "ok", "missing: A, B", or "disabled" (an off,
// enabledWhen-gated feature). Drives /health/ready (informational — it never
// flips the service to not-ready; only DB + required env do that).
export function computeFeatureReadiness(get: EnvGetter = realEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const g of FEATURE_GROUPS) {
    if (g.enabledWhen && !g.enabledWhen(get)) {
      out[g.name] = "disabled";
      continue;
    }
    const satisfied = g.satisfiedWhen
      ? g.satisfiedWhen(get)
      : g.vars.every((v) => has(get, v));
    if (satisfied) {
      out[g.name] = "ok";
      continue;
    }
    const miss = g.vars.filter((v) => !has(get, v));
    // A group can fail its satisfiedWhen with EVERY var present — observability
    // is the live example: SENTRY_DSN is set and the check still fails because
    // isRealReleaseSha() rejects release="dev". Prod reported the literal string
    // "missing: " with nothing after the colon, which tells an operator a thing
    // is missing and refuses to say which. Name the group instead: the reason
    // lives in the group's own comment and, for this one, in the release key
    // beside it.
    out[g.name] = miss.length > 0
      ? `missing: ${miss.join(", ")}`
      : `set but not satisfied — every var is present; see the ${g.name} check`;
  }
  return out;
}

// Loud, non-fatal startup log of feature-group gaps so a half-configured deploy
// is visible without crashing. An enabledWhen-gated feature that is OFF is
// skipped — only a feature the deploy is actually trying to use gets warned about
// (US-788: don't nag about appstore vars on a deploy that isn't running IAP).
export function warnMissingFeatureGroups(get: EnvGetter = realEnv): void {
  for (const g of FEATURE_GROUPS) {
    if (g.enabledWhen && !g.enabledWhen(get)) continue;
    const satisfied = g.satisfiedWhen
      ? g.satisfiedWhen(get)
      : g.vars.every((v) => has(get, v));
    if (satisfied) continue;
    const miss = g.vars.filter((v) => !has(get, v));
    console.warn(
      miss.length > 0
        ? `[BOOT] feature '${g.name}' is not fully configured — missing: ${miss.join(", ")}`
        : `[BOOT] feature '${g.name}' is not satisfied even though every var (${g.vars.join(", ")}) is set — a value is present but rejected`,
    );
  }
}

// US-915: deliverability pre-flight. Warn at boot when the email-deliverability
// posture is incomplete — no SES Configuration Set (bounce/complaint events
// won't publish), no dedicated marketing identity, or the SPF/DKIM/DMARC
// attestation flags are unset. Non-fatal (SMTP still works), but surfaced loudly
// so a deploy whose autonomous marketing sends would land in spam is visible. The
// per-warning detail lives in the pure `deliverabilityWarnings` (email-transport).
export function warnDeliverability(get: EnvGetter = realEnv): void {
  // Only nag once SMTP is at least partially configured (a deploy that sends no
  // mail at all needn't hear about deliverability).
  const smtpConfigured = has(get, "SMTP_HOST") || has(get, "SES_AWS_ACCESS_KEY_ID") ||
    has(get, "AWS_ACCESS_KEY_ID");
  if (!smtpConfigured) return;
  for (const w of deliverabilityWarnings(get)) {
    console.warn(`[BOOT] deliverability: ${w.message}`);
  }
}

// US-2001: is RELEASE_SHA a real commit, or the Dockerfile's ARG GIT_SHA=dev
// default that reached production? Treated as a placeholder rather than a
// version so /health/ready degrades instead of claiming observability is fine.
// Kept permissive on FORM (any non-placeholder string counts) — the failure
// seen in prod was the literal default surviving the build, not a malformed
// SHA, and rejecting anything that is not 40 hex chars would break short-SHA
// and tag-based deploys for no benefit.
const RELEASE_PLACEHOLDERS = new Set(["", "dev", "unknown", "local", "none", "latest"]);

export function isRealReleaseSha(get: EnvGetter = realEnv): boolean {
  const raw = (get("RELEASE_SHA") ?? "").trim().toLowerCase();
  return !RELEASE_PLACEHOLDERS.has(raw);
}
