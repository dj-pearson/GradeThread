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

// Rate limiting — 60 requests per minute for authenticated grade endpoints
app.use("/api/grade/*", rateLimiter(60, 60_000));

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
