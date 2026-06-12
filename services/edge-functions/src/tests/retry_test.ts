// Unit tests for the retry/backoff helper (US-325). No live APIs, no real
// timers — `sleep` and `random` are injected so the suite runs instantly.

import { assert, assertEquals } from "@std/assert";
import {
  isRateLimitError,
  isRetryableError,
  retryAfterMs,
  withRetry,
} from "../lib/retry.ts";

const noSleep = () => Promise.resolve();
const fixedRandom = () => 0; // delay = 0, fully deterministic

function http(status: number, message = `HTTP ${status}`): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

Deno.test("isRetryableError: 429 and 5xx by status", () => {
  assert(isRetryableError(http(429)));
  assert(isRetryableError(http(503)));
  assert(isRetryableError(http(500)));
  assert(isRetryableError(http(408)));
});

Deno.test("isRetryableError: non-retryable client errors", () => {
  assertEquals(isRetryableError(http(400, "Bad Request")), false);
  assertEquals(isRetryableError(http(404, "Not Found")), false);
  assertEquals(isRetryableError(http(422, "Unprocessable")), false);
});

Deno.test("isRetryableError: message-pattern detection (no status)", () => {
  assert(isRetryableError(new Error("eBay category suggest failed (429): rate limit")));
  assert(isRetryableError(new Error("Overloaded")));
  assert(isRetryableError(new Error("ECONNRESET")));
  assertEquals(isRetryableError(new Error("validation failed: missing title")), false);
});

Deno.test("withRetry: succeeds after transient 429s", async () => {
  let calls = 0;
  const result = await withRetry(
    () => {
      calls++;
      if (calls < 3) throw http(429);
      return Promise.resolve("ok");
    },
    { maxAttempts: 3, sleep: noSleep, random: fixedRandom },
  );
  assertEquals(result, "ok");
  assertEquals(calls, 3);
});

Deno.test("withRetry: gives up after maxAttempts and rethrows last error", async () => {
  let calls = 0;
  let thrown: unknown;
  try {
    await withRetry(
      () => {
        calls++;
        throw http(503, "always down");
      },
      { maxAttempts: 3, sleep: noSleep, random: fixedRandom },
    );
  } catch (e) {
    thrown = e;
  }
  assertEquals(calls, 3);
  assert(thrown instanceof Error && (thrown as { status?: number }).status === 503);
});

Deno.test("withRetry: does NOT retry a non-retryable error", async () => {
  let calls = 0;
  try {
    await withRetry(
      () => {
        calls++;
        throw http(400, "bad request");
      },
      { maxAttempts: 5, sleep: noSleep, random: fixedRandom },
    );
  } catch {
    // expected
  }
  assertEquals(calls, 1);
});

// ─── US-406: rate-limit classification + Retry-After honoring ───────

Deno.test("isRateLimitError: 429 and quota messages, not generic 5xx", () => {
  assert(isRateLimitError(http(429)));
  assert(isRateLimitError(new Error("eBay GET /offer failed (429): rate limit")));
  assert(isRateLimitError(new Error("Daily call limit exceeded")));
  assertEquals(isRateLimitError(http(503, "service unavailable")), false);
  assertEquals(isRateLimitError(http(500)), false);
  assertEquals(isRateLimitError(new Error("ECONNRESET")), false);
});

Deno.test("retryAfterMs: reads a positive numeric hint, else null", () => {
  const withHint = Object.assign(http(429), { retryAfterMs: 1500 });
  assertEquals(retryAfterMs(withHint), 1500);
  assertEquals(retryAfterMs(http(429)), null); // no hint attached
  assertEquals(retryAfterMs(Object.assign(http(429), { retryAfterMs: 0 })), null);
  assertEquals(retryAfterMs(Object.assign(http(429), { retryAfterMs: -5 })), null);
  assertEquals(retryAfterMs(new Error("plain")), null);
});

Deno.test("withRetry: honors Retry-After hint over jittered backoff", async () => {
  let calls = 0;
  const delays: number[] = [];
  const err = Object.assign(http(429), { retryAfterMs: 2000 });
  await withRetry(
    () => {
      calls++;
      if (calls < 2) throw err;
      return Promise.resolve("ok");
    },
    {
      maxAttempts: 3,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
      // fixedRandom would make jitter 0; the hint must win regardless.
      random: fixedRandom,
    },
  );
  assertEquals(delays, [2000]); // waited exactly what eBay asked, not 0
});

Deno.test("withRetry: caps an oversized Retry-After at maxRetryAfterMs", async () => {
  const delays: number[] = [];
  const err = Object.assign(http(429), { retryAfterMs: 3_600_000 }); // 1h
  try {
    await withRetry(
      () => Promise.reject(err),
      {
        maxAttempts: 2,
        maxRetryAfterMs: 30_000,
        sleep: (ms) => {
          delays.push(ms);
          return Promise.resolve();
        },
        random: fixedRandom,
      },
    );
  } catch {
    // expected to exhaust
  }
  assertEquals(delays, [30_000]); // clamped, never the full hour
});

Deno.test("withRetry: onRetry fires once per backoff", async () => {
  let calls = 0;
  const retries: number[] = [];
  await withRetry(
    () => {
      calls++;
      if (calls < 3) throw http(429);
      return Promise.resolve(42);
    },
    {
      maxAttempts: 4,
      sleep: noSleep,
      random: fixedRandom,
      onRetry: (info) => retries.push(info.attempt),
    },
  );
  assertEquals(retries, [1, 2]); // two retries before the 3rd call succeeds
});
