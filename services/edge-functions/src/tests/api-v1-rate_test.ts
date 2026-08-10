// US-800: per-key, plan-tiered API rate-limit policy.
//
// Unit-tests the pure resolvers in middleware/api-v1-rate.ts (tier lookup,
// subject keying, 429 envelope) plus an end-to-end pass through the shared
// rateLimiter with an in-memory counter — proving a business-plan key gets its
// budget, exhausts to a 429 in the /api/v1 envelope, two keys stay independent,
// and a store outage still limits (fail-closed).
import { assert, assertEquals } from "@std/assert";
import type { Context } from "hono";
import {
  API_RATE_TIERS,
  apiV1RateLimitBody,
  apiV1ReadLimit,
  apiV1Subject,
  apiV1Tier,
  apiV1WriteLimit,
} from "../middleware/api-v1-rate.ts";
import {
  __resetLocalFallbackForTest,
  rateLimiter,
  type RateLimitIncrementer,
} from "../middleware/rate-limit.ts";

// Minimal context stand-in exposing only c.get, which is all the resolvers use.
// Cast to Context since the resolvers type their param as the full Context.
function ctx(vars: Record<string, string | undefined>): Context {
  return { get: (k: string) => vars[k] } as unknown as Context;
}

Deno.test("apiV1Tier: maps each known plan; unknown/absent → free (tightest)", () => {
  assertEquals(apiV1Tier(ctx({ apiKeyPlan: "business" })), API_RATE_TIERS.business);
  assertEquals(apiV1Tier(ctx({ apiKeyPlan: "pro" })), API_RATE_TIERS.pro);
  assertEquals(apiV1Tier(ctx({ apiKeyPlan: "super_admin" })), API_RATE_TIERS.super_admin);
  // Unknown plan string and missing var both fall back to the free tier.
  assertEquals(apiV1Tier(ctx({ apiKeyPlan: "mystery" })), API_RATE_TIERS.free);
  assertEquals(apiV1Tier(ctx({})), API_RATE_TIERS.free);
});

Deno.test("write budget is tighter than read budget for every tier", () => {
  for (const [plan, tier] of Object.entries(API_RATE_TIERS)) {
    assert(tier.write < tier.read, `${plan}: write (${tier.write}) should be < read (${tier.read})`);
    assert(tier.write > 0 && tier.read > 0, `${plan}: budgets must be positive`);
  }
});

Deno.test("apiV1ReadLimit / apiV1WriteLimit read from the plan tier", () => {
  const c = ctx({ apiKeyPlan: "business" });
  assertEquals(apiV1ReadLimit(c), API_RATE_TIERS.business.read);
  assertEquals(apiV1WriteLimit(c), API_RATE_TIERS.business.write);
});

Deno.test("apiV1Subject: prefers the key id, falls back to user, then null", () => {
  assertEquals(apiV1Subject(ctx({ apiKeyId: "key-1", userId: "u" })), "apikey:key-1");
  assertEquals(apiV1Subject(ctx({ userId: "u" })), "user:u");
  assertEquals(apiV1Subject(ctx({})), null);
});

Deno.test("apiV1RateLimitBody: matches the /api/v1 { data, error, meta } envelope", () => {
  const body = apiV1RateLimitBody({ retryAfter: 12 }) as {
    data: null;
    error: { message: string; details: unknown[] };
    meta: { retry_after_seconds: number };
  };
  assertEquals(body.data, null);
  assertEquals(body.error.details, []);
  assert(body.error.message.includes("12"));
  assertEquals(body.meta.retry_after_seconds, 12);
});

// ── End-to-end through the shared limiter ──────────────────────────

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

interface Rec {
  status: number | null;
  body: unknown;
  headers: Record<string, string>;
}

// Drive the write-limiter (POST) the way main.ts mounts it for /api/v1.
async function invoke(
  mw: ReturnType<typeof rateLimiter>,
  vars: Record<string, string | undefined>,
): Promise<{ rec: Rec; nexted: boolean }> {
  const rec: Rec = { status: null, body: undefined, headers: {} };
  const c = {
    get: (k: string) => vars[k],
    req: { method: "POST", header: () => undefined },
    header: (n: string, v: string) => {
      rec.headers[n] = v;
    },
    json: (body: unknown, status?: number) => {
      rec.status = status ?? 200;
      rec.body = body;
      return { __response: true };
    },
  };
  let nexted = false;
  await (mw as unknown as (c: unknown, next: () => Promise<void>) => Promise<unknown>)(
    c,
    () => {
      nexted = true;
      return Promise.resolve();
    },
  );
  return { rec, nexted };
}

