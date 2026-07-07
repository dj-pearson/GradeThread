// US-1709: retry-with-backoff for transient Ads-API errors.
import { assert, assertEquals } from "@std/assert";
import { isTransientAdsError, withBackoff } from "../lib/ads-retry.ts";

const noSleep = () => Promise.resolve();

Deno.test("isTransientAdsError flags 429/5xx/network, not 4xx", () => {
  assert(isTransientAdsError({ status: 429 }));
  assert(isTransientAdsError({ status: 503 }));
  assert(isTransientAdsError({ status: 0 }));
  assertEquals(isTransientAdsError({ status: 400 }), false);
  assertEquals(isTransientAdsError({ status: 401 }), false);
  assertEquals(isTransientAdsError(new Error("x")), false);
});

Deno.test("withBackoff retries a transient failure then succeeds", async () => {
  let n = 0;
  const result = await withBackoff(() => {
    n++;
    if (n < 3) return Promise.reject({ status: 503 });
    return Promise.resolve("ok");
  }, { sleep: noSleep });
  assertEquals(result, "ok");
  assertEquals(n, 3);
});

Deno.test("withBackoff fails fast on a non-transient error (no retry)", async () => {
  let n = 0;
  try {
    await withBackoff(() => {
      n++;
      return Promise.reject({ status: 400 });
    }, { sleep: noSleep });
    throw new Error("expected throw");
  } catch (e) {
    assertEquals((e as { status?: number }).status, 400);
    assertEquals(n, 1); // no retry
  }
});

Deno.test("withBackoff gives up after the attempt cap", async () => {
  let n = 0;
  try {
    await withBackoff(() => {
      n++;
      return Promise.reject({ status: 429 });
    }, { attempts: 2, sleep: noSleep });
    throw new Error("expected throw");
  } catch {
    assertEquals(n, 2);
  }
});
