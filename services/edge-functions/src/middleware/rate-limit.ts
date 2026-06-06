import { createMiddleware } from "hono/factory";
import type { Context } from "hono";

// Distributed fixed-window rate limiter (US-265). Backed by the shared
// rate_limit_counters table + increment_rate_limit() RPC, so limits hold across
// container restarts and horizontal replicas — unlike the previous in-memory
// Map. Keyed by user when authenticated, else by client IP.
//
// FAIL-OPEN: if the store errors (or no subject can be determined) the request
// is allowed through. A limiter must never become an availability risk — at
// worst it stops limiting; it never locks out legitimate traffic.

type RateLimitEnv = {
  Variables: {
    userId?: string;
  };
};

// Atomically increment the counter for (bucketKey, windowStart) and return the
// new count. Injectable so the middleware is unit-testable without a database
// (the test passes an in-memory counter). Throwing signals a store error → the
// caller fails open.
export type RateLimitIncrementer = (
  bucketKey: string,
  windowStartIso: string,
) => Promise<number>;

// Default store: the shared Postgres counter via increment_rate_limit(). The
// supabase client is imported LAZILY (and cached by the module loader) so this
// middleware module stays import-safe in test/CI runs that don't configure a
// database — only the production call path touches Supabase.
const defaultIncrement: RateLimitIncrementer = async (
  bucketKey,
  windowStartIso,
) => {
  const { supabaseAdmin } = await import("../lib/supabase.ts");
  const { data, error } = await supabaseAdmin.rpc("increment_rate_limit", {
    p_bucket_key: bucketKey,
    p_window_start: windowStartIso,
  });
  if (error || typeof data !== "number") {
    throw error ?? new Error("increment_rate_limit returned non-number");
  }
  return data as number;
};

// Trust order: Cloudflare's CF-Connecting-IP (set by CF, can't be spoofed by
// the client), then the first hop of X-Forwarded-For.
function clientIp(c: Context): string | null {
  const cf = c.req.header("cf-connecting-ip")?.trim();
  if (cf) return cf;
  const xff = c.req.header("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return null;
}

// `scope` groups requests that should share one budget (e.g. all /api/grade/*
// calls). Distinct scopes get distinct counters so a user's grade budget isn't
// drained by their flipdesk-ai calls.
//
// `opts.methods` restricts the limiter to specific HTTP methods (default: all).
// This lets a cheap read (e.g. a status poll) and the expensive writes on the
// same path mount as two limiters with separate budgets — the read-only poll
// never drains the write budget. Requests whose method isn't listed pass through
// untouched so a second, method-complementary limiter can govern them.
export function rateLimiter(
  maxRequests = 60,
  windowMs = 60_000,
  scope = "default",
  increment: RateLimitIncrementer = defaultIncrement,
  opts: { methods?: string[] } = {},
) {
  const methodFilter = opts.methods?.map((m) => m.toUpperCase());
  return createMiddleware<RateLimitEnv>(async (c, next) => {
    // Not one of the methods this limiter governs → leave it for whatever else
    // is mounted on this path.
    if (methodFilter && !methodFilter.includes(c.req.method.toUpperCase())) {
      await next();
      return;
    }

    const userId = c.get("userId");
    const subject = userId ? `user:${userId}` : (() => {
      const ip = clientIp(c);
      return ip ? `ip:${ip}` : null;
    })();

    // No subject we can attribute the request to → can't fairly limit. Allow.
    if (!subject) {
      await next();
      return;
    }

    const bucketKey = `${scope}|${subject}`;
    const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);

    let count: number;
    try {
      count = await increment(bucketKey, windowStart.toISOString());
    } catch (err) {
      console.error(
        "[rate-limit] store unavailable — allowing request (fail-open):",
        err instanceof Error ? err.message : String(err),
      );
      await next();
      return;
    }

    const resetAtSec = Math.ceil((windowStart.getTime() + windowMs) / 1000);
    c.header("X-RateLimit-Limit", String(maxRequests));
    c.header("X-RateLimit-Remaining", String(Math.max(0, maxRequests - count)));
    c.header("X-RateLimit-Reset", String(resetAtSec));

    if (count > maxRequests) {
      const retryAfter = Math.max(1, resetAtSec - Math.ceil(Date.now() / 1000));
      c.header("Retry-After", String(retryAfter));
      return c.json(
        { error: "Too many requests. Please try again later." },
        429,
      );
    }

    await next();
  });
}
