import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { isProduction } from "../lib/env.ts";
import { recordMetric } from "../lib/observability.ts";

// Distributed fixed-window rate limiter (US-265). Backed by the shared
// rate_limit_counters table + increment_rate_limit() RPC, so limits hold across
// container restarts and horizontal replicas — unlike the previous in-memory
// Map. Keyed by user when authenticated, else by client IP.
//
// Trust + failure policy (US-354 — "make the rate limiter trustworthy"):
//   - Subject IP comes ONLY from Cloudflare's CF-Connecting-IP. The
//     client-controlled X-Forwarded-For is NOT trusted in production (it lets
//     an attacker rotate the header to evade IP limits). When CF_ORIGIN_SECRET
//     is configured, a request must also carry the matching header Cloudflare
//     injects — otherwise it did not transit CF and its IP claim is discarded.
//   - DEFAULT is FAIL-OPEN: if the store errors (or no subject can be
//     determined) the request is allowed through, so a DB blip never locks out
//     legitimate traffic on the bulk of (authenticated) routes.
//   - opts.failClosed flips that for the most abusable UNAUTHENTICATED routes
//     (webhook receivers, etc.): a store outage falls back to a process-local
//     counter (a degraded, per-replica ceiling — never UNLIMITED), and a
//     request with no trustworthy subject is attributed to a shared bucket
//     instead of being waved through. So abuse can't be unlocked by knocking
//     out the counter store or by stripping IP headers.

type RateLimitEnv = {
  Variables: {
    userId?: string;
  };
};

// Atomically increment the counter for (bucketKey, windowStart) and return the
// new count. Injectable so the middleware is unit-testable without a database
// (the test passes an in-memory counter). Throwing signals a store error → the
// caller fails open (or, on a fail-closed route, drops to the local fallback).
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

// Process-local fixed-window fallback for fail-closed routes when the
// distributed store is unreachable (US-354). It is per-replica (not shared), so
// it is a DEGRADED ceiling, not the real distributed budget — but it keeps an
// abusable unauthenticated route from going UNLIMITED during a counter-store
// outage. Pruned lazily: when the window rolls over, the previous window's keys
// are dropped so the map can't grow without bound.
const localFallback = new Map<string, number>();
let localFallbackWindow = "";

function localIncrement(bucketKey: string, windowStartIso: string): number {
  if (windowStartIso !== localFallbackWindow) {
    localFallback.clear();
    localFallbackWindow = windowStartIso;
  }
  const next = (localFallback.get(bucketKey) ?? 0) + 1;
  localFallback.set(bucketKey, next);
  return next;
}

// Constant-time string compare for the CF origin secret, so a timing side
// channel can't be used to recover it byte-by-byte.
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// US-354 / AC3: prove the request actually transited Cloudflare. A Cloudflare
// Transform Rule injects `cf-origin-secret: <CF_ORIGIN_SECRET>` on every
// proxied request. The origin firewall (Coolify/Traefik) should already reject
// non-CF traffic; this is the code-level belt so a direct-to-origin request
// can't pass off a forged CF-Connecting-IP. When CF_ORIGIN_SECRET is UNSET
// (default), the check is inert and we trust the network layer.
function cameThroughCloudflare(c: Context): boolean {
  const secret = Deno.env.get("CF_ORIGIN_SECRET")?.trim();
  if (!secret) return true;
  const got = c.req.header("cf-origin-secret")?.trim();
  return typeof got === "string" && constantTimeEqual(got, secret);
}

