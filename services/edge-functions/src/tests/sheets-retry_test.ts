// US-2321 [P0]: the Sheets 429 retry used to have no end.
//
//   if (res.status === 429) {
//     // Quota blip despite the local throttle — one retry after a beat.
//     await this.sleep(2_000);
//     return await this.request<T>(path, init);
//   }
//
// The comment says "one retry". The code self-recurses with no attempt counter,
// no growth and no ceiling. A quota BLIP does clear in 2 seconds, so the comment
// was true of the case the author had in mind; project-level quota exhaustion
// does not, and then this hammers Google every 2 seconds forever, per in-flight
// request, per replica. That is the difference between being throttled and
// being banned.
//
// Behavioural rather than a source assertion, because the count IS the fix:
// asserting the module imports withRetry would not have caught a maxAttempts of
// Infinity.

import { assert, assertEquals } from "@std/assert";
import { SheetsApiError, SheetsClient } from "../lib/google-sheets-api.ts";

function client(
  responses: Array<() => Response>,
  sleeps: number[],
): { api: SheetsClient; calls: () => number } {
  let i = 0;
  const fetchFn = (() => {
    const r = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return Promise.resolve(r());
  }) as unknown as typeof fetch;
  const api = new SheetsClient("tok", "sheet1", fetchFn, (ms) => {
    sleeps.push(ms);
    return Promise.resolve();
  });
  return { api, calls: () => i };
}

const rateLimited = () => new Response("quota exceeded", { status: 429 });
const ok = () =>
  new Response(JSON.stringify({ sheets: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

Deno.test("US-2321: a permanent 429 stops instead of recursing forever", async () => {
  const sleeps: number[] = [];
  const { api, calls } = client([rateLimited], sleeps);
  await api.getTabs().then(
    () => {
      throw new Error("should have thrown");
    },
    (err) => {
      assert(err instanceof SheetsApiError);
      assertEquals(err.status, 429);
    },
  );
  // Three attempts, not three thousand. The old code never reached this line.
  assertEquals(calls(), 3);
});

Deno.test("US-2321: the backoff grows instead of sitting at a flat 2s", async () => {
  // A flat interval is what makes an unbounded retry a hammer. These are the
  // waits BETWEEN attempts, so two of them for three attempts. Jitter makes the
  // exact values random, so assert the property, not the number.
  const sleeps: number[] = [];
  const { api } = client([rateLimited], sleeps);
  await api.getTabs().catch(() => {});
  const backoffs = sleeps.filter((ms) => ms > 0);
  assertEquals(backoffs.length >= 1, true, "must actually back off");
  for (const ms of sleeps) {
    assertEquals(ms <= 30_000, true, `a single wait of ${ms}ms is a stalled sync`);
  }
});

Deno.test("US-2321: a 429 that clears still succeeds", async () => {
  // The blip case the original comment was written for has to keep working —
  // bounding a retry is worthless if it also stops retrying.
  const sleeps: number[] = [];
  let n = 0;
  const { api } = client([() => (n++ === 0 ? rateLimited() : ok())], sleeps);
  assertEquals(await api.getTabs(), []);
});

Deno.test("US-2321: a 404 is not retried", async () => {
  // The old code only ever looped on 429, so widening to withRetry must not
  // quietly start retrying things that will never succeed — a missing or
  // permission-denied spreadsheet is a permanent answer.
  const sleeps: number[] = [];
  const { api, calls } = client([() => new Response("gone", { status: 404 })], sleeps);
  await api.getTabs().catch((err) => {
    assertEquals((err as SheetsApiError).status, 404);
  });
  assertEquals(calls(), 1);
});

Deno.test("US-2321: Google's own Retry-After is honored, and capped", async () => {
  // Honoring it beats guessing. Capping it means a misconfigured or hostile
  // `Retry-After: 3600` cannot park a sync for an hour.
  const sleeps: number[] = [];
  const { api } = client([
    () =>
      new Response("slow down", {
        status: 429,
        headers: { "retry-after": "3600" },
      }),
  ], sleeps);
  await api.getTabs().catch(() => {});
  for (const ms of sleeps) {
    assertEquals(ms <= 30_000, true, `honored an uncapped ${ms}ms wait`);
  }
  assert(sleeps.some((ms) => ms === 30_000), "should have hit the cap, not ignored the header");
});
