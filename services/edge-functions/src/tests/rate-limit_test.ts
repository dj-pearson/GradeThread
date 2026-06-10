// US-265: distributed rate-limiter middleware unit tests.
//
// The limiter takes an injectable incrementer (default = the Postgres
// increment_rate_limit RPC). Here we inject an in-memory fixed-window counter
// that mirrors that contract, so the middleware's decision logic runs with no
// database — it executes the same in CI as locally. Verifies: allow-under-limit
// + X-RateLimit headers, 429 + Retry-After on exceed, scope isolation,
// user-vs-IP keying, IP precedence, and fail-open when the store errors.
import { assert, assertEquals } from "@std/assert";
import {
  rateLimiter,
  type RateLimitContextResolver,
  type RateLimitIncrementer,
} from "../middleware/rate-limit.ts";

// In-memory stand-in for increment_rate_limit(): atomic per (bucket, window).
function memoryStore(): RateLimitIncrementer {
  const counts = new Map<string, number>();
  return (bucketKey, windowStartIso) => {
    const k = `${bucketKey}|${windowStartIso}`;
    const next = (counts.get(k) ?? 0) + 1;
    counts.set(k, next);
    return Promise.resolve(next);
  };
}

const throwingStore: RateLimitIncrementer = () =>
  Promise.reject(new Error("store down"));

interface FakeCtx {
  headers: Record<string, string>;
  status: number | null;
  body: unknown;
}

function makeCtx(
  opts: {
    userId?: string;
    cfIp?: string;
    xff?: string;
    method?: string;
    headers?: Record<string, string>;
    // Arbitrary context vars (e.g. apiKeyId / apiKeyPlan for US-800). Takes
    // precedence over the userId shorthand when both name the same key.
    vars?: Record<string, string | undefined>;
  } = {},
): { c: unknown; rec: FakeCtx } {
  const rec: FakeCtx = { headers: {}, status: null, body: undefined };
  const reqHeaders: Record<string, string> = {};
  if (opts.cfIp) reqHeaders["cf-connecting-ip"] = opts.cfIp;
  if (opts.xff) reqHeaders["x-forwarded-for"] = opts.xff;
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    reqHeaders[k.toLowerCase()] = v;
  }
  const vars = opts.vars ?? {};
  const c = {
    get: (k: string) =>
      k in vars ? vars[k] : (k === "userId" ? opts.userId : undefined),
    req: {
      method: opts.method ?? "POST",
      header: (name: string) => reqHeaders[name.toLowerCase()],
    },
    header: (name: string, value: string) => {
      rec.headers[name] = value;
    },
    json: (body: unknown, status?: number) => {
      rec.status = status ?? 200;
      rec.body = body;
      return { __response: true, status: rec.status };
    },
  };
  return { c, rec };
}

async function call(
  mw: ReturnType<typeof rateLimiter>,
  ctxOpts: Parameters<typeof makeCtx>[0],
): Promise<{ rec: FakeCtx; nexted: boolean }> {
  const { c, rec } = makeCtx(ctxOpts);
  let nexted = false;
  await (mw as unknown as (
    c: unknown,
    next: () => Promise<void>,
  ) => Promise<unknown>)(c, () => {
    nexted = true;
    return Promise.resolve();
  });
  return { rec, nexted };
}

Deno.test("allows requests under the limit and sets X-RateLimit headers", async () => {
  const mw = rateLimiter(3, 60_000, "t", memoryStore());
  const r1 = await call(mw, { userId: "u" });
  assert(r1.nexted);
  assertEquals(r1.rec.status, null);
  assertEquals(r1.rec.headers["X-RateLimit-Limit"], "3");
  assertEquals(r1.rec.headers["X-RateLimit-Remaining"], "2");
});

