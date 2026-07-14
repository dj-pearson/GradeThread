// US-1966: every eBay API family (Finances, Marketing, Disputes, Post-Order)
// now routes through the shared ebayHardenedFetch primitive, so a 429/5xx backs
// off (breaker + retry + Retry-After) instead of throwing on the first attempt.
// These tests exercise that shared path directly; the four families are thin
// wrappers over it (each swapped its bare fetch for ebayHardenedFetch).
import { assert, assertEquals } from "@std/assert";
import { ebayHardenedFetch } from "../lib/ebay-client.ts";
import { _clearBreakers } from "../lib/circuit-breaker.ts";

const noSleepSpy = () => {
  const slept: number[] = [];
  return { slept, sleep: (ms: number) => (slept.push(ms), Promise.resolve()) };
};

function stubFetch(responses: Array<() => Response>) {
  const original = globalThis.fetch;
  let call = 0;
  const calls = { count: 0 };
  globalThis.fetch = ((_input: string | URL | Request, _init?: RequestInit) => {
    calls.count = ++call;
    const make = responses[Math.min(call - 1, responses.length - 1)];
    return Promise.resolve(make());
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

Deno.test("ebayHardenedFetch backs off on a 429 with Retry-After, then succeeds", async () => {
  _clearBreakers();
  const { slept, sleep } = noSleepSpy();
  const { calls, restore } = stubFetch([
    () => new Response('{"errors":[]}', {
      status: 429,
      headers: { "retry-after": "2" },
    }),
    () => new Response('{"ok":true}', { status: 200 }),
  ]);
  try {
    const res = await ebayHardenedFetch(
      "https://apiz.ebay.com/sell/finances/v1/transaction",
      { method: "GET" },
      20_000,
      { sleep },
    );
    assertEquals(res.status, 200); // did NOT throw — recovered on retry
    assertEquals(calls.count, 2); // retried exactly once
    assertEquals(slept, [2000]); // honored eBay's Retry-After (2s), not jitter
  } finally {
    restore();
  }
});

Deno.test("ebayHardenedFetch returns a non-retryable 4xx without retrying", async () => {
  _clearBreakers();
  const { slept, sleep } = noSleepSpy();
  const { calls, restore } = stubFetch([
    () => new Response('{"errors":[{"errorId":25709}]}', { status: 400 }),
  ]);
  try {
    const res = await ebayHardenedFetch("https://api.ebay.com/x", {}, 20_000, {
      sleep,
    });
    assertEquals(res.status, 400); // handed back for the caller to inspect
    assertEquals(calls.count, 1); // no retry on a client error
    assertEquals(slept.length, 0);
  } finally {
    restore();
  }
});

Deno.test("ebayHardenedFetch retries a persistent 5xx to the cap, then throws", async () => {
  _clearBreakers();
  const { sleep } = noSleepSpy();
  const { calls, restore } = stubFetch([
    () => new Response("upstream boom", { status: 503 }),
  ]);
  try {
    await ebayHardenedFetch("https://api.ebay.com/post-order/v2/return/search", {}, 20_000, {
      maxAttempts: 3,
      sleep,
    });
    throw new Error("expected ebayHardenedFetch to throw after exhausting retries");
  } catch (err) {
    assertEquals((err as { status?: number }).status, 503);
    assertEquals(calls.count, 3); // first attempt + 2 retries
  } finally {
    restore();
  }
});

Deno.test("ebayHardenedFetch falls back to jittered backoff when Retry-After is absent", async () => {
  _clearBreakers();
  const slept: number[] = [];
  const { calls, restore } = stubFetch([
    () => new Response("boom", { status: 502 }),
    () => new Response('{"ok":true}', { status: 200 }),
  ]);
  try {
    const res = await ebayHardenedFetch("https://api.ebay.com/sell/marketing/v1/ad_campaign", {
      method: "POST",
    }, 20_000, {
      sleep: (ms) => (slept.push(ms), Promise.resolve()),
      random: () => 0.5, // deterministic jitter
      baseDelayMs: 500,
    });
    assertEquals(res.status, 200);
    assertEquals(calls.count, 2);
    // No Retry-After header → jitter: floor(0.5 * min(8000, 500)) = 250ms.
    assertEquals(slept, [250]);
    assert(slept[0] > 0);
  } finally {
    restore();
  }
});
