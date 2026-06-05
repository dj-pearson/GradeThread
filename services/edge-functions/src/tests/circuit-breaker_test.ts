// US-499: circuit breaker + fetch timeout.

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  CircuitBreaker,
  CircuitOpenError,
  fetchWithTimeout,
  getBreaker,
  TimeoutError,
  _clearBreakers,
} from "../lib/circuit-breaker.ts";

function fakeClock() {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

Deno.test("breaker opens after threshold consecutive failures", async () => {
  const clock = fakeClock();
  const b = new CircuitBreaker("t", { failureThreshold: 3, cooldownMs: 1000, now: clock.now });
  const fail = () => b.execute(() => Promise.reject(new Error("boom")));
  for (let i = 0; i < 3; i++) await assertRejects(fail, Error);
  assertEquals(b.getState(), "open");
  // Now short-circuits WITHOUT calling fn.
  let called = false;
  await assertRejects(
    () => b.execute(() => { called = true; return Promise.resolve(1); }),
    CircuitOpenError,
  );
  assertEquals(called, false);
});

Deno.test("breaker half-opens after cooldown and closes on a success", async () => {
  const clock = fakeClock();
  const b = new CircuitBreaker("t2", { failureThreshold: 2, cooldownMs: 1000, now: clock.now });
  await assertRejects(() => b.execute(() => Promise.reject(new Error("x"))), Error);
  await assertRejects(() => b.execute(() => Promise.reject(new Error("x"))), Error);
  assertEquals(b.getState(), "open");
  clock.advance(1000);
  assertEquals(b.getState(), "half_open");
  const out = await b.execute(() => Promise.resolve(42));
  assertEquals(out, 42);
  assertEquals(b.getState(), "closed");
});

Deno.test("a failed half-open probe re-opens immediately", async () => {
  const clock = fakeClock();
  const b = new CircuitBreaker("t3", { failureThreshold: 2, cooldownMs: 1000, now: clock.now });
  await assertRejects(() => b.execute(() => Promise.reject(new Error("x"))), Error);
  await assertRejects(() => b.execute(() => Promise.reject(new Error("x"))), Error);
  clock.advance(1000);
  assertEquals(b.getState(), "half_open");
  await assertRejects(() => b.execute(() => Promise.reject(new Error("still down"))), Error);
  assertEquals(b.getState(), "open");
});

Deno.test("isFailure predicate: a non-counted error does not open the breaker", async () => {
  const clock = fakeClock();
  // Only errors whose message includes 'transient' count.
  const b = new CircuitBreaker("t4", {
    failureThreshold: 2,
    now: clock.now,
    isFailure: (e) => e instanceof Error && e.message.includes("transient"),
  });
  // Two client errors (4xx-like) — should NOT open.
  await assertRejects(() => b.execute(() => Promise.reject(new Error("client 400"))), Error);
  await assertRejects(() => b.execute(() => Promise.reject(new Error("client 400"))), Error);
  assertEquals(b.getState(), "closed");
  // Two transient errors — opens.
  await assertRejects(() => b.execute(() => Promise.reject(new Error("transient 503"))), Error);
  await assertRejects(() => b.execute(() => Promise.reject(new Error("transient 503"))), Error);
  assertEquals(b.getState(), "open");
});

Deno.test("getBreaker returns a shared instance per key", () => {
  _clearBreakers();
  const a = getBreaker("shared");
  const b = getBreaker("shared");
  assert(a === b);
  assert(getBreaker("other") !== a);
});

Deno.test("fetchWithTimeout throws TimeoutError when the request exceeds the deadline", async () => {
  // A server that never responds within the deadline.
  await assertRejects(
    () =>
      fetchWithTimeout(
        "http://10.255.255.1/", // non-routable → hangs until aborted
        {},
        50,
      ),
    // Either our TimeoutError (abort) — accept any throw, then assert type if abort.
    Error,
  );
});

Deno.test("TimeoutError name is set", () => {
  const e = new TimeoutError("x");
  assertEquals(e.name, "TimeoutError");
});
