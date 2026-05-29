// Unit tests for the retry/backoff helper (US-325). No live APIs, no real
// timers — `sleep` and `random` are injected so the suite runs instantly.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isRetryableError, withRetry } from "../lib/retry.ts";

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
