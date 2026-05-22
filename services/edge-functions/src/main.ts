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
import { authMiddleware } from "./middleware/auth.ts";
import { apiKeyAuthMiddleware } from "./middleware/api-key-auth.ts";
import { rateLimiter } from "./middleware/rate-limit.ts";

const app = new Hono();

// Middleware
app.use("*", logger());
app.use(
  "*",
  cors({
    origin: [
      "http://localhost:5173",
      "https://gradethread.com",
      "https://www.gradethread.com",
      "https://flipdesk.com",
      "https://www.flipdesk.com",
    ],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-API-Key"],
    maxAge: 86400,
  })
);

// Auth middleware — applied to protected routes only (not health or webhooks)
app.use("/api/grade/*", authMiddleware);
app.use("/api/payments/*", authMiddleware);
app.use("/api/keys/*", authMiddleware);
app.use("/api/notifications/dispute-resolved", authMiddleware);
// FlipDesk: everything under /api/flipdesk is authed except inbound webhooks
app.use("/api/flipdesk/ebay/*", authMiddleware);
app.use("/api/flipdesk/grading/submit", authMiddleware);
app.use("/api/flipdesk/grading/submissions/*", authMiddleware);
app.use("/api/flipdesk/images/*", authMiddleware);
app.use("/api/flipdesk/reconciliation/*", authMiddleware);
app.use("/api/flipdesk/ai/*", authMiddleware);

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
