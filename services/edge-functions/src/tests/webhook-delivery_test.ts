// Customer webhooks (extensions-api plan, actions 2 and 3; migration 00832).
//
// Two families of guarantee, both of which were broken before this file existed
// and neither of which any test covered:
//
//   SIGNING  - the secret is a whsec_ value the customer holds, the signature
//              covers id + timestamp + body (Standard Webhooks), and a key_hash
//              can never be the signing secret again.
//   DELIVERY - one event per grade per account however many API keys exist,
//              retries live in rows so a restart resumes them, attempts are
//              capped and logged, and a claim cannot be taken twice.
//
// The delivery loop runs against an in-memory store that implements the same
// compare-and-set semantics as the real PostgREST calls in webhook-delivery.ts.
// The database half of "once per grade" (the UNIQUE index) was proved against
// Postgres when 00832 was written; see PENDING_MIGRATIONS.md.
//
// Pure: no network, no DB.

import "./_env.ts";
import { assert, assertEquals, assertNotEquals, assertRejects } from "@std/assert";
import {
  attemptDelivery,
  buildSignedRequest,
  type DeliveryRow,
  type EndpointRow,
  generateWebhookSecret,
  legacyBodySignature,
  notifyWebhooks,
  RETRY_BACKOFF_MS,
  RUNNING_STALE_MS,
  type AttemptLog,
  type SendResult,
  type SignedRequest,
  signWebhook,
  sweepWebhookDeliveries,
  type WebhookDeps,
  type WebhookStore,
} from "../lib/webhook-delivery.ts";
import { parseWebhookSecrets, verifyStandardWebhook } from "../lib/standard-webhook.ts";
import { FAILURE_KEYS } from "../lib/cron-run-outcome.ts";

// ── Signing ─────────────────────────────────────────────────────────

// Pinned with an independent implementation (Python hmac/hashlib), so this
// fails if the signed content, the key decoding or the encoding drifts.
const VECTOR_SECRET = "whsec_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const VECTOR_BODY = '{"event":"grade.completed"}';
const VECTOR_SIG = "v1,5K9efckG8cZWT2a6/xWJ0/9hr1yB+EKy0awG4bfbZPs=";

Deno.test("signature is Standard Webhooks over id.timestamp.body (pinned vector)", async () => {
  assertEquals(await signWebhook(VECTOR_SECRET, "evt_1", 1700000000, VECTOR_BODY), VECTOR_SIG);
});

Deno.test("an off-the-shelf Standard Webhooks verifier accepts a delivery", async () => {
  const secret = generateWebhookSecret();
  const req = await buildSignedRequest({
    eventId: "evt_abc",
    payload: { id: "evt_abc", event: "grade.completed", data: { x: 1 } },
    secret,
    legacyKeyHash: "should-not-be-used",
    nowSec: 1700000000,
  });
  const headers = new Headers(req.headers);
  const ok = await verifyStandardWebhook({
    body: req.body,
    headers: {
      id: headers.get("webhook-id"),
      timestamp: headers.get("webhook-timestamp"),
      signature: headers.get("webhook-signature"),
    },
    secrets: parseWebhookSecrets(secret),
    nowSec: 1700000000,
  });
  assert(ok, "the receiver-side verifier rejected our own signature");
  // A secret exists, so the legacy key_hash header must NOT be sent.
  assertEquals(headers.get("X-GradeThread-Signature"), null);
});

Deno.test("the timestamp is signed: moving it breaks the signature", async () => {
  const secret = generateWebhookSecret();
  const req = await buildSignedRequest({
    eventId: "evt_abc",
    payload: { a: 1 },
    secret,
    legacyKeyHash: null,
    nowSec: 1700000000,
  });
  const ok = await verifyStandardWebhook({
    body: req.body,
    headers: {
      id: "evt_abc",
      timestamp: "1700000100", // replayed with a fresh timestamp
      signature: req.headers["webhook-signature"]!,
    },
    secrets: parseWebhookSecrets(secret),
    nowSec: 1700000100,
  });
  assertEquals(ok, false);
});

Deno.test("a key_hash can never be the signing secret again", async () => {
  // The shape api_keys.key_hash has in prod: 64 hex chars, HMAC(pepper, key).
  const keyHash = "a".repeat(64);
  await assertRejects(
    () => signWebhook(keyHash, "evt", 1, "{}"),
    Error,
    "whsec_",
  );
  // And the signature a whsec_ secret produces is not the one key_hash would.
  const secret = generateWebhookSecret();
  const req = await buildSignedRequest({
    eventId: "evt",
    payload: {},
    secret,
    legacyKeyHash: keyHash,
    nowSec: 1,
  });
  assertNotEquals(req.headers["webhook-signature"], await legacyBodySignature(keyHash, req.body));
  assertEquals(req.headers["X-GradeThread-Signature"], undefined);
});

