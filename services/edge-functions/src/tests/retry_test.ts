// Unit tests for the retry/backoff helper (US-325). No live APIs, no real
// timers — `sleep` and `random` are injected so the suite runs instantly.

import { assert, assertEquals } from "@std/assert";
import {
  isRateLimitError,
  isRetryableError,
  parseRetryAfter,
  retryAfterMsFromError,
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

// ── US-406: rate-limit detection ───────────────────────────────────────

Deno.test("isRateLimitError: only 429, not other retryables", () => {
  assert(isRateLimitError(http(429)));
  assertEquals(isRateLimitError(http(503)), false);
  assertEquals(isRateLimitError(http(500)), false);
  assert(isRateLimitError(new Error("eBay GET /offer failed (429): too many requests")));
  assertEquals(isRateLimitError(new Error("validation failed")), false);
});

// ── US-406: Retry-After parsing ────────────────────────────────────────

Deno.test("parseRetryAfter: delta-seconds → ms", () => {
  assertEquals(parseRetryAfter("120"), 120_000);
  assertEquals(parseRetryAfter("0"), 0);
});

Deno.test("parseRetryAfter: HTTP-date → ms from now", () => {
  const now = Date.parse("Wed, 21 Oct 2026 07:28:00 GMT");
  assertEquals(
    parseRetryAfter("Wed, 21 Oct 2026 07:28:30 GMT", now),
    30_000,
  );
  // A past date clamps to 0, never negative.
  assertEquals(
    parseRetryAfter("Wed, 21 Oct 2026 07:27:00 GMT", now),
    0,
  );
});

Deno.test("parseRetryAfter: absent/blank/garbage → null", () => {
  assertEquals(parseRetryAfter(null), null);
  assertEquals(parseRetryAfter(undefined), null);
  assertEquals(parseRetryAfter(""), null);
  assertEquals(parseRetryAfter("soon"), null);
});

Deno.test("retryAfterMsFromError: reads retryAfterMs and retryAfter(seconds)", () => {
  assertEquals(retryAfterMsFromError({ retryAfterMs: 4500 }), 4500);
  assertEquals(retryAfterMsFromError({ retryAfter: 3 }), 3000);
  assertEquals(retryAfterMsFromError({ status: 429 }), null);
  assertEquals(retryAfterMsFromError(new Error("nope")), null);
});

// ── US-406: withRetry honors Retry-After ───────────────────────────────

Deno.test("withRetry: waits the server-sent Retry-After (bounded)", async () => {
  const delays: number[] = [];
  let calls = 0;
  const err = Object.assign(new Error("429"), { status: 429, retryAfterMs: 2000 });
  await withRetry(
    () => {
      calls++;
      if (calls < 2) throw err;
      return Promise.resolve("ok");
    },
    {
      maxAttempts: 3,
      sleep: noSleep,
      random: fixedRandom, // jitter term = 0 → delay == honored Retry-After
      onRetry: (info) => delays.push(info.delayMs),
    },
  );
  assertEquals(delays, [2000]);
});

Deno.test("withRetry: Retry-After is clamped to maxRetryAfterMs", async () => {
  const delays: number[] = [];
  const err = Object.assign(new Error("429"), { status: 429, retryAfter: 9999 });
  let calls = 0;
  await withRetry(
    () => {
      calls++;
      if (calls < 2) throw err;
      return Promise.resolve("ok");
    },
    {
      maxAttempts: 2,
      sleep: noSleep,
      random: fixedRandom,
      maxRetryAfterMs: 5000,
      onRetry: (info) => delays.push(info.delayMs),
    },
  );
  assertEquals(delays, [5000]); // 9999s clamped to the 5s cap
});
