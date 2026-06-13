import { Hono } from "hono";
import { cors } from "hono/middleware";
import { accessLogger } from "./middleware/access-log.ts";
import { healthRoutes } from "./routes/health.ts";
import { gradeRoutes } from "./routes/grade.ts";
import { webhookRoutes } from "./routes/webhooks.ts";
import { paymentRoutes } from "./routes/payments.ts";
import { appstoreVerifyRoutes, appstoreWebhookRoutes } from "./routes/appstore.ts";
import { apiKeyRoutes } from "./routes/api-keys.ts";
import { apiV1Routes } from "./routes/api-v1.ts";
import { notificationRoutes } from "./routes/notifications.ts";
import { flipdeskEbayRoutes } from "./routes/flipdesk-ebay.ts";
import {
  flipdeskWebhookRoutes,
  handleEbayPendingWebhooksCron,
} from "./routes/flipdesk-webhooks.ts";
import { flipdeskGradingRoutes } from "./routes/flipdesk-grading.ts";
import { flipdeskImageRoutes } from "./routes/flipdesk-images.ts";
import { flipdeskListingsRoutes } from "./routes/flipdesk-listings.ts";
import { flipdeskReconciliationRoutes } from "./routes/flipdesk-reconciliation.ts";
import { flipdeskSheetsRoutes } from "./routes/flipdesk-sheets.ts";
import { flipdeskAiRoutes } from "./routes/flipdesk-ai.ts";
import { flipdeskScoutRoutes } from "./routes/flipdesk-scout.ts";
import { flipdeskTemplatesRoutes } from "./routes/flipdesk-templates.ts";
import {
  flipdeskAutolisterRoutes,
  handleAutolisterReclaimCron,
  handlePublishBatchReclaimCron,
} from "./routes/flipdesk-autolister.ts";
import { flipdeskGooglePhotosRoutes } from "./routes/flipdesk-google-photos.ts";
import { flipdeskGoogleRoutes } from "./routes/flipdesk-google.ts";
import { flipdeskGoogleSyncRoutes } from "./routes/flipdesk-google-sync.ts";
import { flipdeskDisclosureRoutes } from "./routes/flipdesk-disclosure.ts";
import {
  flipdeskPricingRoutes,
  handleRepriceRulesCron,
  handleRepriceScanCron,
} from "./routes/flipdesk-pricing.ts";
import {
  flipdeskAutomationsRoutes,
  handleAutomationRulesCron,
} from "./routes/flipdesk-automations.ts";
import { adminBillingRoutes } from "./routes/admin-billing.ts";
import { adminFlagsRoutes } from "./routes/admin-flags.ts";
import { adminGradingRoutes } from "./routes/admin-grading.ts";
import { adminDisputesRoutes } from "./routes/admin-disputes.ts";
import { adminUsersRoutes } from "./routes/admin-users.ts";
import { adminImpersonationRoutes } from "./routes/admin-impersonation.ts";
import { adminMessagesRoutes } from "./routes/admin-messages.ts";
import { adminModerationRoutes } from "./routes/admin-moderation.ts";
import { publicGradingRoutes } from "./routes/public-grading.ts";
import { handleGradingMonitorCron } from "./lib/grading-monitor.ts";
import { handleStuckSubmissionsCron } from "./lib/stuck-submissions.ts";
import { handlePushTokenPruneCron } from "./lib/push-token-prune.ts";
import { handleSyncReaperCron } from "./lib/sync-run-lock.ts";
import { handleEmailRetryCron } from "./lib/email-retry.ts";
import { handleIntegrityScanCron } from "./lib/integrity-scan.ts";
import { handleCertIntegrityBackfillCron } from "./lib/cert-integrity-backfill.ts";
import { handleDataRetentionCron } from "./lib/data-retention.ts";
import { handleConditionIndexRefreshCron } from "./lib/condition-index.ts";
import { handleTrialExpiryCron } from "./routes/jobs-trial-expiry.ts";
import { handleListingPromptPromoteCron } from "./routes/jobs-listing-prompt-promote.ts";
import { adminSeoRoutes, handleGscSyncCron } from "./routes/admin-seo.ts";
import { adminGrowthRoutes, handleGrowthDispatchCron } from "./routes/admin-growth.ts";
import { announcementRoutes } from "./routes/announcements.ts";
import { referralRoutes } from "./routes/referrals.ts";
import { contentBlogRoutes } from "./routes/content-blog.ts";
import { contentSocialRoutes } from "./routes/content-social.ts";
import { contentTopicsRoutes } from "./routes/content-topics.ts";
import { contentKnowledgeRoutes } from "./routes/content-knowledge.ts";
import { contentImagesRoutes } from "./routes/content-images.ts";
import { contentSettingsRoutes } from "./routes/content-settings.ts";
import { contentPublicRoutes } from "./routes/content-public.ts";
import { contentSchedulerRoutes } from "./routes/content-scheduler.ts";
import { workspaceRoutes } from "./routes/workspace.ts";
import { accountRoutes } from "./routes/account.ts";
import { legalRoutes } from "./routes/legal.ts";
import { verifiedRoutes } from "./routes/verified.ts";
import { authMiddleware } from "./middleware/auth.ts";
import { adminAuthMiddleware } from "./middleware/admin-auth.ts";
import { apiKeyAuthMiddleware } from "./middleware/api-key-auth.ts";
import { rateLimiter, pagesOriginBypass } from "./middleware/rate-limit.ts";
import {
  apiV1RateLimitBody,
  apiV1ReadLimit,
  apiV1Subject,
  apiV1WriteLimit,
} from "./middleware/api-v1-rate.ts";
import { workspaceMiddleware } from "./middleware/workspace.ts";
import { securityHeaders } from "./middleware/security-headers.ts";
import { bodyLimit, BodyTooLargeError } from "./middleware/body-limit.ts";
import { assertAdminMfaConfig, assertNoProdDebugFlags, isProduction } from "./lib/env.ts";
import { assertRequiredEnv, warnMissingFeatureGroups } from "./lib/env-validation.ts";
import { assertSchemaVersion } from "./lib/schema-version.ts";
import { redactError } from "./lib/log-redact.ts";
import { captureException, logEvent, readCtxVar, releaseSha } from "./lib/observability.ts";
import { featureGate } from "./lib/feature-flags.ts";