Deno.test("generated secrets are whsec_ + 32 random bytes and never repeat", () => {
  const a = generateWebhookSecret();
  const b = generateWebhookSecret();
  assert(a.startsWith("whsec_"));
  assertEquals(atob(a.slice(6)).length, 32);
  assertNotEquals(a, b);
});

// ── Delivery: in-memory store with the real compare-and-set rules ───

interface MemRow extends DeliveryRow {
  updated_at: number;
  last_status_code?: number | null;
  last_error?: string | null;
  delivered_at?: string | null;
}

class MemStore implements WebhookStore {
  rows: MemRow[] = [];
  endpoints = new Map<string, EndpointRow>();
  keyHashes = new Map<string, string>();
  attempts: AttemptLog[] = [];
  constructor(public clock: { now: number }) {}

  insertDelivery(row: Parameters<WebhookStore["insertDelivery"]>[0]) {
    const dup = this.rows.find((r) =>
      r.user_id === row.user_id && r.event_type === row.event_type && r.subject_id === row.subject_id
    );
    if (dup) return Promise.resolve(null);
    const r: MemRow = {
      id: crypto.randomUUID(),
      ...row,
      status: "pending",
      attempts: 0,
      max_attempts: 6,
      next_attempt_at: new Date(this.clock.now).toISOString(),
      updated_at: this.clock.now,
    };
    this.rows.push(r);
    return Promise.resolve({ ...r });
  }
  loadEndpoint(userId: string) {
    return Promise.resolve(this.endpoints.get(userId) ?? null);
  }
  claim(row: DeliveryRow) {
    const r = this.rows.find((x) =>
      x.id === row.id && x.user_id === row.user_id && x.status === "pending" && x.attempts === row.attempts
    );
    if (!r) return Promise.resolve(null);
    r.status = "running";
    r.attempts += 1;
    r.updated_at = this.clock.now;
    return Promise.resolve({ ...r });
  }
  closeExhausted(row: DeliveryRow) {
    const r = this.rows.find((x) =>
      x.id === row.id && x.status === "pending" && x.attempts === row.attempts
    );
    if (!r) return Promise.resolve(false);
    r.status = "failed";
    return Promise.resolve(true);
  }
  legacyKeyHash(userId: string) {
    return Promise.resolve(this.keyHashes.get(userId) ?? null);
  }
  recordAttempt(log: AttemptLog) {
    this.attempts.push(log);
    return Promise.resolve();
  }
  finish(row: DeliveryRow, values: Record<string, unknown>) {
    const r = this.rows.find((x) => x.id === row.id && x.user_id === row.user_id && x.status === "running");
    if (r) Object.assign(r, values, { updated_at: this.clock.now });
    return Promise.resolve();
  }
  listDue(nowIso: string, limit: number) {
    const now = Date.parse(nowIso);
    return Promise.resolve(
      this.rows
        .filter((r) => r.status === "pending" && Date.parse(r.next_attempt_at) <= now)
        .slice(0, limit)
        .map((r) => ({ ...r })),
    );
  }
  reclaimStale(staleBeforeIso: string, nowIso: string) {
    const stale = Date.parse(staleBeforeIso);
    let n = 0;
    for (const r of this.rows) {
      if (r.status === "running" && r.updated_at < stale) {
        r.status = "pending";
        r.next_attempt_at = nowIso;
        n++;
      }
    }
    return Promise.resolve(n);
  }
}

const OWNER = "11111111-1111-1111-1111-111111111111";
const SECRET = generateWebhookSecret();

function harness(responses: number[] = []) {
  const clock = { now: Date.parse("2026-09-23T12:00:00Z") };
  const store = new MemStore(clock);
  const sent: Array<{ url: string; req: SignedRequest }> = [];
  const queue = [...responses];
  const deps: WebhookDeps = {
    store,
    send: (url, req): Promise<SendResult> => {
      sent.push({ url, req });
      const status = queue.length ? queue.shift()! : 200;
      return Promise.resolve({
        success: status >= 200 && status < 300,
        statusCode: status,
        responseBody: status >= 300 ? "nope" : "ok",
      });
    },
    // The fake "ciphertext" IS the secret; decryption is crypto-aes.ts's job.
    decryptSecret: (c) => Promise.resolve(c),
    now: () => new Date(clock.now),
  };
  store.endpoints.set(OWNER, { url: "https://hooks.example.com/gt", secret_ciphertext: SECRET });
  return { clock, store, sent, deps };
}