Deno.test("returns 429 + Retry-After once the limit is exceeded", async () => {
  const mw = rateLimiter(2, 60_000, "t", memoryStore());
  await call(mw, { userId: "u" }); // 1
  await call(mw, { userId: "u" }); // 2 (at limit, allowed)
  const r3 = await call(mw, { userId: "u" }); // 3 (over)
  assertEquals(r3.nexted, false);
  assertEquals(r3.rec.status, 429);
  assertEquals(r3.rec.headers["X-RateLimit-Remaining"], "0");
  assert(Number(r3.rec.headers["Retry-After"]) >= 1);
});

Deno.test("opts.methods: only the listed methods are counted/limited", async () => {
  // GET-only limiter at 1/window: a GET over the limit is 429'd, but a POST to
  // the same path passes straight through (left for a sibling write limiter).
  const mw = rateLimiter(1, 60_000, "poll", memoryStore(), { methods: ["GET"] });
  const g1 = await call(mw, { userId: "u", method: "GET" }); // 1 (allowed)
  assert(g1.nexted);
  const g2 = await call(mw, { userId: "u", method: "GET" }); // 2 (over)
  assertEquals(g2.rec.status, 429);
  // POST isn't governed by this limiter — passes through, uncounted.
  const p = await call(mw, { userId: "u", method: "POST" });
  assert(p.nexted);
  assertEquals(p.rec.status, null);
});

Deno.test("opts.methods: a GET-only and POST-only limiter on one path keep separate budgets", async () => {
  // Mirrors the autolister split: the read-poll budget and the write budget
  // don't drain each other.
  const store = memoryStore();
  const writes = rateLimiter(1, 60_000, "al-write", store, { methods: ["POST"] });
  const polls = rateLimiter(1, 60_000, "al-poll", store, { methods: ["GET"] });
  await call(writes, { userId: "u", method: "POST" }); // write budget: 1/1
  const overWrite = await call(writes, { userId: "u", method: "POST" });
  assertEquals(overWrite.rec.status, 429); // writes exhausted
  const poll = await call(polls, { userId: "u", method: "GET" }); // poll untouched
  assert(poll.nexted);
  assertEquals(poll.rec.status, null);
});

Deno.test("distinct scopes keep independent budgets", async () => {
  const store = memoryStore();
  const a = rateLimiter(1, 60_000, "scope-a", store);
  const b = rateLimiter(1, 60_000, "scope-b", store);
  await call(a, { userId: "shared" });
  const overA = await call(a, { userId: "shared" });
  assertEquals(overA.rec.status, 429);
  const stillB = await call(b, { userId: "shared" });
  assert(stillB.nexted);
  assertEquals(stillB.rec.status, null);
});

Deno.test("falls back to client IP when unauthenticated", async () => {
  const mw = rateLimiter(1, 60_000, "t", memoryStore());
  assert((await call(mw, { cfIp: "203.0.113.7" })).nexted);
  assertEquals((await call(mw, { cfIp: "203.0.113.7" })).rec.status, 429);
  assert((await call(mw, { cfIp: "203.0.113.8" })).nexted); // different IP, own budget
});

Deno.test("CF-Connecting-IP takes precedence over X-Forwarded-For", async () => {
  const mw = rateLimiter(1, 60_000, "t", memoryStore());
  await call(mw, { cfIp: "10.0.0.1", xff: "10.0.0.99" });
  // Same XFF, different CF IP -> different bucket -> still allowed.
  assert((await call(mw, { cfIp: "10.0.0.2", xff: "10.0.0.99" })).nexted);
});

Deno.test("no subject (no user, no IP) is allowed through", async () => {
  const mw = rateLimiter(1, 60_000, "t", memoryStore());
  assert((await call(mw, {})).nexted);
  assert((await call(mw, {})).nexted);
});

Deno.test("fails OPEN when the backing store errors", async () => {
  const mw = rateLimiter(1, 60_000, "t", throwingStore);
  const r1 = await call(mw, { userId: "x" });
  const r2 = await call(mw, { userId: "x" });
  assert(r1.nexted && r2.nexted);
  assertEquals(r2.rec.status, null);
});

// ─── US-354: trustworthy subject + fail-closed ──────────────────────

