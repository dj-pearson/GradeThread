// US-2324 AC4: 429 and 5xx retry with Retry-After, for the marketplace clients.
//
// Etsy, Depop and Whatnot each did `fetchWithTimeout` then `if (!res.ok) throw`.
// A 429 — the one failure guaranteed to clear if you simply wait — aborted the
// whole sync, and the `Retry-After` the server had just supplied was thrown
// away with the response.
//
// These are BEHAVIOURAL, not source scans: the policy is injectable (the caller
// passes a fetch thunk and a sleep), so the actual retry behaviour can be
// driven here. That matters more than usual because the COUNT is the fix — a
// source assertion that "it imports withRetry" would pass against a maxAttempts
// of 1 or of Infinity, and both are wrong in opposite directions.

import { assert, assertEquals, assertRejects } from "@std/assert";
import { fetchWithRateLimitRetry } from "../lib/http-retry.ts";

function res(status: number, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : "{}", { status, headers });
}

Deno.test("US-2324: a 429 is retried, not thrown", async () => {
  let calls = 0;
  const out = await fetchWithRateLimitRetry(
    () => {
      calls++;
      return Promise.resolve(calls === 1 ? res(429) : res(200));
    },
    { label: "test", sleep: () => Promise.resolve() },
  );
  assertEquals(out.status, 200);
  assertEquals(calls, 2, "the 429 should have been retried exactly once");
});

Deno.test("US-2324: a permanent 429 stops instead of retrying forever", async () => {
  // Bounding the retry is the fix. An unbounded one hammers a partner that has
  // just asked to be left alone, which is how an app gets its key revoked.
  let calls = 0;
  await assertRejects(
    () =>
      fetchWithRateLimitRetry(
        () => {
          calls++;
          return Promise.resolve(res(429));
        },
        { label: "test", sleep: () => Promise.resolve() },
      ),
    Error,
  );
  assert(calls > 1, "should have retried at least once");
  assert(calls <= 5, `retried ${calls} times — the bound is gone`);
});

Deno.test("US-2324: the server's Retry-After is honoured", async () => {
  const waits: number[] = [];
  let calls = 0;
  await fetchWithRateLimitRetry(
    () => {
      calls++;
      return Promise.resolve(
        calls === 1 ? res(429, { "retry-after": "7" }) : res(200),
      );
    },
    {
      label: "test",
      sleep: (ms: number) => {
        waits.push(ms);
        return Promise.resolve();
      },
    },
  );
  assertEquals(waits.length, 1);
  // 7 seconds, as instructed — not a backoff number we invented.
  assert(
    waits[0]! >= 7000,
    `waited ${waits[0]}ms, ignoring the server's Retry-After: 7`,
  );
});

Deno.test("US-2324: 5xx retries, and a 502 that clears still succeeds", async () => {
  // Bounding a retry is worthless if it stops retrying: the point is to survive
  // a transient blip, not merely to fail politely.
  let calls = 0;
  const out = await fetchWithRateLimitRetry(
    () => {
      calls++;
      return Promise.resolve(calls < 3 ? res(502) : res(200));
    },
    { label: "test", sleep: () => Promise.resolve() },
  );
  assertEquals(out.status, 200);
  assertEquals(calls, 3);
});

Deno.test("US-2324: a 404 is NOT retried and is returned unchanged", async () => {
  // The contract that keeps each client's own handling working. A 404 is an
  // answer; retrying it spends quota re-asking a question already answered, and
  // swallowing it would break the callers that branch on it.
  let calls = 0;
  const out = await fetchWithRateLimitRetry(
    () => {
      calls++;
      return Promise.resolve(res(404));
    },
    { label: "test", sleep: () => Promise.resolve() },
  );
  assertEquals(out.status, 404);
  assertEquals(calls, 1);
});

Deno.test("US-2324: 2xx and 204 pass straight through", async () => {
  for (const status of [200, 201, 204]) {
    let calls = 0;
    const out = await fetchWithRateLimitRetry(
      () => {
        calls++;
        return Promise.resolve(res(status));
      },
      { label: "test", sleep: () => Promise.resolve() },
    );
    assertEquals(out.status, status);
    assertEquals(calls, 1, `status ${status} should not retry`);
  }
});

Deno.test("US-2324: all three marketplace clients route through the wrapper", async () => {
  // The helper is worthless if a client goes back to a bare call. Checked by
  // source because the alternative is standing up three live partner APIs.
  for (
    const f of ["etsy-api.ts", "depop-api.ts", "whatnot-api.ts"]
  ) {
    const src = await Deno.readTextFile(new URL(`../lib/${f}`, import.meta.url));
    assert(
      src.includes("fetchWithRateLimitRetry("),
      `${f} no longer retries rate limits`,
    );
    assert(
      !/const res = await fetchWithTimeout\(/.test(src),
      `${f} calls fetchWithTimeout directly again, bypassing the retry`,
    );
  }
});