const app = new Hono();

// Allowed CORS origins. Function form is more reliable than the array form
// across Hono versions and gives clearer logs when a request is rejected.
// US-363: localhost is a dev-only origin and is dropped in production builds so
// a prod deploy never trusts a loopback origin. The remaining origins are
// first-party GradeThread / FlipDesk brand domains.
const ALLOWED_ORIGINS = new Set<string>([
  "https://gradethread.com",
  "https://www.gradethread.com",
  "https://flipdesk.com",
  "https://www.flipdesk.com",
  ...(isProduction() ? [] : ["http://localhost:5173"]),
]);

// US-520: staging frontend + Cloudflare Pages PR-preview origins
// (https://<hash>.<project>.pages.dev). Honored ONLY off-production — the prod
// deploy (EDGE_ENV=production) never trusts a staging or preview origin.
const STAGING_ORIGIN = "https://staging.gradethread.com";
const PAGES_PREVIEW_ORIGIN_RE = /^https:\/\/[a-z0-9-]+\.gradethread\.pages\.dev$/;

function isAllowedOrigin(origin: string): boolean {
  if (ALLOWED_ORIGINS.has(origin)) return true;
  if (isProduction()) return false;
  return origin === STAGING_ORIGIN || PAGES_PREVIEW_ORIGIN_RE.test(origin);
}

const ALLOWED_HEADERS = [
  "Content-Type",
  "Authorization",
  "X-API-Key",
  "X-Internal-Job-Secret",
  "X-Workspace-Owner",
];

// Belt-and-suspenders: respond to every OPTIONS preflight FIRST, before any
// other middleware runs. Hono's cors() should already do this, but a defensive
// explicit handler here means a Traefik/Coolify edge or an upstream middleware
// quirk can't strip the headers — we always emit them.
app.use("*", async (c, next) => {
  if (c.req.method !== "OPTIONS") {
    await next();
    return;
  }
  const origin = c.req.header("Origin") ?? "";
  const allowed = isAllowedOrigin(origin) ? origin : "";
  if (allowed) {
    c.header("Access-Control-Allow-Origin", allowed);
    c.header("Vary", "Origin");
  }
  c.header(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  );
  // US-363: return the FIXED allowlist — never reflect
  // Access-Control-Request-Headers, which would let any client widen the set.
  c.header("Access-Control-Allow-Headers", ALLOWED_HEADERS.join(", "));
  c.header("Access-Control-Max-Age", "86400");
  return c.body(null, 204);
});

// Middleware
// US-359: custom access logger (never logs request headers / querystrings) in
// place of Hono's logger(), so Authorization / X-API-Key / signatures can't
// leak into log sinks.
app.use("*", accessLogger);
app.use(
  "*",
  cors({
    origin: (origin) => (isAllowedOrigin(origin) ? origin : null),
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ALLOWED_HEADERS,
    maxAge: 86400,
  })
);

// Security hardening headers on every response (HSTS, nosniff, frame-deny,
// referrer policy, CORP) + no-store on user-scoped surfaces. Runs after cors()
// so it can't clobber Access-Control-* headers. (US-263)
app.use("*", securityHeaders);

// Request body-size guard (US-267) — reject oversized payloads with 413 before
// the handler buffers them. Per-route caps (15MB for image uploads, 256KB for
// JSON-only endpoints) are resolved inside the middleware by path. Scoped to
// /api/* so /health and the OPTIONS preflight never pay for it.
app.use("/api/*", bodyLimit);

