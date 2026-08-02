// Unit tests for the retry/backoff helper (US-325). No live APIs, no real
// timers — `sleep` and `random` are injected so the suite runs instantly.

import { assert, assertEquals } from "@std/assert";
import {
  isRateLimitError,
  isRetryableError,
  parseRetryAfterHeader,
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

// ─── US-2305: Anthropic 529 + header-borne Retry-After ──────────────
//
// The Anthropic SDK throws an APIError carrying a numeric `status` and a real
// `Headers` object. 529 ("overloaded_error") used to survive only because the
// message happened to say "overloaded", and its Retry-After was never read at
// all because nothing attached a `retryAfterMs` property on the AI path.

// Shaped like the SDK's APIError: numeric status + a Headers instance.
function anthropicError(
  status: number,
  headers: Record<string, string> = {},
  message = `${status} {"type":"error"}`,
): Error & { status: number; headers: Headers } {
  const e = new Error(message) as Error & { status: number; headers: Headers };
  e.status = status;
  e.headers = new Headers(headers);
  return e;
}

Deno.test("US-2305: a 529 is retryable by STATUS, not by its message text", () => {
  // No "overloaded" anywhere in the message — the old string match would miss it.
  assert(isRetryableError(anthropicError(529, {}, "529 request failed")));
  assert(isRetryableError(http(529, "529 request failed")));
  // The message fallback still works for errors that carry no status.
  assert(isRetryableError(new Error("Overloaded")));
  // 529 is an overload, not a quota error — it must not read as a rate limit.
  assertEquals(isRateLimitError(anthropicError(529, {}, "529 request failed")), false);
});

Deno.test("parseRetryAfterHeader: seconds, HTTP-date, and garbage", () => {
  assertEquals(parseRetryAfterHeader("2"), 2000);
  assertEquals(parseRetryAfterHeader(" 30 "), 30_000);
  assertEquals(parseRetryAfterHeader("0"), 0);
  assertEquals(parseRetryAfterHeader(null), null);
  assertEquals(parseRetryAfterHeader(""), null);
  assertEquals(parseRetryAfterHeader("soon"), null);
  const future = new Date(Date.now() + 5_000).toUTCString();
  const fromDate = parseRetryAfterHeader(future);
  assert(fromDate !== null && fromDate > 0 && fromDate <= 5_000);
});

Deno.test("US-2305: retryAfterMs reads the Retry-After header off the error", () => {
  // Headers instance (Anthropic SDK shape).
  assertEquals(retryAfterMs(anthropicError(429, { "retry-after": "7" })), 7000);
  // Plain record (clients that hand back a bare object).
  const rec = Object.assign(http(429), { headers: { "Retry-After": "3" } });
  assertEquals(retryAfterMs(rec), 3000);
  // An explicitly attached hint still wins over the header.
  const both = Object.assign(anthropicError(429, { "retry-after": "7" }), {
    retryAfterMs: 1500,
  });
  assertEquals(retryAfterMs(both), 1500);
  // No header, no hint → null (jittered backoff).
  assertEquals(retryAfterMs(anthropicError(429)), null);
  assertEquals(retryAfterMs(anthropicError(429, { "retry-after": "soon" })), null);
});

Deno.test("US-2305: withRetry honors an Anthropic 429's Retry-After header", async () => {
  let calls = 0;
  const delays: number[] = [];
  await withRetry(
    () => {
      calls++;
      if (calls < 2) throw anthropicError(429, { "retry-after": "4" });
      return Promise.resolve("ok");
    },
    {
      maxAttempts: 3,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
      random: fixedRandom, // jitter would be 0; the header must win
    },
  );
  assertEquals(delays, [4000]);
  assertEquals(calls, 2);
});

Deno.test("US-2305: withRetry retries a 529 and caps its Retry-After", async () => {
  const delays: number[] = [];
  let calls = 0;
  const result = await withRetry(
    () => {
      calls++;
      if (calls < 3) throw anthropicError(529, { "retry-after": "3600" }, "529 overload");
      return Promise.resolve("graded");
    },
    {
      maxAttempts: 3,
      maxRetryAfterMs: 30_000,
      sleep: (ms) => {
        delays.push(ms);
        return Promise.resolve();
      },
      random: fixedRandom,
    },
  );
  assertEquals(result, "graded");
  assertEquals(delays, [30_000, 30_000]); // clamped, never the full hour
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