// AC1: X-Forwarded-For is fully client-controlled, so it must NOT become a
// rate-limit subject in production (the test env defaults to production). An
// unauthenticated request bearing ONLY an XFF header therefore has no trusted
// subject — on a fail-open limiter it passes through uncounted, so an attacker
// can't even establish a per-IP bucket to attack (and can't evade by rotating).
Deno.test("X-Forwarded-For is not trusted as a subject in production", async () => {
  const mw = rateLimiter(1, 60_000, "xff-distrust", memoryStore());
  const r1 = await call(mw, { xff: "1.2.3.4" });
  const r2 = await call(mw, { xff: "1.2.3.4" });
  // No trusted subject derived from XFF → never counted, never 429.
  assert(r1.nexted && r2.nexted);
  assertEquals(r2.rec.status, null);
});

// AC2: on a fail-CLOSED route the limiter must keep limiting when the
// distributed store is down — via the process-local fallback counter — instead
// of allowing the request (the old behavior would have gone unlimited).
Deno.test("failClosed: store outage falls back to a local counter and still 429s", async () => {
  const mw = rateLimiter(2, 60_000, "fc-storedown", throwingStore, {
    failClosed: true,
  });
  const r1 = await call(mw, { userId: "z" }); // 1 (fallback)
  const r2 = await call(mw, { userId: "z" }); // 2 (at limit)
  const r3 = await call(mw, { userId: "z" }); // 3 (over → 429)
  assert(r1.nexted && r2.nexted);
  assertEquals(r3.nexted, false);
  assertEquals(r3.rec.status, 429);
});

// AC2: a fail-OPEN route keeps allowing on a store outage (availability first).
// This is the contrast to the fail-closed case above.
Deno.test("failClosed off: store outage still fails open (unchanged)", async () => {
  const mw = rateLimiter(1, 60_000, "fc-open", throwingStore);
  assert((await call(mw, { userId: "z" })).nexted);
  assert((await call(mw, { userId: "z" })).nexted);
});

// AC2: stripping IP headers must not unlock a fail-closed route. With no user
// and no trusted IP, the request is bucketed into a shared 'unattributed'
// counter and limited, rather than waved through.
Deno.test("failClosed: header-stripped requests share one bucket and are limited", async () => {
  const mw = rateLimiter(1, 60_000, "fc-unattributed", memoryStore(), {
    failClosed: true,
  });
  const r1 = await call(mw, {}); // no user, no IP → ip:unattributed
  const r2 = await call(mw, {}); // same shared bucket → over limit
  assert(r1.nexted);
  assertEquals(r2.nexted, false);
  assertEquals(r2.rec.status, 429);
});

// AC3: when CF_ORIGIN_SECRET is configured, a CF-Connecting-IP is only trusted
// if the request also carries the matching secret header Cloudflare injects —
// proving it transited CF. A spoofed CF-Connecting-IP on a direct-to-origin
// request (no/incorrect secret) yields no trusted subject.
Deno.test("CF_ORIGIN_SECRET: CF-Connecting-IP is only trusted with the matching origin secret", async () => {
  Deno.env.set("CF_ORIGIN_SECRET", "s3cret-token");
  try {
    // Wrong/absent secret → forged CF-Connecting-IP is NOT trusted → no subject
    // → fail-open allows uncounted (can't be 429'd, can't establish a bucket).
    const mw = rateLimiter(1, 60_000, "cf-secret", memoryStore());
    assert((await call(mw, { cfIp: "203.0.113.9" })).nexted);
    const noSecret = await call(mw, { cfIp: "203.0.113.9" });
    assert(noSecret.nexted);
    assertEquals(noSecret.rec.status, null);

    // Correct secret → CF-Connecting-IP is trusted → the IP is limited normally.
    const mw2 = rateLimiter(1, 60_000, "cf-secret-ok", memoryStore());
    const hdr = { "cf-origin-secret": "s3cret-token" };
    assert((await call(mw2, { cfIp: "203.0.113.9", headers: hdr })).nexted);
    const over = await call(mw2, { cfIp: "203.0.113.9", headers: hdr });
    assertEquals(over.rec.status, 429);
  } finally {
    Deno.env.delete("CF_ORIGIN_SECRET");
  }
});

