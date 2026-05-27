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
import { flipdeskAiRoutes } from "./routes/flipdesk-ai.ts";
import { adminBillingRoutes } from "./routes/admin-billing.ts";
import { authMiddleware } from "./middleware/auth.ts";
import { adminAuthMiddleware } from "./middleware/admin-auth.ts";
import { apiKeyAuthMiddleware } from "./middleware/api-key-auth.ts";
import { rateLimiter } from "./middleware/rate-limit.ts";

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

// Auth middleware — applied to protected routes only (not health or webhooks)
app.use("/api/grade/*", authMiddleware);
app.use("/api/payments/*", authMiddleware);
app.use("/api/keys/*", authMiddleware);
app.use("/api/notifications/dispute-resolved", authMiddleware);
// FlipDesk: everything under /api/flipdesk is authed except inbound webhooks
// and the eBay OAuth callback (eBay redirects the browser there unauthenticated;
// the `state` token from oauth_states identifies the user) + the scheduled
// /oauth/refresh job (gated by FLIPDESK_INTERNAL_JOB_SECRET header).
app.use("/api/flipdesk/ebay/oauth/start", authMiddleware);
app.use("/api/flipdesk/ebay/category/*", authMiddleware);
app.use("/api/flipdesk/ebay/listings/*", authMiddleware);
app.use("/api/flipdesk/ebay/payouts/*", authMiddleware);
app.use("/api/flipdesk/ebay/comps", authMiddleware);
app.use("/api/flipdesk/grading/submit", authMiddleware);
app.use("/api/flipdesk/grading/validate", authMiddleware);
app.use("/api/flipdesk/grading/submissions/*", authMiddleware);
app.use("/api/flipdesk/images/*", authMiddleware);
app.use("/api/flipdesk/reconciliation/*", authMiddleware);
app.use("/api/flipdesk/ai/*", authMiddleware);
// Admin billing: user JWT auth, then admin role check
app.use("/api/admin/*", authMiddleware);
app.use("/api/admin/*", adminAuthMiddleware);

// Rate limiting — 60 requests per minute for authenticated grade endpoints
app.use("/api/grade/*", rateLimiter(60, 60_000));
app.use("/api/flipdesk/ebay/listings/*", rateLimiter(30, 60_000));
app.use("/api/flipdesk/grading/*", rateLimiter(60, 60_000));
app.use("/api/flipdesk/ai/*", rateLimiter(20, 60_000));

// Public API v1 — API key auth + 100 requests per minute
app.use("/api/v1/*", apiKeyAuthMiddleware);
app.use("/api/v1/*", rateLimiter(100, 60_000));

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
app.route("/api/flipdesk/ai", flipdeskAiRoutes);
app.route("/api/admin", adminBillingRoutes);

// 404
app.notFound((c) => c.json({ error: "Not found" }, 404));

// Error handler
app.onError((err, c) => {
  console.error("Unhandled error:", err);
  return c.json({ error: "Internal server error" }, 500);
});

const port = parseInt(Deno.env.get("PORT") || "8787");
console.log(`Edge functions running on port ${port}`);

Deno.serve({ port }, app.fetch);