// US-2448: the limiter derives its fixed window from a clock, so every test
// that spends a WHOLE budget pins that clock. Left on the wall clock, a real
// minute boundary landing mid-run rolls the window, resets the counter and lets
// the over-budget request through — correct for a fixed window, fatal for a
// test. This instant is deliberately 5ms BEFORE a boundary: it is the worst
// case for the old wall-clock code and a non-event once the clock is injected.
const NEAR_BOUNDARY = Date.parse("2026-08-09T12:00:59.995Z");
const WINDOW_MS = 60_000;

function writeLimiter(
  store: RateLimitIncrementer,
  now: () => number = () => NEAR_BOUNDARY,
) {
  return rateLimiter(apiV1WriteLimit, WINDOW_MS, "api-v1-write", store, {
    methods: ["POST", "PATCH", "PUT", "DELETE"],
    subject: apiV1Subject,
    failClosed: true,
    errorBody: apiV1RateLimitBody,
    now,
  });
}

Deno.test("a business key exhausts its write budget and 429s in the API envelope", async () => {
  const mw = writeLimiter(memoryStore());
  const budget = API_RATE_TIERS.business.write;
  const vars = { apiKeyId: "k-biz", userId: "u", apiKeyPlan: "business" };
  for (let i = 0; i < budget; i++) {
    const r = await invoke(mw, vars);
    assert(r.nexted, `request ${i + 1}/${budget} should pass`);
  }
  const over = await invoke(mw, vars);
  assertEquals(over.nexted, false);
  assertEquals(over.rec.status, 429);
  assertEquals(over.rec.headers["X-RateLimit-Limit"], String(budget));
  assertEquals(over.rec.headers["X-RateLimit-Remaining"], "0");
  assert(Number(over.rec.headers["Retry-After"]) >= 1);
  // 429 body is the /api/v1 envelope, not the bare { error } string.
  const body = over.rec.body as { data: null; error: { message: string } };
  assertEquals(body.data, null);
  assert(body.error.message.toLowerCase().includes("rate limit"));
});

Deno.test("two keys held by the same user keep independent budgets", async () => {
  const mw = writeLimiter(memoryStore());
  const budget = API_RATE_TIERS.business.write;
  const base = { userId: "u", apiKeyPlan: "business" };
  // Exhaust key A.
  for (let i = 0; i < budget; i++) await invoke(mw, { ...base, apiKeyId: "A" });
  assertEquals((await invoke(mw, { ...base, apiKeyId: "A" })).rec.status, 429);
  // Key B (same user) is untouched.
  const b = await invoke(mw, { ...base, apiKeyId: "B" });
  assert(b.nexted);
  assertEquals(b.rec.status, null);
});

Deno.test("fail-closed: a counter-store outage still limits the paid API", async () => {
  __resetLocalFallbackForTest();
  const mw = writeLimiter(throwingStore);
  const budget = API_RATE_TIERS.business.write;
  const vars = { apiKeyId: "k-fc", userId: "u", apiKeyPlan: "business" };
  // The process-local fallback enforces the same budget per replica.
  for (let i = 0; i < budget; i++) {
    assert((await invoke(mw, vars)).nexted, `fallback request ${i + 1} should pass`);
  }
  const over = await invoke(mw, vars);
  assertEquals(over.rec.status, 429);
});

