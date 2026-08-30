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

import { edgeEnv, isProduction, isProductionEnv } from "./env.ts";
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
   *  operator stops looking.
   *
   *  WHEN IT IS WARRANTED, because every group is technically unverifiable if
   *  you push hard enough and a health page where every line carries a
   *  paragraph is a health page nobody reads. Use it only when BOTH hold:
   *    1. the second half lives somewhere this service cannot read — another
   *       container, another vendor's console, a different Cloudflare project;
   *       AND
   *    2. failing that half is SILENT. A wrong eBay credential fails loudly on
   *       the first API call and needs no caveat here; an SES account in
   *       sandbox accepts the connection and drops the mail, which needs one.
   *  A gap that announces itself does not belong on this line. */
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
  // US-2997: QuickBooks Online. Missing -> every /api/flipdesk/qbo path answers
  // 503 and the card says the connector is off; nothing else is affected.
  //
  // It is HERE rather than nowhere because four variables were set on the
  // server and there was no way to confirm the edge could see them without
  // signing in and opening the card. Every other connector reports itself; this
  // one silently did not, so "is QuickBooks configured" was a question only a
  // seller could answer, by failing.
  //
  // QBO_ENVIRONMENT is deliberately NOT required: it defaults to production,
  // and demanding it would report a correctly-configured live connector as
  // broken.
  //
  // NO `alsoUnverifiable`, and that was a correction. The first version carried
  // one about the redirect URI having to match the Intuit app exactly. It fails
  // the second half of that field's own rule: a mismatch surfaces as a REFUSED
  // CONSENT SCREEN, which is loud. The caveat is for things that fail silently.
  { name: "quickbooks", vars: ["QBO_CLIENT_ID", "QBO_CLIENT_SECRET", "QBO_REDIRECT_URI"] },
  // Four variables being present is not the same as mail arriving, and the gap
  // between those two has an owner: US-2597 asks whether SES is out of sandbox,
  // and the edge-crash-loop note records grade-lifecycle mail failing gracefully
  // into the outbox retry rather than delivering. So this group's "ok" was
  // answering a narrower question than anyone reading it would assume.
  {
    name: "smtp",
    vars: ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_ADMIN_EMAIL"],
    alsoUnverifiable:
      "the four SMTP variables are set. Nothing here proves mail is DELIVERED — " +
      "an SES account still in sandbox accepts the connection and drops anything " +
      "to an unverified recipient, and the outbox retry swallows that gracefully. " +
      "Check the outbox for stuck rows and confirm SES is out of sandbox " +
      "(US-2597).",
  },
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
  // US-2668: the Google Ads credentials, which TWO scheduled jobs depend on and
  // which nothing on this page reported until 2026-08-29.
  //
  // WHY IT EARNED A LINE. ads-sync and keyword-research both 502'd on every run
  // for nine days and the only place that showed was the cron ledger. Both share
  // this one credential set: keyword-research reads it directly
  // (lib/keyword-research.ts) and ads-sync through google-ads-client.ts, so one
  // bad refresh token takes out both and neither says so anywhere a person looks.
  //
  // CUSTOMER_ID IS IN THE LIST DELIBERATELY. The other four are the OAuth app;
  // the customer id is which account the ideas and the spend are read for, and
  // without it the two jobs have credentials that authenticate and nothing to
  // point them at. LOGIN_CUSTOMER_ID is not: it is only needed under a manager
  // (MCC) account, so requiring it would report a correct single-account setup
  // as broken.
  {
    name: "google_ads",
    vars: [
      "GOOGLE_ADS_DEVELOPER_TOKEN",
      "GOOGLE_ADS_CLIENT_ID",
      "GOOGLE_ADS_CLIENT_SECRET",
      "GOOGLE_ADS_REFRESH_TOKEN",
      "GOOGLE_ADS_CUSTOMER_ID",
    ],
    // No shared-credential fallback here, unlike google_photos/google_sheets:
    // the Ads API needs its own approved developer token and a refresh token
    // with the Ads scope, which GOOGLE_CLIENT_* does not carry.
    whenMissing:
      "ads-sync and keyword-research will SKIP cleanly and report 200, so the " +
      "cron ledger stays green while no spend is read and no keyword volumes " +
      "are refreshed. A green ledger here means 'not running', not 'working'.",
    // NO `alsoUnverifiable`, and this is the argument rather than an oversight.
    // The first draft carried one — "set does not mean Google accepts them" —
    // and the ration guard in env-validation_test.ts refused it. Re-read against
    // the two-part rule at the field's definition: the second half does live
    // where this service cannot read (token validity, developer-token approval,
    // whether the customer id is reachable), but failing it is NOT silent. It
    // 502s on the first API call of every run, and US-2668 AC4 already built the
    // thing that makes that loud in a place people look —
    // cron-fleet-governance.ts escalates a job whose failure RATE is 100% over
    // its own cadence. A caveat here would restate a signal that already has an
    // owner, on a page whose value is that its lines are short.
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
    enabledWhen: () => isProduction(),
    // ANY channel counts — email or webhook. The failure this catches is
    // "none of them", not "not the one I expected".
    satisfiedWhen: (get) =>
      has(get, "MONITOR_ALERT_WEBHOOK") ||
      has(get, "MONITOR_ALERT_EMAIL") ||
      has(get, "SMTP_ADMIN_EMAIL"),
    // This group's own comment above says a deploy with no channel should not
    // "report a healthy monitoring posture it does not have" — and a bare "ok"
    // was doing exactly that from the other side. Two ways it can be true and
    // useless: a webhook URL pointing at a dead endpoint reads as configured
    // forever, and SMTP_ADMIN_EMAIL alone satisfies it while routing through
    // the mailer whose delivery is itself unproven (see smtp above). So the
    // one thing "ok" cannot mean here is that anybody would be paged.
    alsoUnverifiable:
      "at least one channel is CONFIGURED. Nothing here proves a message " +
      "ARRIVES — a webhook pointing at a dead endpoint reads as ok forever, and " +
      "SMTP_ADMIN_EMAIL alone satisfies this while depending on the same " +
      "unproven mail path. Fire one test alert and confirm a human receives it " +
      "(US-2003 AC1).",
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
    enabledWhen: () => isProduction(),
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
    enabledWhen: () => isProduction(),
    // US-2612: this caveat is now the FALLBACK, not the final word. Once a
    // request carrying a matching x-pages-origin has reached this process,
    // lib/pages-origin-evidence.ts supplies a FeatureEvidence entry that
    // replaces the sentence below — see /health/ready in routes/health.ts. The
    // caveat still stands inside the post-boot grace window and whenever nothing
    // has been observed, which is when it is true.
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
  if (isProductionEnv(env)) {
    for (const k of PROD_REQUIRED) if (!has(get, k)) missing.push(k);
  }
  return missing;
}