// The only trustworthy client identifier behind Cloudflare is CF-Connecting-IP
// (CF overwrites any client-supplied value, so it can't be spoofed). A request
// that did NOT transit CF (per cameThroughCloudflare) has no trustworthy IP.
// X-Forwarded-For is fully client-controlled on a direct-to-origin request, so
// trusting it lets an attacker rotate the header to evade IP limits (US-354):
// in production we don't trust it at all. In dev/local there is no Cloudflare
// in front, so we keep the XFF fallback purely for developer convenience.
function clientIp(c: Context): string | null {
  if (!cameThroughCloudflare(c)) return null;
  const cf = c.req.header("cf-connecting-ip")?.trim();
  if (cf) return cf;
  if (!isProduction()) {
    const xff = c.req.header("x-forwarded-for");
    const first = xff?.split(",")[0]?.trim();
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
//
// `opts.failClosed` (US-354) hardens abusable UNAUTHENTICATED routes: on a
// store outage it limits via the process-local fallback instead of allowing the
// request, and a request with no trustworthy subject is bucketed together
// rather than waved through.
// A value derived from the live request context (US-800). Lets the per-window
// limit be plan-tiered and the subject be keyed by something other than the
// default user/IP (e.g. an API key id). Typed against the base Context so a
// caller can declare its own Env without function-variance friction; the
// middleware passes its own context through unchanged.
export type RateLimitContextResolver<T> = (c: Context) => T;

// US-781: the Cloudflare Pages SSR functions (blog, cert, OG) proxy the public
// content endpoints server-to-server, so a burst of legitimate blog/cert
// visitors all arrives at the edge through the one Pages worker and would
// otherwise drain a single per-IP bucket. They carry
// `x-pages-origin: <CF_PAGES_ORIGIN_SECRET>`; when it matches, the public-content
// limiter is bypassed for that internal hop. Constant-time compare; inert (never
// bypasses) when CF_PAGES_ORIGIN_SECRET is unset so it can't be a free pass.
export function pagesOriginBypass(c: Context): boolean {
  const secret = Deno.env.get("CF_PAGES_ORIGIN_SECRET")?.trim();
  if (!secret) return false;
  const got = c.req.header("x-pages-origin")?.trim();
  return typeof got === "string" && constantTimeEqual(got, secret);
}

export function rateLimiter(
  maxRequests: number | RateLimitContextResolver<number> = 60,
  windowMs = 60_000,
  scope = "default",
  increment: RateLimitIncrementer = defaultIncrement,
  opts: {
    methods?: string[];
    failClosed?: boolean;
    // Override subject resolution. Return a fully-prefixed key (e.g.
    // "apikey:<id>") so distinct subjects get distinct buckets, or null for "no
    // trustworthy subject" (handled by the fail-open/closed policy below).
    subject?: RateLimitContextResolver<string | null>;
    // Custom 429 body so a route can match its own response envelope.
    errorBody?: (info: { retryAfter: number; limit: number }) => unknown;
    // US-781: when this returns true the request skips limiting entirely (e.g.
    // trusted Pages-origin server-to-server hops). Checked before any counting.
    bypass?: RateLimitContextResolver<boolean>;
  } = {},
) {
  const methodFilter = opts.methods?.map((m) => m.toUpperCase());
  const failClosed = opts.failClosed === true;
  return createMiddleware<RateLimitEnv>(async (c, next) => {
    // Not one of the methods this limiter governs → leave it for whatever else
    // is mounted on this path.
    if (methodFilter && !methodFilter.includes(c.req.method.toUpperCase())) {
      await next();
      return;
    }

    // Trusted bypass (e.g. Pages-origin SSR) → don't count against the limit.
    if (opts.bypass && opts.bypass(c as unknown as Context)) {
      await next();
      return;
    }

    const limit = typeof maxRequests === "function"
      ? maxRequests(c as unknown as Context)
      : maxRequests;

    let subject: string | null;
    if (opts.subject) {
      subject = opts.subject(c as unknown as Context);
    } else {
      const userId = c.get("userId");
      if (userId) {
        subject = `user:${userId}`;
      } else {
        const ip = clientIp(c);
        subject = ip ? `ip:${ip}` : null;
      }
    }

    // No subject we can attribute the request to. On fail-OPEN routes we allow
    // (availability first — these are mostly authed surfaces keyed by user). On
    // fail-CLOSED routes we DON'T hand out a free pass: a client that strips its
    // IP headers (or reaches the origin directly) would otherwise bypass the
    // limit entirely, so attribute it to a shared bucket and keep counting.
    if (!subject) {
      if (!failClosed) {
        await next();
        return;
      }
      subject = "ip:unattributed";
    }

    const bucketKey = `${scope}|${subject}`;
    const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
    const windowStartIso = windowStart.toISOString();

    let count: number;
    try {
      count = await increment(bucketKey, windowStartIso);
    } catch (err) {
      if (!failClosed) {
        console.error(
          "[rate-limit] store unavailable — allowing request (fail-open):",
          err instanceof Error ? err.message : String(err),
        );
        await next();
        return;
      }
      // Fail-CLOSED: the distributed store is down but this route is abusable,
      // so keep limiting via a process-local fallback (a per-replica ceiling —
      // degraded, but never unlimited).
      console.error(
        "[rate-limit] store unavailable on a fail-closed route — using " +
          "process-local fallback counter:",
        err instanceof Error ? err.message : String(err),
      );
      count = localIncrement(bucketKey, windowStartIso);
    }

    const resetAtSec = Math.ceil((windowStart.getTime() + windowMs) / 1000);
    c.header("X-RateLimit-Limit", String(limit));
    c.header("X-RateLimit-Remaining", String(Math.max(0, limit - count)));
    c.header("X-RateLimit-Reset", String(resetAtSec));

    if (count > limit) {
      const retryAfter = Math.max(1, resetAtSec - Math.ceil(Date.now() / 1000));
      c.header("Retry-After", String(retryAfter));
      // US-508/US-800: surface throttling so abuse and undersized limits are
      // visible in the metrics stream (tagged by scope, no PII).
      recordMetric("rate_limit.exceeded", 1, { scope });
      const body = opts.errorBody
        ? opts.errorBody({ retryAfter, limit })
        : { error: "Too many requests. Please try again later." };
      return c.json(body as Record<string, unknown>, 429);
    }

    await next();
  });
}
