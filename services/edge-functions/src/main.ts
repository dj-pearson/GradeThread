import { Hono } from "hono";
import { cors } from "hono/middleware";
import { logger } from "hono/middleware";
import { healthRoutes } from "./routes/health.ts";
import { gradeRoutes } from "./routes/grade.ts";
import { webhookRoutes } from "./routes/webhooks.ts";
import { paymentRoutes } from "./routes/payments.ts";
import { authMiddleware } from "./middleware/auth.ts";
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
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  })
);

// Auth middleware — applied to protected routes only (not health or webhooks)
app.use("/api/grade/*", authMiddleware);
app.use("/api/payments/*", authMiddleware);

// Rate limiting — 60 requests per minute for authenticated grade endpoints
app.use("/api/grade/*", rateLimiter(60, 60_000));

// Routes
app.route("/health", healthRoutes);
app.route("/api/grade", gradeRoutes);
app.route("/api/payments", paymentRoutes);
app.route("/api/webhooks", webhookRoutes);

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
