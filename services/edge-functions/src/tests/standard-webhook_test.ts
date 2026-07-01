// Unit tests for the Standard Webhooks verifier used by the GoTrue send-email
// auth hook (routes/auth-hooks.ts). Pure Web Crypto — no running service.
import { assert, assertEquals } from "@std/assert";
import {
  parseWebhookSecrets,
  readWebhookHeaders,
  verifyStandardWebhook,
} from "../lib/standard-webhook.ts";

// Produce a valid Standard Webhooks signature for a body, matching how GoTrue
// signs: base64(HMAC-SHA256(key, `${id}.${ts}.${body}`)).
async function signBody(
  keyBytes: Uint8Array,
  id: string,
  ts: string,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(keyBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${id}.${ts}.${body}`),
  );
  let bin = "";
  const bytes = new Uint8Array(sig);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

const RAW_KEY = "c2VjcmV0LWtleS0zMi1ieXRlcy1sb25nLWZvci10ZXN0"; // base64 "key"

Deno.test("parseWebhookSecrets strips v1, and whsec_ prefixes", () => {
  const a = parseWebhookSecrets(`v1,whsec_${RAW_KEY}`);
  const b = parseWebhookSecrets(`whsec_${RAW_KEY}`);
  const c = parseWebhookSecrets(RAW_KEY);
  assertEquals(a.length, 1);
  // All three forms decode to the SAME key bytes.
  assertEquals([...a[0]!], [...b[0]!]);
  assertEquals([...a[0]!], [...c[0]!]);
});

Deno.test("parseWebhookSecrets supports pipe-separated rotation + empty", () => {
  assertEquals(parseWebhookSecrets(`v1,whsec_${RAW_KEY}|v1,whsec_${RAW_KEY}`).length, 2);
  assertEquals(parseWebhookSecrets("").length, 0);
  assertEquals(parseWebhookSecrets(undefined).length, 0);
});

Deno.test("verifyStandardWebhook accepts a valid signature", async () => {
  const secrets = parseWebhookSecrets(`v1,whsec_${RAW_KEY}`);
  const id = "msg_1";
  const ts = "1700000000";
  const body = JSON.stringify({ email_data: { email_action_type: "signup" } });
  const sig = await signBody(secrets[0]!, id, ts, body);
  const ok = await verifyStandardWebhook({
    body,
    headers: { id, timestamp: ts, signature: `v1,${sig}` },
    secrets,
    nowSec: 1700000000,
  });
  assert(ok);
});

Deno.test("verifyStandardWebhook rejects a tampered body", async () => {
  const secrets = parseWebhookSecrets(`v1,whsec_${RAW_KEY}`);
  const id = "msg_1";
  const ts = "1700000000";
  const sig = await signBody(secrets[0]!, id, ts, "original");
  const ok = await verifyStandardWebhook({
    body: "tampered",
    headers: { id, timestamp: ts, signature: `v1,${sig}` },
    secrets,
    nowSec: 1700000000,
  });
  assertEquals(ok, false);
});

Deno.test("verifyStandardWebhook rejects a stale timestamp (replay)", async () => {
  const secrets = parseWebhookSecrets(`v1,whsec_${RAW_KEY}`);
  const id = "msg_1";
  const ts = "1700000000";
  const body = "x";
  const sig = await signBody(secrets[0]!, id, ts, body);
  const ok = await verifyStandardWebhook({
    body,
    headers: { id, timestamp: ts, signature: `v1,${sig}` },
    secrets,
    nowSec: 1700000000 + 3600, // an hour later, well past the 5-min tolerance
  });
  assertEquals(ok, false);
});

Deno.test("verifyStandardWebhook rejects when no secrets / headers missing", async () => {
  assertEquals(
    await verifyStandardWebhook({
      body: "x",
      headers: { id: "a", timestamp: "1700000000", signature: "v1,zzz" },
      secrets: [],
    }),
    false,
  );
  assertEquals(
    await verifyStandardWebhook({
      body: "x",
      headers: { id: null, timestamp: null, signature: null },
      secrets: parseWebhookSecrets(`v1,whsec_${RAW_KEY}`),
    }),
    false,
  );
});

Deno.test("verifyStandardWebhook verifies against a rotated secret list", async () => {
  const secrets = parseWebhookSecrets(`v1,whsec_${RAW_KEY}|v1,whsec_b3RoZXI`);
  const id = "msg_2";
  const ts = "1700000000";
  const body = "rotate";
  // Sign with the SECOND (new) key — verification must still pass.
  const sig = await signBody(secrets[1]!, id, ts, body);
  const ok = await verifyStandardWebhook({
    body,
    headers: { id, timestamp: ts, signature: `v1,${sig}` },
    secrets,
    nowSec: 1700000000,
  });
  assert(ok);
});

Deno.test("readWebhookHeaders reads webhook-* and svix-* aliases", () => {
  const h1 = readWebhookHeaders(
    new Headers({
      "webhook-id": "a",
      "webhook-timestamp": "1",
      "webhook-signature": "v1,x",
    }),
  );
  assertEquals(h1, { id: "a", timestamp: "1", signature: "v1,x" });
  const h2 = readWebhookHeaders(
    new Headers({ "svix-id": "b", "svix-timestamp": "2", "svix-signature": "v1,y" }),
  );
  assertEquals(h2, { id: "b", timestamp: "2", signature: "v1,y" });
});
