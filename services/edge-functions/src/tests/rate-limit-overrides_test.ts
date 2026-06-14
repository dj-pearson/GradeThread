// US-890: rate-limit override unit tests.
//
// Cover the PURE pieces (apply + validate) and the limiter's override hook via
// the injectable resolver, so the decision logic runs with no database — the same
// in CI as locally.
import { assert, assertEquals } from "@std/assert";
import {
  applyRateLimitOverride,
  type RateLimitOverride,
  validateOverrideInput,
} from "../lib/rate-limit-overrides.ts";
import { rateLimiter, type RateLimitIncrementer } from "../middleware/rate-limit.ts";

function makeOverride(partial: Partial<RateLimitOverride>): RateLimitOverride {
  return {
    subjectUserId: "u1",
    mode: "multiplier",
    multiplier: 2,
    cap: null,
    reason: "test",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdBy: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...partial,
  };
}

Deno.test("applyRateLimitOverride: multiplier scales the base (floored, >= 0)", () => {
  assertEquals(applyRateLimitOverride(60, makeOverride({ mode: "multiplier", multiplier: 2 })), 120);
  assertEquals(applyRateLimitOverride(60, makeOverride({ mode: "multiplier", multiplier: 0.25 })), 15);
  assertEquals(applyRateLimitOverride(7, makeOverride({ mode: "multiplier", multiplier: 0.5 })), 3); // floor(3.5)
  assertEquals(applyRateLimitOverride(60, makeOverride({ mode: "multiplier", multiplier: 0 })), 0);
});

Deno.test("applyRateLimitOverride: cap pins an absolute ceiling (can raise or lower)", () => {
  assertEquals(applyRateLimitOverride(60, makeOverride({ mode: "cap", multiplier: null, cap: 10 })), 10);
  assertEquals(applyRateLimitOverride(60, makeOverride({ mode: "cap", multiplier: null, cap: 500 })), 500);
});

const BOUNDS = { maxMultiplier: 20, maxDurationMinutes: 10080 };
const NOW = 1_700_000_000_000;

Deno.test("validateOverrideInput: rejects bad mode / missing reason / bad duration", () => {
  assert(!validateOverrideInput({ mode: "nope" }, BOUNDS, NOW).ok);
  assert(!validateOverrideInput({ mode: "block", expiresInMinutes: 5 }, BOUNDS, NOW).ok); // no reason
  assert(!validateOverrideInput({ mode: "block", reason: "x", expiresInMinutes: 0 }, BOUNDS, NOW).ok);
  assert(!validateOverrideInput({ mode: "block", reason: "x", expiresInMinutes: -1 }, BOUNDS, NOW).ok);
  assert(!validateOverrideInput({ mode: "block", reason: "x", expiresInMinutes: 99999999 }, BOUNDS, NOW).ok);
});

Deno.test("validateOverrideInput: multiplier mode enforces bounds and normalizes", () => {
  const tooBig = validateOverrideInput(
    { mode: "multiplier", multiplier: 1000, reason: "boost", expiresInMinutes: 60 },
    BOUNDS,
    NOW,
  );
  assert(!tooBig.ok);

  const ok = validateOverrideInput(
    { mode: "multiplier", multiplier: 3, reason: " boost ", expiresInMinutes: 120 },
    BOUNDS,
    NOW,
  );
  assert(ok.ok);
  if (ok.ok) {
    assertEquals(ok.value.mode, "multiplier");
    assertEquals(ok.value.multiplier, 3);
    assertEquals(ok.value.cap, null);
    assertEquals(ok.value.reason, "boost"); // trimmed
    assertEquals(ok.value.expiresAt, new Date(NOW + 120 * 60_000).toISOString());
  }
});

Deno.test("validateOverrideInput: cap mode floors and requires a non-negative number", () => {
  assert(!validateOverrideInput({ mode: "cap", cap: -1, reason: "x", expiresInMinutes: 5 }, BOUNDS, NOW).ok);
  const ok = validateOverrideInput({ mode: "cap", cap: 12.9, reason: "x", expiresInMinutes: 5 }, BOUNDS, NOW);
  assert(ok.ok);
  if (ok.ok) {
    assertEquals(ok.value.cap, 12);
    assertEquals(ok.value.multiplier, null);
  }
});

