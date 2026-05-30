import { Hono } from "hono";
import { cors } from "hono/middleware";
import { logger } from "hono/middleware";
import { healthRoutes } from "./routes/health.ts";
import { gradeRoutes } from "./routes/grade.ts";
import { webhookRoutes } from "./routes/webhooks.ts";
import { paymentRoutes } from "./routes/payments.ts";
import { apiKeyRoutes } from "./routes/api-keys.ts";
import { apiV1Routes } from "./routes/api-v1.ts";
import { notificationRoutes } from "./routes/notifications.ts";
import { flipdeskEbayRoutes } from "./routes/flipdesk-ebay.ts";
import { flipdeskWebhookRoutes } from "./routes/flipdesk-webhooks.ts";
import { flipdeskGradingRoutes } from "./routes/flipdesk-grading.ts";
import { flipdeskImageRoutes } from "./routes/flipdesk-images.ts";
import { flipdeskReconciliationRoutes } from "./routes/flipdesk-reconciliation.ts";
import { flipdeskSheetsRoutes } from "./routes/flipdesk-sheets.ts";
import { flipdeskAiRoutes } from "./routes/flipdesk-ai.ts";
import { flipdeskAutolisterRoutes } from "./routes/flipdesk-autolister.ts";
import { adminBillingRoutes } from "./routes/admin-billing.ts";
import { adminGradingRoutes } from "./routes/admin-grading.ts";
import { adminSeoRoutes, handleGscSyncCron } from "./routes/admin-seo.ts";
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
import { verifiedRoutes } from "./routes/verified.ts";
import { authMiddleware } from "./middleware/auth.ts";
import { adminAuthMiddleware } from "./middleware/admin-auth.ts";
import { apiKeyAuthMiddleware } from "./middleware/api-key-auth.ts";
import { rateLimiter } from "./middleware/rate-limit.ts";
import { workspaceMiddleware } from "./middleware/workspace.ts";
import { securityHeaders } from "./middleware/security-headers.ts";
import { assertNoProdDebugFlags } from "./lib/env.ts";

const app = new Hono();

// Allowed CORS origins. Function form is more reliable than the array form
// across Hono versions and gives clearer logs when a request is rejected.
const ALLOWED_ORIGINS = new Set<string>([
  "http://localhost:5173",
  "https://gradethread.com",
  "https://www.gradethread.com",
  "https://flipdesk.com",
  "https://www.flipdesk.com",
]);

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
  const allowed = ALLOWED_ORIGINS.has(origin) ? origin : "";
  if (allowed) {
    c.header("Access-Control-Allow-Origin", allowed);
    c.header("Vary", "Origin");
  }
  c.header(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  );
  c.header(
    "Access-Control-Allow-Headers",
    c.req.header("Access-Control-Request-Headers") ?? ALLOWED_HEADERS.join(", "),
  );
  c.header("Access-Control-Max-Age", "86400");
  return c.body(null, 204);
});

// Middleware
app.use("*", logger());
app.use(
  "*",
  cors({
    origin: (origin) => (ALLOWED_ORIGINS.has(origin) ? origin : null),
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ALLOWED_HEADERS,
    maxAge: 86400,
  })
);

// Security hardening headers on every response (HSTS, nosniff, frame-deny,
// referrer policy, CORP) + no-store on user-scoped surfaces. Runs after cors()
// so it can't clobber Access-Control-* headers. (US-263)
app.use("*", securityHeaders);

// Auth middleware — applied to protected routes only (not health or webhooks)
app.use("/api/grade/*", authMiddleware);
app.use("/api/payments/*", authMiddleware);
app.use("/api/keys/*", authMiddleware);
app.use("/api/notifications/dispute-resolved", authMiddleware);
app.use("/api/notifications/register", authMiddleware);
app.use("/api/notifications/feedback", authMiddleware);
// Account data export / deletion — caller acts only on their own data. (US-275)
app.use("/api/account/*", authMiddleware);
// GradeThread Verified — seller manages their OWN public profile. No workspace
// middleware: the profile is the individual seller's account, not a tenant's.
app.use("/api/verified/*", authMiddleware);
// FlipDesk: everything under /api/flipdesk is authed except inbound webhooks
// and the eBay OAuth callback (eBay redirects the browser there unauthenticated;
// the `state` token from oauth_states identifies the user) + the scheduled
// /oauth/refresh job (gated by FLIPDESK_INTERNAL_JOB_SECRET header).
app.use("/api/flipdesk/ebay/oauth/start", authMiddleware);
app.use("/api/flipdesk/ebay/oauth/debug", authMiddleware);
app.use("/api/flipdesk/ebay/category/*", authMiddleware);
app.use("/api/flipdesk/ebay/listings/*", authMiddleware);
app.use("/api/flipdesk/ebay/payouts/*", authMiddleware);
app.use("/api/flipdesk/ebay/comps", authMiddleware);
app.use("/api/flipdesk/ebay/policies", authMiddleware);
app.use("/api/flipdesk/ebay/policies/*", authMiddleware);
app.use("/api/flipdesk/grading/submit", authMiddleware);
app.use("/api/flipdesk/grading/validate", authMiddleware);
app.use("/api/flipdesk/grading/submissions/*", authMiddleware);
app.use("/api/flipdesk/images/*", authMiddleware);
app.use("/api/flipdesk/reconciliation/*", authMiddleware);
app.use("/api/flipdesk/sheets/*", authMiddleware);
app.use("/api/flipdesk/ai/*", authMiddleware);
app.use("/api/flipdesk/autolister/*", authMiddleware);
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
app.use("/api/flipdesk/ebay/category/*", workspaceMiddleware);
app.use("/api/flipdesk/ebay/listings/*", workspaceMiddleware);
app.use("/api/flipdesk/ebay/payouts/*", workspaceMiddleware);
app.use("/api/flipdesk/ebay/comps", workspaceMiddleware);
app.use("/api/flipdesk/ebay/policies", workspaceMiddleware);
app.use("/api/flipdesk/ebay/policies/*", workspaceMiddleware);
app.use("/api/flipdesk/grading/submit", workspaceMiddleware);
app.use("/api/flipdesk/grading/validate", workspaceMiddleware);
app.use("/api/flipdesk/grading/submissions/*", workspaceMiddleware);
app.use("/api/flipdesk/images/*", workspaceMiddleware);
app.use("/api/flipdesk/reconciliation/*", workspaceMiddleware);
app.use("/api/flipdesk/ai/*", workspaceMiddleware);
app.use("/api/flipdesk/autolister/*", workspaceMiddleware);
app.use("/api/keys/*", workspaceMiddleware);

