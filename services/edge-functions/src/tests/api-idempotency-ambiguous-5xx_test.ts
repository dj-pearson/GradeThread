import "./_env.ts";
// A 5xx after POST /api/v1/grades reached the charge must NOT release the
// Idempotency-Key claim.
//
// The SDK retries a keyed grades.create / grades.batch on any 5xx. The
// middleware used to release the claim on every non-2xx, so a 5xx that came
// back AFTER the credit debit committed (the RPC ran, the response to it was
// lost) let that retry create a second submission and debit again: the double
// charge the key exists to stop. These tests drive the real middleware through
// a Hono app against a PostgREST stub and read which write it sent: DELETE is a
// release, PATCH to state=completed is a stored, replayable answer.
//
// Run: deno test --allow-env --allow-read src/tests/api-idempotency-ambiguous-5xx_test.ts

import { assert, assertEquals } from "@std/assert";
import { type Context, Hono } from "hono";
import {
  apiIdempotencyMiddleware,
  markChargeMayHaveHappened,
  settleNonSuccess,
} from "../middleware/api-idempotency.ts";

interface Sent {
  method: string;
  table: string;
  body: unknown;
}

let sent: Sent[] = [];

// The service-role client captures the global fetch when it is first built, so
// the stub goes in once, before any request, and each test resets the log.
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const table = url.pathname.replace(/^.*\/rest\/v1\//, "");
  let body: unknown = null;
  if (typeof init?.body === "string") {
    try {
      body = JSON.parse(init.body);
    } catch {
      body = init.body;
    }
  }
  sent.push({ method, table, body });
  // Every claim INSERT succeeds (first time this key is seen); every write
  // after it succeeds with no content.
  return Promise.resolve(new Response(null, { status: method === "POST" ? 201 : 204 }));
}) as typeof fetch;

function app(handler: (c: Context) => Response | Promise<Response>) {
  const a = new Hono<{ Variables: { userId: string; apiKeyId: string } }>();
  a.use("*", async (c, next) => {
    c.set("userId", "11111111-1111-4111-8111-111111111111");
    c.set("apiKeyId", "22222222-2222-4222-8222-222222222222");
    await next();
  });
  a.use("*", apiIdempotencyMiddleware);
  a.post("/api/v1/grades", (c) => handler(c));
  // Same shape as main.ts: an uncaught throw becomes a 500 response.
  a.onError((_err, c) => c.json({ error: "Internal server error" }, 500));
  return a;
}

async function post(a: ReturnType<typeof app>) {
  sent = [];
  const res = await a.request("/api/v1/grades", {
    method: "POST",
    headers: { "Idempotency-Key": "key-1", "Content-Type": "application/json" },
    body: JSON.stringify({ garment: 1 }),
  });
  await res.body?.cancel();
  return res;
}

const writes = () =>
  sent.filter((s) => s.table.startsWith("api_idempotency_records") && s.method !== "POST");

Deno.test("a 5xx BEFORE the charge releases the claim so the retry really runs", async () => {
  const res = await post(app((c) =>
    c.json({ error: { message: "Grading is temporarily unavailable" } }, 503)));
  assertEquals(res.status, 503);
  assertEquals(writes().map((w) => w.method), ["DELETE"]);
});

Deno.test("a 5xx AFTER the charge is stored, not released", async () => {
  const res = await post(app((c) => {
    markChargeMayHaveHappened(c);
    return c.json({ data: null, error: { message: "Payment processing error" }, meta: null }, 500);
  }));
  assertEquals(res.status, 500);
  const w = writes();
  assertEquals(
    w.map((x) => x.method),
    ["PATCH"],
    "releasing here lets the SDK's automatic retry create a second submission and debit again",
  );
  const stored = w[0].body as { state: string; response_status: number };
  assertEquals(stored.state, "completed");
  assertEquals(stored.response_status, 500);
});

Deno.test("an uncaught throw after the charge is stored too", async () => {
  const res = await post(app((c) => {
    markChargeMayHaveHappened(c);
    throw new Error("boom after debit");
  }));
  assertEquals(res.status, 500);
  assertEquals(writes().map((w) => w.method), ["PATCH"]);
});

Deno.test("a 4xx after the charge step still releases (402 means nothing was charged)", async () => {
  const res = await post(app((c) => {
    markChargeMayHaveHappened(c);
    return c.json({ error: { message: "Insufficient grading credits" } }, 402);
  }));
  assertEquals(res.status, 402);
  assertEquals(writes().map((w) => w.method), ["DELETE"]);
});

Deno.test("settleNonSuccess: only a 5xx after the charge is stored", () => {
  assertEquals(settleNonSuccess(500, true), "store");
  assertEquals(settleNonSuccess(503, true), "store");
  assertEquals(settleNonSuccess(500, false), "release");
  assertEquals(settleNonSuccess(402, true), "release");
  assertEquals(settleNonSuccess(409, false), "release");
});

Deno.test("api-v1 marks the charge before runPaymentPrecedence and before the batch jobs insert", async () => {
  const src = await Deno.readTextFile(new URL("../routes/api-v1.ts", import.meta.url));

  const single = src.slice(src.indexOf('apiV1Routes.post("/grades",'), src.indexOf('apiV1Routes.post("/grades/batch"'));
  const markAt = single.indexOf("markChargeMayHaveHappened(c)");
  const chargeAt = single.indexOf("await runPaymentPrecedence(");
  assert(markAt !== -1 && chargeAt !== -1, "POST /grades must mark the charge");
  assert(markAt < chargeAt, "POST /grades must mark BEFORE the charge, not after it");

  const batchStart = src.indexOf('apiV1Routes.post("/grades/batch"');
  const batch = src.slice(batchStart, src.indexOf("apiV1Routes.get(", batchStart));
  const bMark = batch.indexOf("markChargeMayHaveHappened(c)");
  const jobsAt = batch.indexOf('from("grading_batch_jobs").insert(');
  assert(bMark !== -1 && jobsAt !== -1, "POST /grades/batch must mark the charge");
  assert(bMark < jobsAt, "POST /grades/batch must mark BEFORE the job rows the worker charges exist");
});