Deno.test("validateOverrideInput: block mode carries neither multiplier nor cap", () => {
  const ok = validateOverrideInput({ mode: "block", reason: "abuse", expiresInMinutes: 30 }, BOUNDS, NOW);
  assert(ok.ok);
  if (ok.ok) {
    assertEquals(ok.value.mode, "block");
    assertEquals(ok.value.multiplier, null);
    assertEquals(ok.value.cap, null);
  }
});

// ── Limiter integration via the injectable override resolver ──────────────────

interface FakeCtx {
  headers: Record<string, string>;
  status: number | null;
  body: unknown;
}

function makeCtx(userId: string): { c: unknown; ctx: FakeCtx } {
  const ctx: FakeCtx = { headers: {}, status: null, body: null };
  const store: Record<string, unknown> = { userId };
  const c = {
    req: { method: "POST", url: "https://x/api/grade/submit", header: () => undefined },
    get: (k: string) => store[k],
    header: (k: string, v: string) => {
      ctx.headers[k] = v;
    },
    json: (b: unknown, s = 200) => {
      ctx.body = b;
      ctx.status = s;
      return b;
    },
  };
  return { c, ctx };
}

function memoryStore(): RateLimitIncrementer {
  const counts = new Map<string, number>();
  return (bucketKey, windowStartIso) => {
    const k = `${bucketKey}|${windowStartIso}`;
    const next = (counts.get(k) ?? 0) + 1;
    counts.set(k, next);
    return Promise.resolve(next);
  };
}

Deno.test("limiter honors a 'block' override — 429 before counting, with Retry-After", async () => {
  const mw = rateLimiter(60, 60_000, "grade", memoryStore(), {
    overrideResolver: () => makeOverride({ mode: "block", multiplier: null, cap: null }),
  });
  const { c, ctx } = makeCtx("u-blocked");
  let nextCalled = false;
  // deno-lint-ignore no-explicit-any
  await (mw as any)(c, () => {
    nextCalled = true;
    return Promise.resolve();
  });
  assertEquals(ctx.status, 429);
  assert(!nextCalled, "blocked request must not reach the route");
  assert(ctx.headers["Retry-After"], "Retry-After should be set");
  assertEquals(ctx.headers["X-RateLimit-Limit"], "0");
});

Deno.test("limiter honors a 'cap' override — exceeding the lowered cap 429s", async () => {
  const store = memoryStore();
  const mw = rateLimiter(60, 60_000, "grade", store, {
    overrideResolver: () => makeOverride({ mode: "cap", multiplier: null, cap: 2 }),
  });
  async function hit() {
    const { c, ctx } = makeCtx("u-capped");
    let nextCalled = false;
    // deno-lint-ignore no-explicit-any
    await (mw as any)(c, () => {
      nextCalled = true;
      return Promise.resolve();
    });
    return { ctx, nextCalled };
  }
  assertEquals((await hit()).nextCalled, true); // 1 <= 2
  assertEquals((await hit()).nextCalled, true); // 2 <= 2
  const third = await hit(); // 3 > 2
  assertEquals(third.nextCalled, false);
  assertEquals(third.ctx.status, 429);
});

Deno.test("limiter ignores an EXPIRED override (resolver returns null) — base limit applies", async () => {
  // The live getRateLimitOverrideSync returns null for an expired entry; emulate
  // that here. Base limit 60 means a single request passes.
  const mw = rateLimiter(60, 60_000, "grade", memoryStore(), {
    overrideResolver: () => null,
  });
  const { c, ctx } = makeCtx("u-expired");
  let nextCalled = false;
  // deno-lint-ignore no-explicit-any
  await (mw as any)(c, () => {
    nextCalled = true;
    return Promise.resolve();
  });
  assertEquals(nextCalled, true);
  assertEquals(ctx.status, null);
  assertEquals(ctx.headers["X-RateLimit-Limit"], "60");
});
