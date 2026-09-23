// The SDK's verifyWebhook has to accept exactly what the edge signs.
//
// The vector below is the one pinned in
// services/edge-functions/src/tests/webhook-delivery_test.ts, where it was
// computed with an independent implementation (Python hmac). If either side
// changes its signed content, key decoding or encoding, one of the two files
// goes red.

import { describe, expect, it } from "vitest";
import { verifyWebhook } from "../../sdk/gradethread-js/src/index";

const SECRET = "whsec_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const BODY = '{"event":"grade.completed"}';
const SIG = "v1,5K9efckG8cZWT2a6/xWJ0/9hr1yB+EKy0awG4bfbZPs=";
const TS = 1700000000;

const headers = (over: Record<string, string> = {}) => ({
  "webhook-id": "evt_1",
  "webhook-timestamp": String(TS),
  "webhook-signature": SIG,
  ...over,
});

describe("verifyWebhook", () => {
  it("accepts the edge's signature, from a plain object or a Headers", async () => {
    expect(await verifyWebhook(BODY, headers(), SECRET, { nowSeconds: TS })).toBe(true);
    expect(await verifyWebhook(BODY, new Headers(headers()), SECRET, { nowSeconds: TS })).toBe(true);
  });

  it("accepts it among several space-separated signatures (rotation)", async () => {
    const h = headers({ "webhook-signature": `v1,AAAA ${SIG}` });
    expect(await verifyWebhook(BODY, h, SECRET, { nowSeconds: TS })).toBe(true);
  });

  it("rejects a changed body, id or timestamp", async () => {
    expect(await verifyWebhook(BODY + " ", headers(), SECRET, { nowSeconds: TS })).toBe(false);
    expect(await verifyWebhook(BODY, headers({ "webhook-id": "evt_2" }), SECRET, { nowSeconds: TS })).toBe(false);
    expect(
      await verifyWebhook(BODY, headers({ "webhook-timestamp": String(TS + 1) }), SECRET, { nowSeconds: TS }),
    ).toBe(false);
  });

  it("rejects a delivery outside the tolerance window (replay)", async () => {
    expect(await verifyWebhook(BODY, headers(), SECRET, { nowSeconds: TS + 301 })).toBe(false);
    expect(await verifyWebhook(BODY, headers(), SECRET, { nowSeconds: TS + 299 })).toBe(true);
  });

  it("rejects a secret that is not whsec_, such as an API key hash", async () => {
    expect(await verifyWebhook(BODY, headers(), "a".repeat(64), { nowSeconds: TS })).toBe(false);
  });
});