// ─── US-800: context-resolved limit, custom subject, custom 429 body ────

// The per-window limit can be a function of the request context (plan-tiered).
Deno.test("maxRequests as a resolver: limit is read from the context per request", async () => {
  const store = memoryStore();
  // Budget = 5 for a "business" plan var, 1 otherwise.
  const mw = rateLimiter(
    (c) =>
      (c.get as (k: string) => unknown)("apiKeyPlan") === "business" ? 5 : 1,
    60_000,
    "tiered",
    store,
  );
  // A "free" caller is limited at 1.
  assert((await call(mw, { userId: "free-u", vars: { apiKeyPlan: "free" } })).nexted);
  const freeOver = await call(mw, { userId: "free-u", vars: { apiKeyPlan: "free" } });
  assertEquals(freeOver.rec.status, 429);
  assertEquals(freeOver.rec.headers["X-RateLimit-Limit"], "1");
  // A "business" caller (distinct user → distinct bucket) gets 5.
  for (let i = 0; i < 5; i++) {
    const r = await call(mw, { userId: "biz-u", vars: { apiKeyPlan: "business" } });
    assert(r.nexted, `business request ${i + 1} should pass`);
  }
  const bizOver = await call(mw, { userId: "biz-u", vars: { apiKeyPlan: "business" } });
  assertEquals(bizOver.rec.status, 429);
  assertEquals(bizOver.rec.headers["X-RateLimit-Limit"], "5");
});

// opts.subject overrides the default user/IP keying so two keys held by the
// same user get independent budgets (US-800: bucket per API key, not per user).
Deno.test("opts.subject: distinct subjects keep independent budgets", async () => {
  const store = memoryStore();
  const subjectByKey: RateLimitContextResolver<string | null> = (c) => {
    const id = (c.get as (k: string) => unknown)("apiKeyId");
    return typeof id === "string" ? `apikey:${id}` : null;
  };
  const mw = rateLimiter(1, 60_000, "by-key", store, { subject: subjectByKey });
  // Same user, two different keys → two buckets.
  assert((await call(mw, { userId: "u", vars: { apiKeyId: "k1" } })).nexted);
  const k1Over = await call(mw, { userId: "u", vars: { apiKeyId: "k1" } });
  assertEquals(k1Over.rec.status, 429); // k1 exhausted
  const k2 = await call(mw, { userId: "u", vars: { apiKeyId: "k2" } });
  assert(k2.nexted); // k2 has its own budget
  assertEquals(k2.rec.status, null);
});

// opts.subject returning null on a fail-closed route buckets into the shared
// 'unattributed' counter (no free pass), matching the IP-stripped behavior.
Deno.test("opts.subject null + failClosed: shared bucket, still limited", async () => {
  const nullSubject: RateLimitContextResolver<string | null> = () => null;
  const mw = rateLimiter(1, 60_000, "subj-null-fc", memoryStore(), {
    subject: nullSubject,
    failClosed: true,
  });
  const r1 = await call(mw, { userId: "ignored" });
  const r2 = await call(mw, { userId: "ignored" });
  assert(r1.nexted);
  assertEquals(r2.rec.status, 429);
});

// opts.errorBody renders a custom 429 payload (the /api/v1 envelope).
Deno.test("opts.errorBody: 429 uses the custom envelope", async () => {
  const mw = rateLimiter(1, 60_000, "custom-body", memoryStore(), {
    errorBody: ({ retryAfter }) => ({
      data: null,
      error: { message: `slow down ${retryAfter}s`, details: [] },
      meta: { retry_after_seconds: retryAfter },
    }),
  });
  await call(mw, { userId: "u" });
  const over = await call(mw, { userId: "u" });
  assertEquals(over.rec.status, 429);
  const body = over.rec.body as {
    data: null;
    error: { message: string; details: unknown[] };
    meta: { retry_after_seconds: number };
  };
  assertEquals(body.data, null);
  assert(body.error.message.startsWith("slow down"));
  assert(body.meta.retry_after_seconds >= 1);
});