// Auth middleware — applied to protected routes only (not health or webhooks)
app.use("/api/grade/*", authMiddleware);
app.use("/api/payments/*", authMiddleware);
app.use("/api/keys/*", authMiddleware);
app.use("/api/notifications/dispute-status", authMiddleware);
app.use("/api/notifications/dispute-filed", authMiddleware);
app.use("/api/notifications/register", authMiddleware);
app.use("/api/notifications/feedback", authMiddleware);
// Account data export / deletion — caller acts only on their own data. (US-275)
app.use("/api/account/*", authMiddleware);
// US-377: ToS/Privacy clickwrap acceptance — caller acts only on their own record.
app.use("/api/legal/*", authMiddleware);
// US-628: in-app announcement reads — caller acts only on their own dismissals.
app.use("/api/announcements/*", authMiddleware);
// US-629 referral program — caller manages only their own code/attribution.
app.use("/api/referrals/*", authMiddleware);
// GradeThread Verified — seller manages their OWN public profile. No workspace
// middleware: the profile is the individual seller's account, not a tenant's.
app.use("/api/verified/*", authMiddleware);
// FlipDesk: everything under /api/flipdesk is authed except inbound webhooks
// and the eBay OAuth callback (eBay redirects the browser there unauthenticated;
// the `state` token from oauth_states identifies the user) + the scheduled
// /oauth/refresh job (gated by FLIPDESK_INTERNAL_JOB_SECRET header).
app.use("/api/flipdesk/ebay/oauth/start", authMiddleware);
app.use("/api/flipdesk/ebay/oauth/debug", authMiddleware);
app.use("/api/flipdesk/ebay/disconnect", authMiddleware);
app.use("/api/flipdesk/ebay/category/*", authMiddleware);
app.use("/api/flipdesk/ebay/listings/*", authMiddleware);
app.use("/api/flipdesk/ebay/payouts/*", authMiddleware);
app.use("/api/flipdesk/ebay/comps", authMiddleware);
app.use("/api/flipdesk/ebay/policies", authMiddleware);
app.use("/api/flipdesk/ebay/policies/*", authMiddleware);
// US-561: Promoted Listings ad-rate suggestion + performance sync (the
// /jobs/* promoted sync uses the job secret instead).
app.use("/api/flipdesk/ebay/marketing/*", authMiddleware);
// US-673: best offers + send-offer + buyer messages.
app.use("/api/flipdesk/ebay/negotiation/*", authMiddleware);
app.use("/api/flipdesk/ebay/messages", authMiddleware);
app.use("/api/flipdesk/ebay/messages/*", authMiddleware);
app.use("/api/flipdesk/grading/submit", authMiddleware);
app.use("/api/flipdesk/grading/validate", authMiddleware);
app.use("/api/flipdesk/grading/submissions/*", authMiddleware);
app.use("/api/flipdesk/images/*", authMiddleware);
app.use("/api/flipdesk/listings/*", authMiddleware);
app.use("/api/flipdesk/reconciliation/*", authMiddleware);
app.use("/api/flipdesk/sheets/*", authMiddleware);
app.use("/api/flipdesk/ai/*", authMiddleware);
app.use("/api/flipdesk/scout/*", authMiddleware);
app.use("/api/flipdesk/templates/*", authMiddleware);
app.use("/api/flipdesk/autolister/*", authMiddleware);
app.use("/api/flipdesk/disclosure/*", authMiddleware);
app.use("/api/flipdesk/pricing/*", authMiddleware);
app.use("/api/flipdesk/automations/*", authMiddleware);
// Google Photos import — everything authed EXCEPT /oauth/callback (Google
// redirects the browser there unauthenticated; the `state` row identifies the
// user and the import is one-shot + tenant-scoped to the session's owner_id).
app.use("/api/flipdesk/google/photos/oauth/start", authMiddleware);
app.use("/api/flipdesk/google/photos/poll", authMiddleware);
app.use("/api/flipdesk/google/photos/import", authMiddleware);
app.use("/api/flipdesk/google/photos/config", authMiddleware);
// Google Sheets sync (US-146) — everything authed EXCEPT /oauth/callback
// (Google redirects the browser there unauthenticated; the single-use `state`
// row identifies the user). Listed per-path so the wildcard can't shadow the
// public Photos callback above.
app.use("/api/flipdesk/google/oauth/start", authMiddleware);
app.use("/api/flipdesk/google/connection", authMiddleware);
app.use("/api/flipdesk/google/config", authMiddleware);
app.use("/api/flipdesk/google/sheet/*", authMiddleware);
app.use("/api/flipdesk/google/disconnect", authMiddleware);
// US-147: manual "Sync now" is user-authed; /sync/push + /sync/pull are
// scheduled jobs gated inside the handler by the internal job secret.
app.use("/api/flipdesk/google/sync/now", authMiddleware);
// Workspace (team) management: auth + workspace context. The route handlers
// enforce per-action role checks (owner/admin required to invite, etc.).
app.use("/api/workspace/*", authMiddleware);
app.use("/api/workspace/*", workspaceMiddleware);

