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
}

function makeCtx(
  opts: { userId?: string; cfIp?: string; xff?: string } = {},
): { c: unknown; rec: FakeCtx } {
  const rec: FakeCtx = { headers: {}, status: null };
  const reqHeaders: Record<string, string> = {};
  if (opts.cfIp) reqHeaders["cf-connecting-ip"] = opts.cfIp;
  if (opts.xff) reqHeaders["x-forwarded-for"] = opts.xff;
  const c = {
    get: (k: string) => (k === "userId" ? opts.userId : undefined),
    req: { header: (name: string) => reqHeaders[name.toLowerCase()] },
    header: (name: string, value: string) => {
      rec.headers[name] = value;
    },
    json: (_body: unknown, status?: number) => {
      rec.status = status ?? 200;
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