// ─── US-781: public-content limiter + Pages-origin bypass ───────────

import { pagesOriginBypass } from "../middleware/rate-limit.ts";

// The public content surface is fail-closed + per-IP. Under the limit passes;
// over the limit 429s with Retry-After (mirrors the /api/content/public/* mount).
Deno.test("content-public: per-IP, 429 over the limit", async () => {
  const mw = rateLimiter(2, 60_000, "content-public", memoryStore(), {
    failClosed: true,
    bypass: pagesOriginBypass,
  });
  assert((await call(mw, { cfIp: "198.51.100.5", method: "GET" })).nexted); // 1
  assert((await call(mw, { cfIp: "198.51.100.5", method: "GET" })).nexted); // 2
  const over = await call(mw, { cfIp: "198.51.100.5", method: "GET" }); // 3
  assertEquals(over.rec.status, 429);
  assert(Number(over.rec.headers["Retry-After"]) >= 1);
});

// A Pages-origin SSR hop (correct x-pages-origin secret) bypasses the limit so
// one Pages IP fronting all blog/cert visitors isn't starved.
Deno.test("content-public: a valid Pages-origin secret bypasses the limit", async () => {
  Deno.env.set("CF_PAGES_ORIGIN_SECRET", "pages-s3cret");
  try {
    const mw = rateLimiter(1, 60_000, "content-public-bypass", memoryStore(), {
      failClosed: true,
      bypass: pagesOriginBypass,
    });
    const hdr = { "x-pages-origin": "pages-s3cret" };
    // Far beyond a limit of 1 — all bypass.
    for (let i = 0; i < 5; i++) {
      const r = await call(mw, { cfIp: "198.51.100.6", method: "GET", headers: hdr });
      assert(r.nexted, `bypassed request ${i + 1} should pass`);
      assertEquals(r.rec.status, null);
    }
  } finally {
    Deno.env.delete("CF_PAGES_ORIGIN_SECRET");
  }
});

// A WRONG/absent Pages-origin secret is NOT bypassed — it's limited like any IP.
Deno.test("content-public: a wrong/absent Pages-origin secret is still limited", async () => {
  Deno.env.set("CF_PAGES_ORIGIN_SECRET", "pages-s3cret");
  try {
    const mw = rateLimiter(1, 60_000, "content-public-nobypass", memoryStore(), {
      failClosed: true,
      bypass: pagesOriginBypass,
    });
    // Wrong secret → no bypass → normal per-IP limiting.
    const hdr = { "x-pages-origin": "wrong" };
    assert((await call(mw, { cfIp: "198.51.100.7", method: "GET", headers: hdr })).nexted);
    const over = await call(mw, { cfIp: "198.51.100.7", method: "GET", headers: hdr });
    assertEquals(over.rec.status, 429);
  } finally {
    Deno.env.delete("CF_PAGES_ORIGIN_SECRET");
  }
});

// When CF_PAGES_ORIGIN_SECRET is UNSET, the bypass is inert (can't be a free pass).
Deno.test("content-public: bypass is inert when CF_PAGES_ORIGIN_SECRET is unset", async () => {
  const mw = rateLimiter(1, 60_000, "content-public-inert", memoryStore(), {
    failClosed: true,
    bypass: pagesOriginBypass,
  });
  const hdr = { "x-pages-origin": "anything" };
  assert((await call(mw, { cfIp: "198.51.100.8", method: "GET", headers: hdr })).nexted);
  const over = await call(mw, { cfIp: "198.51.100.8", method: "GET", headers: hdr });
  assertEquals(over.rec.status, 429);
});