Deno.test("one delivery per grade per account, however many keys and re-runs", async () => {
  const { store, sent, deps } = harness();
  // Three API keys used to mean three POSTs, each signed differently.
  store.keyHashes.set(OWNER, "k".repeat(64));
  await notifyWebhooks(OWNER, "sub-1", { overall_score: 8.5 }, deps);
  await notifyWebhooks(OWNER, "sub-1", { overall_score: 8.5 }, deps); // pipeline re-run
  assertEquals(store.rows.length, 1);
  assertEquals(sent.length, 1);
  assertEquals(store.rows[0]!.status, "delivered");
  // A different grade is a different event.
  await notifyWebhooks(OWNER, "sub-2", { overall_score: 7 }, deps);
  assertEquals(sent.length, 2);
});

Deno.test("no endpoint configured: nothing is recorded or sent", async () => {
  const { store, sent, deps } = harness();
  await notifyWebhooks("22222222-2222-2222-2222-222222222222", "sub-1", {}, deps);
  assertEquals(store.rows.length, 0);
  assertEquals(sent.length, 0);
});

Deno.test("the body carries the event id and is identical on every retry", async () => {
  const { clock, store, sent, deps } = harness([500]);
  await notifyWebhooks(OWNER, "sub-1", { overall_score: 8.5 }, deps);
  clock.now += RETRY_BACKOFF_MS[0]!;
  await sweepWebhookDeliveries(deps);
  assertEquals(sent.length, 2);
  assertEquals(sent[0]!.req.body, sent[1]!.req.body);
  assertEquals(sent[0]!.req.headers["webhook-id"], sent[1]!.req.headers["webhook-id"]);
  const body = JSON.parse(sent[0]!.req.body);
  assertEquals(body.id, store.rows[0]!.event_id);
  assertEquals(body.event, "grade.completed");
  assertEquals(body.data.submission_id, "sub-1");
});

Deno.test("a failed attempt is a row with a due time, and a fresh process resumes it", async () => {
  const first = harness([503]);
  await notifyWebhooks(OWNER, "sub-1", {}, first.deps);
  const row = first.store.rows[0]!;
  assertEquals(row.status, "pending");
  assertEquals(row.attempts, 1);
  assertEquals(row.last_status_code, 503);
  assertEquals(
    Date.parse(row.next_attempt_at),
    first.clock.now + RETRY_BACKOFF_MS[0]!,
  );
  assertEquals(first.store.attempts.length, 1);
  assertEquals(first.store.attempts[0]!.success, false);

  // "Restart": nothing survives but the store. New send function, new deps.
  const sentAfter: SignedRequest[] = [];
  const restarted: WebhookDeps = {
    ...first.deps,
    send: (_url, req) => {
      sentAfter.push(req);
      return Promise.resolve({ success: true, statusCode: 204, responseBody: "" });
    },
  };
  // Not due yet: the sweep leaves it alone.
  await sweepWebhookDeliveries(restarted);
  assertEquals(sentAfter.length, 0);

  first.clock.now += RETRY_BACKOFF_MS[0]!;
  const result = await sweepWebhookDeliveries(restarted);
  assertEquals(result.delivered, 1);
  assertEquals(sentAfter.length, 1);
  assertEquals(row.status, "delivered");
  assertEquals(row.attempts, 2);
  assertEquals(first.store.attempts.map((a) => a.attempt), [1, 2]);
});

Deno.test("a row a dead worker left running is reclaimed, but not while it is live", async () => {
  const { clock, store, sent, deps } = harness();
  store.rows.push({
    id: "d1",
    user_id: OWNER,
    event_id: "e1",
    event_type: "grade.completed",
    subject_id: "sub-9",
    payload: { id: "e1" },
    status: "running",
    attempts: 1,
    max_attempts: 6,
    next_attempt_at: new Date(clock.now).toISOString(),
    updated_at: clock.now,
  });
  let result = await sweepWebhookDeliveries(deps);
  assertEquals(result.reclaimed, 0);
  assertEquals(sent.length, 0);

  clock.now += RUNNING_STALE_MS + 1;
  result = await sweepWebhookDeliveries(deps);
  assertEquals(result.reclaimed, 1);
  assertEquals(result.delivered, 1);
  assertEquals(store.rows[0]!.attempts, 2);
});

Deno.test("attempts are capped and the last failure is terminal", async () => {
  const { clock, store, sent, deps } = harness([500, 500, 500]);
  await notifyWebhooks(OWNER, "sub-1", {}, deps);
  store.rows[0]!.max_attempts = 2;
  clock.now += RETRY_BACKOFF_MS[0]!;
  await sweepWebhookDeliveries(deps);
  assertEquals(store.rows[0]!.status, "failed");
  assertEquals(sent.length, 2);
  clock.now += 24 * 3_600_000;
  const result = await sweepWebhookDeliveries(deps);
  assertEquals(result.scanned, 0);
  assertEquals(sent.length, 2);
});

