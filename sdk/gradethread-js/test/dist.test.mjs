// Smoke test against the BUILT package, the files npm actually publishes.
// The full behaviour suite lives at the repo root (src/test/sdk-*.test.ts);
// this one proves dist/ loads under plain Node and answers correctly.

import { test } from "node:test";
import assert from "node:assert/strict";
import { GradeThread, GradeThreadError, verifyWebhook, DEFAULT_BASE_URL } from "../dist/index.js";

test("exports the client, the error type and the webhook verifier", () => {
  assert.equal(typeof GradeThread, "function");
  assert.equal(typeof GradeThreadError, "function");
  assert.equal(typeof verifyWebhook, "function");
  assert.equal(DEFAULT_BASE_URL, "https://functions.gradethread.com");
});

test("sends the API key and parses the envelope", async () => {
  const calls = [];
  const gt = new GradeThread({
    apiKey: "gt_sk_test",
    fetch: async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ data: { id: "g_1", status: "completed" }, error: null, meta: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });
  const grade = await gt.grades.get("g_1");
  assert.equal(grade.id, "g_1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.get("x-api-key"), "gt_sk_test");
  assert.ok(calls[0].url.startsWith(DEFAULT_BASE_URL));
});

// Same vector as src/test/sdk-verify-webhook.test.ts and the edge's
// webhook-delivery_test.ts.
test("verifies the edge's webhook signature and rejects a changed body", async () => {
  const secret = "whsec_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
  const body = '{"event":"grade.completed"}';
  const headers = {
    "webhook-id": "evt_1",
    "webhook-timestamp": "1700000000",
    "webhook-signature": "v1,5K9efckG8cZWT2a6/xWJ0/9hr1yB+EKy0awG4bfbZPs=",
  };
  assert.equal(await verifyWebhook(body, headers, secret, { nowSeconds: 1700000000 }), true);
  assert.equal(await verifyWebhook(body + " ", headers, secret, { nowSeconds: 1700000000 }), false);
});