// ── US-2448: the flake, reproduced and then pinned ─────────────────
//
// The bug was never in the limiter — it was the test trusting the wall clock.
// This reproduces the exact mechanism on a clock the test drives, so the coin
// flip becomes two deterministic assertions instead of a rare red run.
Deno.test("US-2448 repro: a window boundary mid-budget is what let the over-budget request through", async () => {
  const budget = API_RATE_TIERS.business.write;
  const vars = { apiKeyId: "k-straddle", userId: "u", apiKeyPlan: "business" };

  // (a) The boundary DOES fall mid-run — the counter legitimately resets and
  // the over-budget request is allowed. This is the flaky outcome, on demand.
  __resetLocalFallbackForTest();
  let clock = NEAR_BOUNDARY;
  const straddling = writeLimiter(throwingStore, () => clock);
  for (let i = 0; i < budget; i++) {
    assert((await invoke(straddling, vars)).nexted, `request ${i + 1} should pass`);
  }
  clock = NEAR_BOUNDARY + 10; // crosses 12:01:00 → new window
  const afterRollover = await invoke(straddling, vars);
  assert(
    afterRollover.nexted,
    "a fixed window that has rolled over must reset the counter — this is the " +
      "correct behaviour the old test was gambling against",
  );

  // (b) The same run on a pinned clock. No boundary can occur, so the
  // over-budget request is refused every time, not merely usually.
  __resetLocalFallbackForTest();
  const pinned = writeLimiter(throwingStore);
  for (let i = 0; i < budget; i++) {
    assert((await invoke(pinned, vars)).nexted, `pinned request ${i + 1} should pass`);
  }
  assertEquals((await invoke(pinned, vars)).rec.status, 429);
});

// Proves the injected clock is actually USED rather than accepted and ignored —
// without this, (b) above would still pass on the old wall-clock code whenever
// the boundary happened to miss, which is precisely the flaky test it replaces.
Deno.test("US-2448: the window is derived from the injected clock, not the wall clock", async () => {
  __resetLocalFallbackForTest();
  const mw = writeLimiter(memoryStore());
  const r = await invoke(mw, { apiKeyId: "k-clock", userId: "u", apiKeyPlan: "business" });
  // NEAR_BOUNDARY sits in the 12:00:00 window, so the reset is 12:01:00.
  const expectedWindowStart = Math.floor(NEAR_BOUNDARY / WINDOW_MS) * WINDOW_MS;
  assertEquals(
    r.rec.headers["X-RateLimit-Reset"],
    String(Math.ceil((expectedWindowStart + WINDOW_MS) / 1000)),
  );
  assertEquals(
    new Date(expectedWindowStart).toISOString(),
    "2026-08-09T12:00:00.000Z",
  );
});

// AC3: the process-local fallback used to keep ONE module-level window and
// clear the WHOLE map on any change, so a bucket on a different window cadence
// silently zeroed everyone else's counter. Every mount ships a 60s window today
// so this was never live in production, but it made the fallback counter
// order-dependent across test files sharing one deno process — and it would
// become a real hole the day a mount picks a different window.
Deno.test("US-2448: one bucket rolling its window does not reset another bucket's fallback count", async () => {
  __resetLocalFallbackForTest();
  // Mid-window, NOT NEAR_BOUNDARY: this test advances the clock a few seconds,
  // and starting 5ms before a boundary would roll bucket A's own 60s window
  // too, so the assertion would pass or fail for the wrong reason.
  const MID_WINDOW = Date.parse("2026-08-09T12:00:30.000Z");
  let clock = MID_WINDOW;
  const vars = { apiKeyId: "k-slow", userId: "u", apiKeyPlan: "business" };
  const budget = API_RATE_TIERS.business.write;

  // Bucket A: the 60s api-v1 write limiter, driven to exactly its budget.
  const slow = writeLimiter(throwingStore, () => clock);
  for (let i = 0; i < budget; i++) {
    assert((await invoke(slow, vars)).nexted, `A request ${i + 1} should pass`);
  }

  // Bucket B: a 1s window on the same replica, rolled over twice. Under the old
  // shape each roll called localFallback.clear() and wiped bucket A with it.
  const fast = rateLimiter(5, 1_000, "fast-scope", throwingStore, {
    methods: ["POST"],
    subject: () => "apikey:k-fast",
    failClosed: true,
    now: () => clock,
  });
  await invoke(fast, vars);
  clock += 1_100;
  await invoke(fast, vars);
  clock += 1_100;
  await invoke(fast, vars);

  // Bucket A is still inside its own 60s window (only ~2.2s elapsed), so its
  // budget must still be spent and the next request refused.
  clock = MID_WINDOW + 2_500;
  assertEquals((await invoke(slow, vars)).rec.status, 429);
});