// Workspace context middleware — resolves X-Workspace-Owner into
// workspaceOwnerId/workspaceRole so routes can write to the correct tenant
// when a member is acting inside an owner's workspace. Sits after
// authMiddleware. No-ops (workspaceOwnerId === userId) for solo users.
app.use("/api/grade/*", workspaceMiddleware);
app.use("/api/flipdesk/ebay/oauth/start", workspaceMiddleware);
app.use("/api/flipdesk/ebay/oauth/debug", workspaceMiddleware);
app.use("/api/flipdesk/ebay/disconnect", workspaceMiddleware);
app.use("/api/flipdesk/ebay/category/*", workspaceMiddleware);
app.use("/api/flipdesk/ebay/listings/*", workspaceMiddleware);
app.use("/api/flipdesk/ebay/payouts/*", workspaceMiddleware);
app.use("/api/flipdesk/ebay/comps", workspaceMiddleware);
app.use("/api/flipdesk/ebay/policies", workspaceMiddleware);
app.use("/api/flipdesk/ebay/policies/*", workspaceMiddleware);
// US-673: best offers + send-offer + buyer messages.
app.use("/api/flipdesk/ebay/negotiation/*", workspaceMiddleware);
app.use("/api/flipdesk/ebay/messages", workspaceMiddleware);
app.use("/api/flipdesk/ebay/messages/*", workspaceMiddleware);
app.use("/api/flipdesk/grading/submit", workspaceMiddleware);
app.use("/api/flipdesk/grading/validate", workspaceMiddleware);
app.use("/api/flipdesk/grading/submissions/*", workspaceMiddleware);
app.use("/api/flipdesk/images/*", workspaceMiddleware);
app.use("/api/flipdesk/listings/*", workspaceMiddleware);
app.use("/api/flipdesk/reconciliation/*", workspaceMiddleware);
app.use("/api/flipdesk/ai/*", workspaceMiddleware);
app.use("/api/flipdesk/scout/*", workspaceMiddleware);
app.use("/api/flipdesk/templates/*", workspaceMiddleware);
app.use("/api/flipdesk/autolister/*", workspaceMiddleware);
// Only /oauth/start needs the workspace owner (to stage imports under the
// owner); /poll + /import resolve the owner from the session row.
app.use("/api/flipdesk/google/photos/oauth/start", workspaceMiddleware);
// Google Sheets sync — workspace-scope every user-authed route so the grant
// and sync sheet live under the workspace owner (mirrors the eBay wiring).
app.use("/api/flipdesk/google/oauth/start", workspaceMiddleware);
app.use("/api/flipdesk/google/connection", workspaceMiddleware);
app.use("/api/flipdesk/google/sheet/*", workspaceMiddleware);
app.use("/api/flipdesk/google/disconnect", workspaceMiddleware);
app.use("/api/flipdesk/google/sync/now", workspaceMiddleware);
app.use("/api/flipdesk/disclosure/*", workspaceMiddleware);
app.use("/api/flipdesk/pricing/*", workspaceMiddleware);
app.use("/api/flipdesk/automations/*", workspaceMiddleware);
app.use("/api/keys/*", workspaceMiddleware);

// Admin billing: user JWT auth, then admin role check
app.use("/api/admin/*", authMiddleware);
app.use("/api/admin/*", adminAuthMiddleware);

// US-582: ad-hoc operator → customer email. Cap per-admin sends so a compromised
// or fat-fingered admin session can't blast mail; keyed by the authed admin user
// (default subject) since the JWT+role check above already ran.
app.use("/api/admin/messages/*", rateLimiter(20, 60_000, "admin-messages", undefined, {
  methods: ["POST"],
}));

// Content module (blog + social): admin-only EXCEPT /api/content/public/*
// which is anonymous (powers the SSR worker for /blog). We carve the
// public surface out by listing the protected sub-paths explicitly
// instead of slapping middleware on /api/content/*. This mirrors the
// FlipDesk wiring above.
app.use("/api/content/blog/*", authMiddleware);
app.use("/api/content/blog/*", adminAuthMiddleware);
app.use("/api/content/social/*", authMiddleware);
app.use("/api/content/social/*", adminAuthMiddleware);
app.use("/api/content/topics/*", authMiddleware);
app.use("/api/content/topics/*", adminAuthMiddleware);
app.use("/api/content/knowledge/*", authMiddleware);
app.use("/api/content/knowledge/*", adminAuthMiddleware);
app.use("/api/content/images/*", authMiddleware);
app.use("/api/content/images/*", adminAuthMiddleware);
app.use("/api/content/settings/*", authMiddleware);
app.use("/api/content/settings/*", adminAuthMiddleware);