Deno.test("a reclaimed row with no attempts left is closed without sending", async () => {
  const { clock, store, sent, deps } = harness();
  store.rows.push({
    id: "d2",
    user_id: OWNER,
    event_id: "e2",
    event_type: "grade.completed",
    subject_id: "sub-8",
    payload: {},
    status: "pending",
    attempts: 6,
    max_attempts: 6,
    next_attempt_at: new Date(clock.now).toISOString(),
    updated_at: clock.now,
  });
  const result = await sweepWebhookDeliveries(deps);
  assertEquals(result.exhausted, 1);
  assertEquals(sent.length, 0);
  assertEquals(store.rows[0]!.status, "failed");
});

Deno.test("two workers racing for one row send it once", async () => {
  const { store, sent, deps } = harness();
  store.rows.push({
    id: "d3",
    user_id: OWNER,
    event_id: "e3",
    event_type: "grade.completed",
    subject_id: "sub-7",
    payload: {},
    status: "pending",
    attempts: 0,
    max_attempts: 6,
    next_attempt_at: new Date(0).toISOString(),
    updated_at: 0,
  });
  const snapshot = { ...store.rows[0]! };
  const outcomes = await Promise.all([
    attemptDelivery({ ...snapshot }, deps),
    attemptDelivery({ ...snapshot }, deps),
  ]);
  assertEquals(sent.length, 1);
  assertEquals(outcomes.sort(), ["delivered", "skipped"]);
});

Deno.test("an endpoint removed after the event was recorded cancels it", async () => {
  const { store, sent, deps } = harness([500]);
  await notifyWebhooks(OWNER, "sub-1", {}, deps);
  store.endpoints.delete(OWNER);
  store.rows[0]!.next_attempt_at = new Date(0).toISOString();
  const result = await sweepWebhookDeliveries(deps);
  assertEquals(result.cancelled, 1);
  assertEquals(sent.length, 1);
  assertEquals(store.rows[0]!.status, "cancelled");
});

Deno.test("a legacy endpoint (no whsec_ yet) keeps only the old signature", async () => {
  const { store, sent, deps } = harness();
  const keyHash = "b".repeat(64);
  store.endpoints.set(OWNER, { url: "https://hooks.example.com/old", secret_ciphertext: null });
  store.keyHashes.set(OWNER, keyHash);
  await notifyWebhooks(OWNER, "sub-1", {}, deps);
  const req = sent[0]!.req;
  assertEquals(req.headers["webhook-signature"], undefined);
  assertEquals(req.headers["X-GradeThread-Signature"], await legacyBodySignature(keyHash, req.body));
  assert(req.headers["webhook-id"]);
  assert(req.headers["webhook-timestamp"]);
});

Deno.test("rotating the secret signs the next retry of an older event with the new one", async () => {
  const { clock, store, sent, deps } = harness([500]);
  await notifyWebhooks(OWNER, "sub-1", {}, deps);
  const rotated = generateWebhookSecret();
  store.endpoints.set(OWNER, { url: "https://hooks.example.com/gt", secret_ciphertext: rotated });
  clock.now += RETRY_BACKOFF_MS[0]!;
  await sweepWebhookDeliveries(deps);
  const req = sent[1]!.req;
  const ok = await verifyStandardWebhook({
    body: req.body,
    headers: {
      id: req.headers["webhook-id"]!,
      timestamp: req.headers["webhook-timestamp"]!,
      signature: req.headers["webhook-signature"]!,
    },
    secrets: parseWebhookSecrets(rotated),
    nowSec: Math.floor(clock.now / 1000),
  });
  assert(ok);
});

Deno.test("the sweep never reports a customer's dead endpoint as this job failing", async () => {
  const { deps } = harness();
  const result = await sweepWebhookDeliveries(deps);
  for (const key of FAILURE_KEYS) {
    assert(
      !(key in result),
      `sweep result carries "${key}", which the cron ledger reads as a failed run`,
    );
  }
});

// ── Route source guards ─────────────────────────────────────────────

const API_V1 = await Deno.readTextFile(new URL("../routes/api-v1.ts", import.meta.url));

Deno.test("every webhook table access in api-v1.ts is scoped by the key owner", () => {
  const pattern = /\.from\("(api_webhook_endpoints|webhook_deliveries)"\)([\s\S]*?);/g;
  let n = 0;
  for (const m of API_V1.matchAll(pattern)) {
    n++;
    const chain = m[2]!;
    assert(
      /\.eq\("user_id", userId\)/.test(chain) || /user_id: userId/.test(chain),
      `unscoped ${m[1]} access in api-v1.ts: ${chain.slice(0, 120)}`,
    );
  }
  assert(n >= 6, `expected the webhook routes' table accesses, found ${n}`);
});

Deno.test("the webhook routes never touch key_hash", () => {
  const webhookSection = API_V1.slice(API_V1.indexOf('apiV1Routes.patch("/webhook"'));
  assert(!/key_hash/.test(webhookSection), "a webhook route mentions key_hash");
});
