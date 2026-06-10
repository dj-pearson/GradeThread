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

function writeLimiter(store: RateLimitIncrementer) {
  return rateLimiter(apiV1WriteLimit, 60_000, "api-v1-write", store, {
    methods: ["POST", "PATCH", "PUT", "DELETE"],
    subject: apiV1Subject,
    failClosed: true,
    errorBody: apiV1RateLimitBody,
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
