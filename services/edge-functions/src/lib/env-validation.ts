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
import { isPlaceholderRelease, resolveRelease } from "./release-identity.ts";

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
  /** Optional plain-language CONSEQUENCE, appended to the readiness line when
   *  the group is not satisfied. "missing: X" tells an operator what to set and
   *  nothing about what is broken meanwhile — which is how release="dev" sat in
   *  production for three weeks (US-2001). Use it where the degraded behaviour
   *  is silent rather than obvious. */
  whenMissing?: string;
  /** Appended EVEN WHEN THE GROUP IS SATISFIED, for a feature whose other half
   *  lives somewhere this service cannot read.
   *
   *  WHY THIS EXISTS (US-2597/US-2612). `whenMissing` disappears the moment the
   *  variable is set — which is exactly the wrong moment for a two-sided
   *  feature. `pages_origin_bypass` spelled out "the same value must also be set
   *  on the Cloudflare Pages project", and that sentence would have vanished on
   *  the first half of a two-step change, leaving a bare `ok` that means "our
   *  side is set" and reads as "this feature works". `auth_email_hook` was
   *  already in that state on 2026-08-15: reporting `ok` while nothing here can
   *  see whether GoTrue is actually pointed at the hook.
   *
   *  A readiness line that overstates is worse than one that admits an edge: the
   *  operator stops looking. Use this wherever "ok" is only half the answer. */
  alsoUnverifiable?: string;
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
  // GT-001: the branded auth-email hook, and the reason it belongs on a health
  // surface rather than in a runbook.
  //
  // With it configured, GoTrue POSTs every signup-confirmation / reset / magic
  // link / email-change to routes/auth-hooks.ts, which renders a 6-digit code
  // AND a confirm link on our own frontend (/auth/confirm?token_hash=…). Both
  // resolve on any device, because verifyOtp needs nothing the sender's browser
  // is holding.
  //
  // With it UNSET, /send-email returns 500 and GoTrue falls back to its built-in
  // templates. Those link at emailRedirectTo, which under PKCE arrives carrying
  // ?code=… — and that code only exchanges in the browser that started the
  // signup, because the verifier lives in its localStorage. A person who signs
  // up on a laptop and opens the mail on their phone cannot finish, and the
  // difference between the two states is invisible from outside: same signup
  // form, same "check your email" screen, an email that looks plausible either
  // way. Production only; a dev box has nobody to email.
  {
    name: "auth_email_hook",
    vars: ["AUTH_EMAIL_HOOK_SECRET"],
    enabledWhen: () => edgeEnv() === "production",
    alsoUnverifiable:
      "this only proves AUTH_EMAIL_HOOK_SECRET is set HERE. Whether GoTrue is " +
      "actually calling the hook depends on GOTRUE_HOOK_SEND_EMAIL_ENABLED / " +
      "_URI / _SECRET on the auth container, which this service cannot read. " +
      "With those unset GoTrue quietly uses its built-in templates and the " +
      "cross-device signup is still broken — confirm by signing up and opening " +
      "the mail on a different device (US-2597).",
    whenMissing:
      "GoTrue is falling back to its built-in email templates, whose confirm " +
      "link only completes in the browser that started the signup. Anyone who " +
      "opens the mail on a different device cannot verify. See the send-email " +
      "hook section of vault/10-ops/env-reference.md (GT-001).",
  },
  // US-2612: the Pages-origin rate-limit bypass, and whether it is armed.
  //
  // Every SSR'd public page — blog, certificate, OG image, sitemap — is rendered
  // by a Cloudflare Pages Function that fetches this service server-to-server.
  // So a thousand readers arrive here through ONE Pages worker and drain a
  // single per-IP bucket between them. The bypass exists for exactly that
  // (US-781): Pages sends `x-pages-origin: <CF_PAGES_ORIGIN_SECRET>` and
  // pagesOriginBypass() lets it through.
  //
  // It is inert unless BOTH sides carry the same value, and it fails SILENTLY:
  // the pages still render, right up until enough traffic arrives at once, and
  // then the blog and the sitemap start answering 503 "Temporarily unavailable"
  // to whoever is unlucky — including Googlebot, which is the audience the whole
  // SSR layer exists for.
  //
  // Observed 2026-08-15: a burst of public-page fetches drove /sitemap.xml to
  // 503 four times in a row. That burst was a probe rather than real traffic, so
  // it is not proof the secret is unset — but nothing we serve could tell the
  // difference, which is the actual defect and what this entry fixes. Production
  // only; a dev box has no Pages worker in front of it.
  {
    name: "pages_origin_bypass",
    vars: ["CF_PAGES_ORIGIN_SECRET"],
    enabledWhen: () => edgeEnv() === "production",
    alsoUnverifiable:
      "set HERE, which is one of the two halves. The SAME value must be on the " +
      "Cloudflare Pages project, and a Pages env change only takes effect on the " +
      "next build — so a redeploy is required after setting it. A mismatched or " +
      "Pages-side-missing secret behaves exactly like no secret at all, and this " +
      "line cannot tell the difference (US-781/US-2612).",
    whenMissing:
      "every SSR'd blog, certificate and sitemap visitor shares ONE per-IP " +
      "rate-limit bucket, because they all reach this service through the same " +
      "Pages worker. Under load the public pages start answering 503 to real " +
      "readers and to Googlebot. The same value must also be set on the " +
      "Cloudflare Pages project — setting it here alone changes nothing " +
      "(US-781).",
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
      // "ok" alone is a claim about THIS service's environment. For a two-sided
      // feature that is only half the answer, and the half we can see is the
      // one that stops the operator looking at the other.
      out[g.name] = g.alsoUnverifiable ? `ok — ${g.alsoUnverifiable}` : "ok";
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
    const base = miss.length > 0
      ? `missing: ${miss.join(", ")}`
      : `set but not satisfied — every var is present; see the ${g.name} check`;
    out[g.name] = g.whenMissing ? `${base} — ${g.whenMissing}` : base;
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

// US-2001: is the running build attributable to a commit, or is it the
// Dockerfile's ARG GIT_SHA=dev default that reached production? A placeholder
// degrades /health/ready instead of letting it claim observability is fine.
//
// ⚠ THIS MUST JUDGE THE SAME VALUE THE LOGS ARE TAGGED WITH. It used to read
// RELEASE_SHA alone while observability.ts resolved across four env keys, so the
// health surface and the Sentry tag could disagree — /health/ready would report
// the release unattributable while events shipped correctly tagged from
// SOURCE_COMMIT, or the reverse. Both now go through resolveRelease(), so
// "what does /health/ready say" and "what is on the error" cannot drift apart.
// The permissive-on-FORM rule lives with the placeholder set in
// release-identity.ts.
export function isRealReleaseSha(get: EnvGetter = realEnv): boolean {
  return !isPlaceholderRelease(resolveRelease(get));
}
