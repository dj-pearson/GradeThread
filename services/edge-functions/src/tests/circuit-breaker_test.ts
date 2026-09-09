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

Deno.test("fetchWithTimeout throws TimeoutError when the HEADERS never arrive", async () => {
  // This used to fetch http://10.255.255.1/ and rely on that address being
  // non-routable, which tests the machine's routing table rather than this
  // code. Anywhere an egress proxy answers on behalf of the target - a
  // corporate network, a sandboxed CI container - the request completes, the
  // call does not reject, and the case fails for a reason that has nothing to
  // do with timeouts. It also asserted only `Error`, because a network-shaped
  // rejection could arrive by several routes and the test could not tell which
  // it got; the comment said as much.
  //
  // US-2323 later added a real local server to this file for the stalled-BODY
  // case. Using it here makes the request-level deadline just as deterministic:
  // the connection is accepted and then nothing is sent, so the headers never
  // arrive and the deadline has to fire on the request itself. That also lets
  // the assertion name TimeoutError specifically, which is what callers branch
  // on to tell "the upstream is dead" from "the upstream said no".
  const stall = Promise.withResolvers<Response>();
  const s = serve(() => stall.promise);
  try {
    await assertRejects(() => fetchWithTimeout(s.origin, {}, 100), TimeoutError);
  } finally {
    // Let the handler finish so the server can actually shut down.
    stall.resolve(new Response("done"));
    await s.close();
  }
});

Deno.test("TimeoutError name is set", () => {
  const e = new TimeoutError("x");
  assertEquals(e.name, "TimeoutError");
});

// ── US-2323: the deadline must cover the BODY, not just the headers ─────────
//
// `fetch()` resolves as soon as headers arrive. The original implementation
// cleared its timer in a `finally` attached to that resolution, so every
// caller's `await res.text()` ran with no deadline at all — a partner that
// answered `200 OK` and then stalled the body hung forever, and did so while
// looking healthy: the breaker had already counted a success.
//
// These serve real responses over loopback rather than stubbing fetch, because
// the bug lived in the seam between the headers promise and the body stream,
// which a stub does not have.

/** Serve one response and hand back its origin + a shutdown. */
function serve(handler: () => Response | Promise<Response>) {
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: ac.signal, onListen: () => {} },
    handler,
  );
  const port = (server.addr as Deno.NetAddr).port;
  return {
    origin: `http://127.0.0.1:${port}/`,
    async close() {
      ac.abort();
      await server.finished;
    },
  };
}

Deno.test("US-2323: a stalled BODY is aborted, not awaited forever", async () => {
  const s = serve(() =>
    new Response(
      // Headers land immediately, one chunk arrives, then nothing — ever.
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("partial"));
        },
      }),
      { status: 200 },
    )
  );
  try {
    // Resolves quickly: the headers are already here. This is exactly why the
    // old code thought it was done.
    const res = await fetchWithTimeout(s.origin, {}, 300);
    assertEquals(res.status, 200);
    // The deadline is still running, so reading the body fails rather than hangs.
    await assertRejects(() => res.text(), TimeoutError);
  } finally {
    await s.close();
  }
});

Deno.test("US-2323: a normal body still reads, and clears the deadline", async () => {
  // Guards the guard. A fix that made every body read throw would satisfy the
  // test above and break every caller in production.
  const s = serve(() => new Response("hello", { status: 200 }));
  try {
    const res = await fetchWithTimeout(s.origin, {}, 5_000);
    assertEquals(await res.text(), "hello");
    // Deno's timer sanitizer fails this test if the deadline was left armed,
    // which is the other half of the contract: the timeout must not outlive
    // the request it was bounding.
  } finally {
    await s.close();
  }
});

Deno.test("US-2323: status, headers and url survive the body wrapper", async () => {
  // The body is re-streamed through a new Response, and `new Response()` drops
  // `url` — which callers read for redirect handling and error messages.
  const s = serve(() =>
    new Response("{}", {
      status: 418,
      statusText: "I'm a teapot",
      headers: { "content-type": "application/json", "x-probe": "kept" },
    })
  );
  try {
    const res = await fetchWithTimeout(s.origin, {}, 5_000);
    assertEquals(res.status, 418);
    assertEquals(res.headers.get("x-probe"), "kept");
    assert(res.url.startsWith("http://127.0.0.1:"), `url lost: ${res.url}`);
    await res.text();
  } finally {
    await s.close();
  }
});

Deno.test("US-2323: a bodyless response does not pin the deadline", async () => {
  // 204 has no body to stream, so there is nothing left to bound and the timer
  // must be released immediately rather than held for the full timeout.
  const s = serve(() => new Response(null, { status: 204 }));
  try {
    const res = await fetchWithTimeout(s.origin, {}, 5_000);
    assertEquals(res.status, 204);
    assertEquals(res.body, null);
  } finally {
    await s.close();
  }
});
