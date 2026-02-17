import { createMiddleware } from "hono/factory";

type RateLimitEntry = {
  count: number;
  resetAt: number;
};

type RateLimitEnv = {
  Variables: {
    userId: string;
  };
};

const store = new Map<string, RateLimitEntry>();

// Clean up expired entries every 5 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

let lastCleanup = Date.now();

function cleanupExpiredEntries(): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;

  for (const [key, entry] of store) {
    if (entry.resetAt <= now) {
      store.delete(key);
    }
  }
}

export function rateLimiter(maxRequests = 60, windowMs = 60_000) {
  return createMiddleware<RateLimitEnv>(async (c, next) => {
    cleanupExpiredEntries();

    const userId = c.get("userId");
    if (!userId) {
      // No user context — skip rate limiting
      await next();
      return;
    }

    const now = Date.now();
    const entry = store.get(userId);

    if (!entry || entry.resetAt <= now) {
      // New window
      store.set(userId, { count: 1, resetAt: now + windowMs });
      c.header("X-RateLimit-Limit", String(maxRequests));
      c.header("X-RateLimit-Remaining", String(maxRequests - 1));
      c.header("X-RateLimit-Reset", String(Math.ceil((now + windowMs) / 1000)));
      await next();
      return;
    }

    entry.count += 1;

    if (entry.count > maxRequests) {
      const retryAfterSec = Math.ceil((entry.resetAt - now) / 1000);
      c.header("Retry-After", String(retryAfterSec));
      c.header("X-RateLimit-Limit", String(maxRequests));
      c.header("X-RateLimit-Remaining", "0");
      c.header("X-RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));
      return c.json({ error: "Too many requests. Please try again later." }, 429);
    }

    c.header("X-RateLimit-Limit", String(maxRequests));
    c.header("X-RateLimit-Remaining", String(maxRequests - entry.count));
    c.header("X-RateLimit-Reset", String(Math.ceil(entry.resetAt / 1000)));
    await next();
  });
}