// Boot assertion. FATAL in production; permissive (warn-only) in dev/test.
export function assertRequiredEnv(get: EnvGetter = realEnv, env: string = edgeEnv()): void {
  const missing = missingRequiredEnv(get, env);
  if (missing.length === 0) return;
  const msg = `[BOOT] Missing required env: ${missing.join(", ")}`;
  if (isProductionEnv(env)) {
    throw new Error(`${msg} — refusing to start.`);
  }
  console.warn(`${msg} (non-production: starting anyway).`);
}

// Per-feature readiness: "ok", "missing: A, B", or "disabled" (an off,
// enabledWhen-gated feature). Drives /health/ready (informational — it never
// flips the service to not-ready; only DB + required env do that).
/**
 * US-2612: observed evidence about a feature group, keyed by group name.
 *
 * `alsoUnverifiable` exists because some second halves live where this service
 * cannot read — but for a few of them the second half can be OBSERVED even
 * though it cannot be read. A request arriving with a matching x-pages-origin
 * proves the Cloudflare Pages project holds the same secret; no amount of
 * reading our own env does. When a group has such evidence it REPLACES
 * `alsoUnverifiable`, because that sentence says the line cannot tell, and once
 * it can, the sentence is simply false.
 *
 * Injected rather than read here so this module stays a pure function of the
 * environment — the caller owns the clock and the process state.
 */
export type FeatureEvidence = Record<string, string | null | undefined>;

export function computeFeatureReadiness(
  get: EnvGetter = realEnv,
  evidence: FeatureEvidence = {},
): Record<string, string> {
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
      const observed = evidence[g.name];
      out[g.name] = observed
        ? `ok — ${observed}`
        : g.alsoUnverifiable
        ? `ok — ${g.alsoUnverifiable}`
        : "ok";
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