// Rate limiting (US-265) — distributed (Postgres-backed), per-scope so budgets
// don't bleed across endpoint groups. Keyed by user when authed, else by IP.
// US-781: the only UNAUTHENTICATED, unmetered mount — the public content surface
// (blog/cert/seller reads + the cert view counter). Cap per-IP and FAIL-CLOSED
// (a store outage drops to the per-replica fallback, never unlimited), with a
// Pages-origin bypass so the blog/cert SSR workers — which proxy these endpoints
// for ALL visitors through one Cloudflare Pages IP — aren't starved. 60/min/IP
// is generous for legitimate cert sharing/scanning + QR badge fetches.
app.use(
  "/api/content/public/*",
  rateLimiter(60, 60_000, "content-public", undefined, {
    failClosed: true,
    bypass: pagesOriginBypass,
  }),
);
app.use("/api/grade/*", rateLimiter(60, 60_000, "grade"));
app.use("/api/flipdesk/ebay/listings/*", rateLimiter(30, 60_000, "ebay-listings"));
app.use("/api/flipdesk/grading/*", rateLimiter(60, 60_000, "flipdesk-grading"));
app.use("/api/flipdesk/ai/*", rateLimiter(20, 60_000, "flipdesk-ai"));
// US-619: ScoutAI is expensive (grades N candidates per scan) - cap tightly.
app.use("/api/flipdesk/scout/*", rateLimiter(6, 60_000, "flipdesk-scout"));
// AutoLister batch enqueue is cheap to call but kicks off heavy background
// work — cap submissions; per-item AI cost is governed by the quota check. The
// cap applies to WRITES only (POST: batch enqueue, classify-photos, photo-qa,
// retry). The read-only batch-status poll (GET /batch/:id) gets its own roomy
// budget below: the queue view polls every 1.5s (~40/min) for the minutes a
// batch generates, which would otherwise drain this write budget and 429 the
// poll mid-run (a batch DoS-ing its own status view).
// US-529: the validated staging-photo upload gets its own roomy budget — a
// bulk dump stages up to ~100 photos in a couple of minutes, which would
// instantly drain the 20/min write cap below (so that limiter bypasses this
// path). Uploads are cheap (sniff + strip + storage PUT), no AI cost.
app.use(
  "/api/flipdesk/autolister/staging/upload",
  rateLimiter(120, 60_000, "autolister-upload", undefined, { methods: ["POST"] }),
);
app.use(
  "/api/flipdesk/autolister/*",
  rateLimiter(20, 60_000, "flipdesk-autolister", undefined, {
    methods: ["POST"],
    bypass: (c) => c.req.path === "/api/flipdesk/autolister/staging/upload",
  }),
);
app.use(
  "/api/flipdesk/autolister/*",
  rateLimiter(120, 60_000, "autolister-poll", undefined, { methods: ["GET"] }),
);
// Disclosure reads are cheap; the annotated-photo upload writes storage.
app.use("/api/flipdesk/disclosure/*", rateLimiter(40, 60_000, "flipdesk-disclosure"));
// A repricing scan fans out to one eBay Browse call per listing — cap tightly.
app.use("/api/flipdesk/pricing/scan", rateLimiter(6, 60_000, "flipdesk-reprice-scan"));
app.use("/api/flipdesk/pricing/*", rateLimiter(60, 60_000, "flipdesk-pricing"));
// An automation run/dry-run scans every active listing — keep CRUD snappy but
// cap the whole surface.
app.use("/api/flipdesk/automations/*", rateLimiter(60, 60_000, "flipdesk-automations"));

// Broadened coverage: sensitive / abusable surfaces that previously had none.
app.use("/api/payments/*", rateLimiter(30, 60_000, "payments"));
app.use("/api/keys/*", rateLimiter(30, 60_000, "api-keys")); // incl. key creation
app.use("/api/workspace/*", rateLimiter(30, 60_000, "workspace")); // incl. invitation sends
app.use("/api/notifications/*", rateLimiter(60, 60_000, "notifications"));
app.use("/api/flipdesk/ebay/oauth/start", rateLimiter(10, 60_000, "ebay-oauth"));
// Policy reads/syncs are infrequent UI actions; this just blunts pathological spam.
app.use("/api/flipdesk/ebay/policies", rateLimiter(30, 60_000, "ebay-policies"));
app.use("/api/flipdesk/ebay/policies/*", rateLimiter(30, 60_000, "ebay-policies"));
app.use("/api/flipdesk/images/*", rateLimiter(30, 60_000, "flipdesk-images"));
app.use("/api/flipdesk/listings/*", rateLimiter(30, 60_000, "flipdesk-listings"));
app.use("/api/flipdesk/reconciliation/*", rateLimiter(30, 60_000, "flipdesk-recon"));
app.use("/api/flipdesk/sheets/*", rateLimiter(30, 60_000, "flipdesk-sheets"));
app.use("/api/flipdesk/google/oauth/start", rateLimiter(10, 60_000, "google-oauth"));
app.use("/api/flipdesk/google/sheet/*", rateLimiter(15, 60_000, "google-sheet"));
app.use("/api/content/scheduler/*", rateLimiter(60, 60_000, "content-scheduler"));
app.use("/api/account/*", rateLimiter(10, 60_000, "account")); // data export is heavy
app.use("/api/legal/*", rateLimiter(30, 60_000, "legal"));
app.use("/api/announcements/*", rateLimiter(60, 60_000, "announcements"));
app.use("/api/referrals/*", rateLimiter(30, 60_000, "referrals"));
app.use("/api/verified/*", rateLimiter(30, 60_000, "verified"));

// Content AI endpoints — generation, research, image creation. Each
// call is expensive (multi-thousand-token Claude responses or OpenAI
// gpt-image-1). Cap at 20/min/user across these paths.
app.use("/api/content/blog/*/generate", rateLimiter(20, 60_000, "content-ai"));
// US-251 / US-252: streaming compose + section regen are long-lived SSE calls
// that each hold an upstream Claude stream open — cap tighter than batch gen.
app.use("/api/content/blog/*/compose-stream", rateLimiter(10, 60_000, "content-ai"));
app.use("/api/content/blog/*/regenerate-section", rateLimiter(20, 60_000, "content-ai"));
app.use("/api/content/social/*/generate", rateLimiter(20, 60_000, "content-ai"));
app.use("/api/content/social/*/suggest-hashtags", rateLimiter(30, 60_000, "content-ai"));
app.use("/api/content/topics/research", rateLimiter(20, 60_000, "content-ai"));
app.use("/api/content/images/*", rateLimiter(20, 60_000, "content-ai"));

