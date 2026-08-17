import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { isProduction } from "../lib/env.ts";
import { recordMetric } from "../lib/observability.ts";
import { recordPagesOriginMatch } from "../lib/pages-origin-evidence.ts";
import {
  applyRateLimitOverride,
  getRateLimitOverrideSync,
  type RateLimitOverride,
} from "../lib/rate-limit-overrides.ts";

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
// outage.
//
// US-2448: each bucket carries its OWN window. The previous shape kept one
// module-level window string and cleared the ENTIRE map whenever it changed, so
// any bucket rolling over reset every other bucket's counter. That is inert
// while every mount shares the 60s window (they all do today, verified), but it
// is a silent hazard the moment one does not — and inside a single `deno test`
// process it let one test file zero another's fallback counter mid-run.
interface LocalBucket {
  window: string;
  count: number;
}
const localFallback = new Map<string, LocalBucket>();

// Entries are only ever created during a counter-store outage, but a long
// outage spread across many subjects must not grow the map without bound. Swept
// lazily and only when it gets large, so the common path stays O(1).
const LOCAL_FALLBACK_MAX_KEYS = 10_000;

function localIncrement(bucketKey: string, windowStartIso: string): number {
  const existing = localFallback.get(bucketKey);
  if (existing && existing.window === windowStartIso) {
    existing.count += 1;
    return existing.count;
  }
  if (!existing && localFallback.size >= LOCAL_FALLBACK_MAX_KEYS) {
    // Stale windows first — those counters are expired, so dropping them is
    // free. If the map is still full, every entry is live in the current
    // window, and something has to give: evict oldest-inserted (Map preserves
    // insertion order) rather than clearing wholesale, so at most a handful of
    // counters reset instead of all of them.
    for (const [k, v] of localFallback) {
      if (v.window !== windowStartIso) localFallback.delete(k);
    }
    for (const k of localFallback.keys()) {
      if (localFallback.size < LOCAL_FALLBACK_MAX_KEYS) break;
      localFallback.delete(k);
    }
  }
  localFallback.set(bucketKey, { window: windowStartIso, count: 1 });
  return 1;
}

// Test-only reset so a suite can prove fallback behaviour from a known state
// without depending on which test file ran first in the same deno process.
export function __resetLocalFallbackForTest(): void {
  localFallback.clear();
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
export function clientIp(c: Context): string | null {
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
  const matched = typeof got === "string" && constantTimeEqual(got, secret);
  // US-2612: a match is the only direct evidence that the Cloudflare Pages
  // project holds the SAME value — nothing this service can read about its own
  // environment produces it. Recorded here so /health/ready can report it.
  if (matched) recordPagesOriginMatch();
  return matched;
}

/**
 * The same header, used as an AUTH GATE rather than a rate-limit exemption.
 *
 * ⚠ DO NOT USE `pagesOriginBypass` FOR THIS (US-2619). It is a bypass: it
 * returns false when the secret is unset, which is the RIGHT fail direction for
 * skipping a limiter and exactly the WRONG one for guarding a route. A handler
 * written as `if (pagesOriginBypass(c)) { … } ` reads identically and behaves
 * identically while the secret is set — and the moment it is missing or
 * mismatched, the bypass simply stops applying and whatever the handler does
 * next is reached by everyone. Production was in precisely that state until
 * 2026-08-16, so this is not a hypothetical ordering of words.
 *
 * This one refuses when the secret is unset. Same constant-time compare; the
 * difference is entirely which way it fails.
 */
export function requirePagesOrigin(c: Context): boolean {
  const secret = Deno.env.get("CF_PAGES_ORIGIN_SECRET")?.trim();
  // No secret configured ⇒ nobody is trusted. The route is closed rather than
  // open, and the operator finds out from a 401 rather than from a stranger.
  if (!secret) return false;
  const got = c.req.header("x-pages-origin")?.trim();
  if (typeof got !== "string" || got.length === 0) return false;
  const matched = constantTimeEqual(got, secret);
  // US-2612: same proof, different door. The OG render routes come through here
  // rather than the bypass, and either one matching says the same thing about
  // the same secret.
  if (matched) recordPagesOriginMatch();
  return matched;
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
    // US-890: resolve a temporary per-user override (throttle/boost/block).
    // Injectable so the override path is unit-testable without a database;
    // defaults to the live in-process cache (lib/rate-limit-overrides.ts).
    overrideResolver?: (subjectUserId: string) => RateLimitOverride | null;
    // US-2448: injectable clock, defaulting to the real one — production
    // behaviour is unchanged and no mount passes it. It exists because the
    // fixed window is derived from the wall clock, so a test that spends a full
    // budget was a coin flip: if a real minute boundary fell mid-run the window
    // rolled, the counter reset, and the over-budget request was allowed. That
    // is CORRECT for a fixed window and wrong for a test, so the test pins the
    // clock instead of hoping the boundary misses it.
    now?: () => number;
  } = {},
) {
  const methodFilter = opts.methods?.map((m) => m.toUpperCase());
  const failClosed = opts.failClosed === true;
  const resolveOverride = opts.overrideResolver ?? getRateLimitOverrideSync;
  const now = opts.now ?? (() => Date.now());
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

    let limit = typeof maxRequests === "function"
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

    // US-890: honor an operator's temporary per-user override. Applies to USER
    // subjects only (overrides are keyed by user, not IP/API-key). A hard block
    // short-circuits to 429 before any counting; a multiplier/cap reshapes the
    // budget the request is then counted against. An expired override is ignored
    // inside the resolver (checked at read time — no cleanup job).
    if (subject.startsWith("user:")) {
      const override = resolveOverride(subject.slice("user:".length));
      if (override) {
        if (override.mode === "block") {
          const retryAfter = Math.max(
            1,
            Math.ceil((Date.parse(override.expiresAt) - now()) / 1000),
          );
          c.header("Retry-After", String(retryAfter));
          c.header("X-RateLimit-Limit", "0");
          c.header("X-RateLimit-Remaining", "0");
          recordMetric("rate_limit.override_block", 1, { scope });
          const body = opts.errorBody
            ? opts.errorBody({ retryAfter, limit: 0 })
            : { error: "Too many requests. Please try again later." };
          return c.json(body as Record<string, unknown>, 429);
        }
        limit = applyRateLimitOverride(limit, override);
      }
    }

    const bucketKey = `${scope}|${subject}`;
    const windowStart = new Date(Math.floor(now() / windowMs) * windowMs);
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
      const retryAfter = Math.max(1, resetAtSec - Math.ceil(now() / 1000));
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
