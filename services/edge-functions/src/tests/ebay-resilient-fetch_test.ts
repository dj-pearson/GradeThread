// US-1966: the hardened eBay fetch path shared by every side-channel family.
//
// Finances (ebay-client listRecentTransactions/getPayouts/getPayout), Marketing
// (ebay-marketing marketingFetch), Disputes (ebay-disputes disputeFetch), and
// Post-Order (ebay-postorder postOrderFetch) all now route their single request
// through ebayResilientFetch -> fetchWithEbayRetry, so they inherit the
// breaker + withRetry + Retry-After backoff instead of rolling a bare fetch that
// threw hard on the first 429/5xx. These tests exercise that shared helper with
// an injected doFetch + no-op sleep (no network, no breaker state).

import { assertEquals, assertRejects } from "@std/assert";

// ebay-client.ts -> supabase.ts throws at import without env. Dummy-env then
// dynamic-import (mirrors the other ebay-*_test.ts files).
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { fetchWithEbayRetry } = await import("../lib/ebay-client.ts");

function resp(status: number, body = "", headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

Deno.test("2xx is returned unchanged with no retry", async () => {
  let calls = 0;
  const res = await fetchWithEbayRetry(
    () => {
      calls++;
      return Promise.resolve(resp(200, "ok"));
    },
    { sleep: () => Promise.resolve() },
  );
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "ok");
  assertEquals(calls, 1);
});

Deno.test("a benign 404 is returned unchanged, NOT retried (disputes/finances stop-paginating path)", async () => {
  let calls = 0;
  const res = await fetchWithEbayRetry(
    () => {
      calls++;
      return Promise.resolve(resp(404, "not found"));
    },
    { sleep: () => Promise.resolve() },
  );
  assertEquals(res.status, 404);
  assertEquals(calls, 1); // 4xx (except 429) is not transient → the family branches on it
});

Deno.test("a business 4xx (409 already-decided) is returned unchanged for errorId branching", async () => {
  let calls = 0;
  const res = await fetchWithEbayRetry(
    () => {
      calls++;
      return Promise.resolve(resp(409, JSON.stringify({ errors: [{ errorId: 20400 }] })));
    },
    { sleep: () => Promise.resolve() },
  );
  assertEquals(res.status, 409);
  assertEquals(calls, 1);
});

Deno.test("429 with Retry-After BACKS OFF (honors the header) then succeeds — never throws on the first 429", async () => {
  let calls = 0;
  const slept: number[] = [];
  const res = await fetchWithEbayRetry(
    () => {
      calls++;
      // First attempt: rate-limited with an explicit 2-second Retry-After.
      return Promise.resolve(
        calls === 1 ? resp(429, "slow down", { "retry-after": "2" }) : resp(200, "ok"),
      );
    },
    { sleep: (ms) => (slept.push(ms), Promise.resolve()), maxAttempts: 3 },
  );
  assertEquals(res.status, 200);
  assertEquals(calls, 2);
  // Retry-After: 2 seconds -> 2000 ms, honored instead of jittered backoff.
  assertEquals(slept, [2000]);
});

Deno.test("persistent 5xx exhausts retries then throws a rich error carrying the status", async () => {
  let calls = 0;
  const err = await assertRejects(() =>
    fetchWithEbayRetry(
      () => {
        calls++;
        return Promise.resolve(resp(503, "temporarily unavailable"));
      },
      { sleep: () => Promise.resolve(), maxAttempts: 3 },
    )
  );
  assertEquals(calls, 3); // all attempts consumed
  assertEquals((err as Error & { status?: number }).status, 503);
});