// US-507: content-AI kill-switch on the same expensive paths.
app.use("/api/content/blog/*/generate", featureGate("content_ai"));
app.use("/api/content/blog/*/compose-stream", featureGate("content_ai"));
app.use("/api/content/blog/*/regenerate-section", featureGate("content_ai"));
app.use("/api/content/social/*/generate", featureGate("content_ai"));
app.use("/api/content/topics/research", featureGate("content_ai"));
app.use("/api/content/images/*", featureGate("content_ai"));

// Coarse per-IP ceiling on the unauthenticated webhook receivers — blunts
// floods only. Legit Stripe/eBay bursts stay well under it, and a 429 just
// makes the provider retry (idempotency in US-277 makes that safe).
// US-354: these are the most abusable UNAUTHENTICATED surfaces, so they run
// fail-CLOSED — a counter-store outage drops to a per-replica fallback ceiling
// (never unlimited), and a header-stripped flood is bucketed, not waved through.
app.use("/api/webhooks/*", rateLimiter(600, 60_000, "webhook-stripe", undefined, { failClosed: true }));
app.use("/api/flipdesk/webhooks/*", rateLimiter(600, 60_000, "webhook-ebay", undefined, { failClosed: true }));

// Public API v1 — API key auth, then per-key, plan-tiered, fail-closed rate
// limits (US-800). Reads (GET) and the expensive writes (POST submit / PATCH
// webhook) get SEPARATE budgets keyed by the API key id — so one key can't
// drain another's, a read poll can't exhaust the submit budget, and a
// counter-store outage limits via the local fallback instead of handing a paid
// API unlimited throughput. Limit + subject + 429 envelope come from
// middleware/api-v1-rate.ts.
app.use("/api/v1/*", apiKeyAuthMiddleware);
app.use(
  "/api/v1/*",
  rateLimiter(apiV1ReadLimit, 60_000, "api-v1-read", undefined, {
    methods: ["GET"],
    subject: apiV1Subject,
    failClosed: true,
    errorBody: apiV1RateLimitBody,
  }),
);
app.use(
  "/api/v1/*",
  rateLimiter(apiV1WriteLimit, 60_000, "api-v1-write", undefined, {
    methods: ["POST", "PATCH", "PUT", "DELETE"],
    subject: apiV1Subject,
    failClosed: true,
    errorBody: apiV1RateLimitBody,
  }),
);