// Admin billing: user JWT auth, then admin role check
app.use("/api/admin/*", authMiddleware);
app.use("/api/admin/*", adminAuthMiddleware);

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
app.use("/api/grade/*", rateLimiter(60, 60_000, "grade"));
app.use("/api/flipdesk/ebay/listings/*", rateLimiter(30, 60_000, "ebay-listings"));
app.use("/api/flipdesk/grading/*", rateLimiter(60, 60_000, "flipdesk-grading"));
app.use("/api/flipdesk/ai/*", rateLimiter(20, 60_000, "flipdesk-ai"));
// AutoLister batch enqueue is cheap to call but kicks off heavy background
// work — cap submissions; per-item AI cost is governed by the quota check.
app.use("/api/flipdesk/autolister/*", rateLimiter(20, 60_000, "flipdesk-autolister"));

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
app.use("/api/flipdesk/reconciliation/*", rateLimiter(30, 60_000, "flipdesk-recon"));
app.use("/api/flipdesk/sheets/*", rateLimiter(30, 60_000, "flipdesk-sheets"));
app.use("/api/content/scheduler/*", rateLimiter(60, 60_000, "content-scheduler"));
app.use("/api/account/*", rateLimiter(10, 60_000, "account")); // data export is heavy
app.use("/api/verified/*", rateLimiter(30, 60_000, "verified"));

// Content AI endpoints — generation, research, image creation. Each
// call is expensive (multi-thousand-token Claude responses or OpenAI
// gpt-image-1). Cap at 20/min/user across these paths.
app.use("/api/content/blog/*/generate", rateLimiter(20, 60_000, "content-ai"));
app.use("/api/content/social/*/generate", rateLimiter(20, 60_000, "content-ai"));
app.use("/api/content/social/*/suggest-hashtags", rateLimiter(30, 60_000, "content-ai"));
app.use("/api/content/topics/research", rateLimiter(20, 60_000, "content-ai"));
app.use("/api/content/images/*", rateLimiter(20, 60_000, "content-ai"));

// Coarse per-IP ceiling on the unauthenticated webhook receivers — blunts
// floods only. Legit Stripe/eBay bursts stay well under it, and a 429 just
// makes the provider retry (idempotency in US-277 makes that safe).
app.use("/api/webhooks/*", rateLimiter(600, 60_000, "webhook-stripe"));
app.use("/api/flipdesk/webhooks/*", rateLimiter(600, 60_000, "webhook-ebay"));

// Public API v1 — API key auth + 100 requests per minute
app.use("/api/v1/*", apiKeyAuthMiddleware);
app.use("/api/v1/*", rateLimiter(100, 60_000, "api-v1"));

// Routes
app.route("/health", healthRoutes);
app.route("/api/grade", gradeRoutes);
app.route("/api/payments", paymentRoutes);
app.route("/api/webhooks", webhookRoutes);
app.route("/api/keys", apiKeyRoutes);
app.route("/api/v1", apiV1Routes);
app.route("/api/notifications", notificationRoutes);
app.route("/api/flipdesk/ebay", flipdeskEbayRoutes);
app.route("/api/flipdesk/webhooks", flipdeskWebhookRoutes);
app.route("/api/flipdesk/grading", flipdeskGradingRoutes);
app.route("/api/flipdesk/images", flipdeskImageRoutes);
app.route("/api/flipdesk/reconciliation", flipdeskReconciliationRoutes);
app.route("/api/flipdesk/sheets", flipdeskSheetsRoutes);
app.route("/api/flipdesk/ai", flipdeskAiRoutes);
app.route("/api/flipdesk/autolister", flipdeskAutolisterRoutes);
app.route("/api/admin", adminBillingRoutes);
app.route("/api/admin/grading", adminGradingRoutes);
// US-308/US-309 admin SEO endpoints. /summary + /gsc/sync are admin JWT
// gated by the /api/admin/* middleware groups above.
app.route("/api/admin/seo", adminSeoRoutes);
// US-308 GSC daily-sync cron. Lives OUTSIDE /api/admin so the wildcard
// admin-JWT middleware doesn't intercept it; the handler enforces
// X-Internal-Job-Secret itself.
app.post("/api/jobs/gsc-sync", (c) => handleGscSyncCron(c));
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
app.route("/api/verified", verifiedRoutes);

// 404
app.notFound((c) => c.json({ error: "Not found" }, 404));

// Error handler
app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json({ error: "Internal server error" }, 500);
});

// Fail-closed safety net: warn loudly if a security-weakening debug flag is
// set in production (the flag is already ignored by isDebugAllowed). (US-266)
assertNoProdDebugFlags();

const port = parseInt(Deno.env.get("PORT") || "8787");
console.log(`Edge functions running on port ${port}`);

Deno.serve({ port }, app.fetch);