// Routes
app.route("/health", healthRoutes);
app.route("/api/grade", gradeRoutes);
app.route("/api/payments", paymentRoutes);
// StoreKit IAP: verify is authed (/api/payments/* covers it); the App Store
// Server Notifications webhook is unauthed (verified by Apple's JWS signature).
app.route("/api/payments/appstore", appstoreVerifyRoutes);
app.route("/api/webhooks", webhookRoutes);
app.route("/api/webhooks/appstore", appstoreWebhookRoutes);
app.route("/api/keys", apiKeyRoutes);
app.route("/api/v1", apiV1Routes);
app.route("/api/notifications", notificationRoutes);
app.route("/api/flipdesk/ebay", flipdeskEbayRoutes);
app.route("/api/flipdesk/webhooks", flipdeskWebhookRoutes);
app.route("/api/flipdesk/grading", flipdeskGradingRoutes);
app.route("/api/flipdesk/images", flipdeskImageRoutes);
app.route("/api/flipdesk/listings", flipdeskListingsRoutes);
app.route("/api/flipdesk/reconciliation", flipdeskReconciliationRoutes);
app.route("/api/flipdesk/sheets", flipdeskSheetsRoutes);
app.route("/api/flipdesk/ai", flipdeskAiRoutes);
app.route("/api/flipdesk/scout", flipdeskScoutRoutes);
app.route("/api/flipdesk/templates", flipdeskTemplatesRoutes);
app.route("/api/flipdesk/autolister", flipdeskAutolisterRoutes);
app.route("/api/flipdesk/google/photos", flipdeskGooglePhotosRoutes);
app.route("/api/flipdesk/google", flipdeskGoogleRoutes);
app.route("/api/flipdesk/google", flipdeskGoogleSyncRoutes);
app.route("/api/flipdesk/disclosure", flipdeskDisclosureRoutes);
app.route("/api/flipdesk/pricing", flipdeskPricingRoutes);
app.route("/api/flipdesk/automations", flipdeskAutomationsRoutes);
// Condition-aware repricing cron. OUTSIDE /api/flipdesk so the user-JWT
// middleware above doesn't intercept it; the handler enforces
// X-Internal-Job-Secret itself (mirrors the GSC sync cron).
app.post("/api/jobs/reprice-scan", (c) => handleRepriceScanCron(c));
// US-672 repricing-automation cron — applies owner-defined rules. Same
// X-Internal-Job-Secret gate as reprice-scan.
app.post("/api/jobs/reprice-rules", (c) => handleRepriceRulesCron(c));
// US-150 price-drop/promo scheduler cron (hourly) — trigger/action/scope
// rules over active listings. Same X-Internal-Job-Secret gate.
app.post("/api/jobs/automation-rules", (c) => handleAutomationRulesCron(c));
// US-525 AutoLister reclaim sweeper. OUTSIDE the /api/flipdesk/autolister/*
// JWT wildcard so a cron (no user token) can reach it; the handler enforces
// X-Internal-Job-Secret itself. Resumes batches whose worker died mid-run.
app.post("/api/jobs/autolister-reclaim", (c) => handleAutolisterReclaimCron(c));
// US-559 bulk-publish reclaim sweeper. Same job-secret gating; resumes durable
// publish batches whose worker died mid-run so nothing is stranded.
app.post("/api/jobs/publish-batch-reclaim", (c) => handlePublishBatchReclaimCron(c));
app.route("/api/admin", adminBillingRoutes);
// US-507 admin kill-switch management (admin JWT + MFA via /api/admin/* group).
app.route("/api/admin/feature-flags", adminFlagsRoutes);
app.route("/api/admin/grading", adminGradingRoutes);
// US-474 admin dispute resolution. Service-role writes (grade_reports/disputes/
// submissions) that used to no-op under RLS as browser calls; reseals the
// certificate on a grade adjustment. Admin JWT + MFA via the /api/admin/* group.
app.route("/api/admin/disputes", adminDisputesRoutes);
app.route("/api/admin/users", adminUsersRoutes);
// US-581 super-admin impersonation / "view as" + audited start/stop. Admin JWT
// + AAL2 via the /api/admin/* group; start additionally requires super_admin +
// a fresh MFA step-up (it mints a real session as the target user).
app.route("/api/admin/impersonation", adminImpersonationRoutes);
// US-582 ad-hoc admin → customer transactional messaging. Admin JWT + AAL2 via
// the /api/admin/* group; per-admin rate-limited above; audited + recorded.
app.route("/api/admin/messages", adminMessagesRoutes);
// US-476/477 admin content moderation (approve/reject/ban) — audited
// service-role routes (admin JWT + AAL2 via the /api/admin/* group).
app.route("/api/admin/moderation", adminModerationRoutes);
// US-326 public transparency report. Lives at /api/grading/public (NOT
// /api/grade/*, which is JWT-gated) so the unauthenticated /transparency page
// can read platform-wide aggregate accuracy stats. Returns no per-tenant data.
app.route("/api/grading/public", publicGradingRoutes);
// US-327 grading regression monitor cron. OUTSIDE /api/admin so the wildcard
// admin-JWT middleware doesn't intercept it; the handler enforces
// X-Internal-Job-Secret itself (mirrors the GSC sync + reprice crons).
app.post("/api/jobs/grading-monitor", (c) => handleGradingMonitorCron(c));
// US-495 stuck-submission recovery sweep. OUTSIDE the JWT groups; the handler
// enforces X-Internal-Job-Secret itself. Fails orphaned 'processing' grades and
// reverses their charge so a crash/redeploy can't strand paid work.
app.post("/api/jobs/stuck-submissions", (c) => handleStuckSubmissionsCron(c));
// US-795 push device-token prune. OUTSIDE the JWT groups; the handler enforces
// X-Internal-Job-Secret itself. Deletes long-inactive (signed-out / dead-token)
// rows so the table doesn't grow unbounded and send fan-outs stay cheap.
app.post("/api/jobs/push-token-prune", (c) => handlePushTokenPruneCron(c));
// US-456 eBay sync-run reaper. OUTSIDE the JWT groups; the handler enforces
// X-Internal-Job-Secret itself. Flips runs stuck in 'running' past the
// threshold to 'failed' so the Reconciliation UI unblocks even when no new pull
// is attempted (a crashed/killed pull would otherwise hang forever).
app.post("/api/jobs/sync-reaper", (c) => handleSyncReaperCron(c));
// US-498 transactional-email outbox retry sweep. OUTSIDE the JWT groups; the
// handler enforces X-Internal-Job-Secret itself. Re-sends failed critical
// emails with backoff and dead-letters after max attempts.
app.post("/api/jobs/email-retry", (c) => handleEmailRetryCron(c));
// US-504 periodic DB integrity scan (orphans/drift/stuck rows -> alert).
app.post("/api/jobs/integrity-scan", (c) => handleIntegrityScanCron(c));
// US-490 certificate-integrity backfill: seals pre-US-333 certified reports
// (hash + signature) so legacy certificates verify instead of reporting
// "unverifiable". Idempotent; run once at launch, safe to re-run any time.
app.post("/api/jobs/cert-integrity-backfill", (c) => handleCertIntegrityBackfillCron(c));
// US-521 data-retention / PII purge (delete grading photos past the window).
app.post("/api/jobs/data-retention", (c) => handleDataRetentionCron(c));
// US-621 Condition Index refresh — rebuilds the curated price-vs-grade curves.
app.post("/api/jobs/condition-index-refresh", (c) => handleConditionIndexRefreshCron(c));
// US-383 daily trial-expiry downgrade cron. OUTSIDE /api/* JWT groups; the
// handler enforces X-Internal-Job-Secret itself (mirrors the other crons).
app.post("/api/jobs/trial-expiry", (c) => handleTrialExpiryCron(c));
// US-547 AutoLister listing-prompt A/B auto-promotion. Compares the in-trial
// challenger against the champion on seller keep-rate + sell-through and
// promotes (eval-gated) / ends the trial. Handler enforces the job secret.
app.post("/api/jobs/listing-prompt-promote", (c) => handleListingPromptPromoteCron(c));
// US-472 eBay parked-webhook drain. Re-links payout/order/return events that
// arrived before the connection's account_handle/external_account_id hydrated,
// and dead-letters the ones that never link. Handler enforces the job secret.
app.post("/api/jobs/ebay-pending-webhooks", (c) => handleEbayPendingWebhooksCron(c));
// US-308/US-309 admin SEO endpoints. /summary + /gsc/sync are admin JWT
// gated by the /api/admin/* middleware groups above.
app.route("/api/admin/seo", adminSeoRoutes);
// US-308 GSC daily-sync cron. Lives OUTSIDE /api/admin so the wildcard
// admin-JWT middleware doesn't intercept it; the handler enforces
// X-Internal-Job-Secret itself.
app.post("/api/jobs/gsc-sync", (c) => handleGscSyncCron(c));
// US-625..US-631 Growth/Promote suite (segments, campaigns, announcements,
// analytics). Admin JWT + MFA gated by the /api/admin/* middleware group.
app.route("/api/admin/growth", adminGrowthRoutes);
// US-628 user-facing announcement reads (authed, per-user scoped).
app.route("/api/announcements", announcementRoutes);
// US-629 referral program (authed, per-user scoped).
app.route("/api/referrals", referralRoutes);
// US-627 scheduled-campaign dispatch cron. OUTSIDE /api/admin so the wildcard
// admin-JWT middleware doesn't intercept it; the handler enforces
// X-Internal-Job-Secret itself (mirrors the GSC sync + reprice crons).
app.post("/api/jobs/growth-dispatch", (c) => handleGrowthDispatchCron(c));
app.route("/api/content/blog", contentBlogRoutes);
app.route("/api/content/social", contentSocialRoutes);
app.route("/api/content/topics", contentTopicsRoutes);
app.route("/api/content/knowledge", contentKnowledgeRoutes);
app.route("/api/content/images", contentImagesRoutes);
app.route("/api/content/settings", contentSettingsRoutes);
app.route("/api/content/public", contentPublicRoutes);
// /api/content/scheduler/* has its own auth middleware baked in (the
// route module short-circuits on X-Internal-Job-Secret OR falls back
// to admin JWT). Don't add /scheduler/* to the use() lines above.
app.route("/api/content/scheduler", contentSchedulerRoutes);
app.route("/api/workspace", workspaceRoutes);
app.route("/api/account", accountRoutes);
app.route("/api/legal", legalRoutes);
app.route("/api/verified", verifiedRoutes);

// 404
app.notFound((c) => c.json({ error: "Not found" }, 404));

// Error handler
app.onError((err, c) => {
  // US-362: a body that overran the streaming cap surfaces here when the route
  // tried to read it — return a clean 413, not a generic 500.
  if (err instanceof BodyTooLargeError) {
    return c.json({ error: "Request body too large", maxBytes: err.maxBytes }, 413);
  }
  // US-359: redact before logging (no PII/secrets in the sink) and return a
  // generic body — never the raw error text.
  // US-491: report the exception to the tracker with request/route/user context
  // tagged with the release SHA, correlated to the access-log line by request id.
  let path = c.req.path;
  try {
    path = new URL(c.req.url).pathname;
  } catch { /* keep c.req.path */ }
  captureException(err, {
    route: `${c.req.method} ${path}`,
    method: c.req.method,
    url: path,
    correlationId: readCtxVar(c, "correlationId"),
    userId: readCtxVar(c, "userId") ?? readCtxVar(c, "workspaceOwnerId"),
  });
  console.error("Unhandled error:", redactError(err));
  return c.json({ error: "Internal server error" }, 500);
});

// Fail-closed safety net: warn loudly if a security-weakening debug flag is
// set in production (the flag is already ignored by isDebugAllowed). (US-266)
assertNoProdDebugFlags();

// US-357: refuse to boot in production with admin MFA silently disabled. Throws
// here (before Deno.serve) so a misconfigured deploy crashes loudly instead of
// serving admin routes without the AAL2 gate.
assertAdminMfaConfig();

// US-777: hard-fail at boot on a missing REQUIRED env var (prod only); warn on
// incomplete FEATURE groups (eBay / SMTP / Stripe prices / Google Photos) so a
// half-configured deploy is loud, not latent. Dev/test stay permissive.
assertRequiredEnv();
warnMissingFeatureGroups();

// US-778: refuse to start against a STALE DB in production (a build expecting a
// migration the DB hasn't applied corrupts data). Fail-open on an unreadable
// migrations table; fatal only on a confirmed behind-version in prod.
await assertSchemaVersion();

const port = parseInt(Deno.env.get("PORT") || "8787");
logEvent("info", "edge.boot", {
  port,
  release: releaseSha(),
  errorTracking: !!Deno.env.get("SENTRY_DSN")?.trim(),
});

Deno.serve({ port }, app.fetch);
