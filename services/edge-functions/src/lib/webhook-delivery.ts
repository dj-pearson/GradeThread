// Customer webhooks (extensions-api plan, actions 2 and 3; migration 00830).
//
// THREE THINGS CHANGED FROM THE ORIGINAL, AND EACH WAS A CUSTOMER-VISIBLE DEFECT.
//
// 1. THE SECRET. Deliveries used to be signed with api_keys.key_hash. In prod
//    that is HMAC(API_KEY_PEPPER, key), which no customer can compute and no
//    endpoint returns, so no delivery was ever verifiable. The secret is now an
//    account-level `whsec_` value, stored as an AES-GCM envelope bound to the
//    owner (crypto-aes.ts, AAD = user_id), shown ONCE when it is minted, and
//    rotated by its own endpoint rather than silently by an API key rotation.
//
// 2. THE SIGNATURE. It is Standard Webhooks (standardwebhooks.com), the same
//    scheme lib/standard-webhook.ts verifies for inbound hooks: HMAC-SHA256 over
//    `${webhook-id}.${webhook-timestamp}.${body}` with the base64-decoded secret,
//    sent as `webhook-signature: v1,<base64>`. The timestamp is signed, so a
//    captured delivery cannot be replayed outside the receiver's tolerance, and
//    webhook-id is stable across retries of one event so a receiver can dedupe.
//    Off-the-shelf verifiers (svix, standardwebhooks) work unchanged.
//
// 3. DELIVERY. One endpoint per account (api_webhook_endpoints), not one copy
//    per API key, and every event is a row in webhook_deliveries with a UNIQUE
//    (user_id, event_type, subject_id), so a grade produces exactly one event
//    however many keys or pipeline re-runs there are. Retries are rows with a
//    next_attempt_at, swept by /api/jobs/webhook-retry, so a deploy no longer
//    kills a retry that was sleeping in-process. Every HTTP attempt is logged to
//    webhook_delivery_attempts.
//
// LEGACY. An endpoint carried over from api_keys.webhook_url by the migration
// has no whsec_ secret until the owner rotates. Only for THOSE endpoints the old
// `X-GradeThread-Signature` (hex HMAC of the body keyed by one key_hash) is still
// sent, so an integration that found a way to verify it keeps working. Once a
// secret exists the legacy header is gone. The Standard Webhooks headers are
// sent in both cases.
//
// TENANCY (US-268). Every query is `.eq("user_id", ...)` with the account owner
// the grading pipeline or the API-key middleware resolved. The retry sweep reads
// rows fleet-wide by status, then keys every follow-up read on that row's own
// user_id. Nothing here takes an id from a request body.
//
// DURABLE-JOBS CONTRACT. Claim is a compare-and-set on (status='pending',
// attempts=<read>), so two replicas cannot both send one attempt. A row left
// 'running' by a dead worker is returned to 'pending' after RUNNING_STALE_MS,
// which is far above DELIVERY_TIMEOUT_MS so a live attempt never looks stale.
// max_attempts (default 6) caps it; after that the row is 'failed' for good.

import { supabaseAdmin } from "./supabase.ts";
import { assertPublicUrl, SsrfError } from "./ssrf.ts";
import { decryptToken, encryptToken } from "./crypto-aes.ts";

export const DELIVERY_TIMEOUT_MS = 10_000;
/** A 'running' row older than this was left by a dead worker. */
export const RUNNING_STALE_MS = 5 * 60_000;
/** Wait after the Nth failed attempt (index N-1). The cron runs every 5 min. */
export const RETRY_BACKOFF_MS = [
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000,
  8 * 60 * 60_000,
];
export const SWEEP_LIMIT = 50;
export const GRADE_COMPLETED = "grade.completed";

const SECRET_PREFIX = "whsec_";
const SECRET_BYTES = 32;
const encoder = new TextEncoder();

// ── Signing ─────────────────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A fresh `whsec_<base64 of 32 random bytes>` secret. */
export function generateWebhookSecret(): string {
  return SECRET_PREFIX + bytesToBase64(crypto.getRandomValues(new Uint8Array(SECRET_BYTES)));
}

function secretKeyBytes(secret: string): Uint8Array<ArrayBuffer> {
  if (!secret.startsWith(SECRET_PREFIX)) {
    // Refusing here is what keeps a key_hash (64 hex chars, no prefix) from
    // ever being passed in as the signing secret again.
    throw new Error("webhook secret must be a whsec_ value");
  }
  return base64ToBytes(secret.slice(SECRET_PREFIX.length));
}

async function hmac(key: Uint8Array<ArrayBuffer>, content: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, encoder.encode(content)));
}

/** Standard Webhooks signature header value: `v1,<base64 HMAC>`. */
export async function signWebhook(
  secret: string,
  eventId: string,
  timestampSec: number,
  body: string,
): Promise<string> {
  const sig = await hmac(secretKeyBytes(secret), `${eventId}.${timestampSec}.${body}`);
  return `v1,${bytesToBase64(sig)}`;
}

/** The pre-00830 signature: hex HMAC of the body alone. Legacy endpoints only. */
export async function legacyBodySignature(keyHash: string, body: string): Promise<string> {
  const sig = await hmac(new Uint8Array(encoder.encode(keyHash)), body);
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface SignedRequest {
  body: string;
  headers: Record<string, string>;
}

/**
 * Build the exact bytes and headers of one attempt. `secret` null means a
 * legacy endpoint with no whsec_ yet, which is the only case `legacyKeyHash`
 * is used.
 */
export async function buildSignedRequest(opts: {
  eventId: string;
  payload: Record<string, unknown>;
  secret: string | null;
  legacyKeyHash: string | null;
  nowSec: number;
}): Promise<SignedRequest> {
  const body = JSON.stringify(opts.payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "GradeThread-Webhook/2.0",
    "webhook-id": opts.eventId,
    "webhook-timestamp": String(opts.nowSec),
  };
  if (opts.secret) {
    headers["webhook-signature"] = await signWebhook(opts.secret, opts.eventId, opts.nowSec, body);
  } else if (opts.legacyKeyHash) {
    headers["X-GradeThread-Signature"] = await legacyBodySignature(opts.legacyKeyHash, body);
  }
  return { body, headers };
}

// ── Secret storage ──────────────────────────────────────────────────

export function encryptWebhookSecret(secret: string, ownerId: string): Promise<string> {
  return encryptToken(secret, { aad: ownerId });
}

export function decryptWebhookSecret(ciphertext: string, ownerId: string): Promise<string> {
  return decryptToken(ciphertext, { aad: ownerId });
}

// ── Store seam ──────────────────────────────────────────────────────

export type DeliveryStatus = "pending" | "running" | "delivered" | "failed" | "cancelled";

export interface DeliveryRow {
  id: string;
  user_id: string;
  event_id: string;
  event_type: string;
  subject_id: string;
  payload: Record<string, unknown>;
  status: DeliveryStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
}

export interface EndpointRow {
  url: string;
  secret_ciphertext: string | null;
}

export interface AttemptLog {
  delivery_id: string;
  user_id: string;
  attempt: number;
  success: boolean;
  status_code: number | null;
  error: string | null;
  response_excerpt: string | null;
  duration_ms: number;
}

/**
 * Every database touch the delivery loop makes, injectable so the
 * once-per-grade and survive-a-restart guarantees are unit tests
 * (webhook-delivery_test.ts) rather than claims.
 */
export interface WebhookStore {
  /** Insert; null when (user_id, event_type, subject_id) already exists. */
  insertDelivery(row: {
    user_id: string;
    event_id: string;
    event_type: string;
    subject_id: string;
    payload: Record<string, unknown>;
    /** Omitted: the column default (6). */
    max_attempts?: number;
  }): Promise<DeliveryRow | null>;
  loadEndpoint(userId: string): Promise<EndpointRow | null>;
  /** Compare-and-set pending -> running, attempts+1. Null when lost. */
  claim(row: DeliveryRow, nowIso: string): Promise<DeliveryRow | null>;
  /** pending -> failed for a row whose attempts are spent. False when lost. */
  closeExhausted(row: DeliveryRow): Promise<boolean>;
  legacyKeyHash(userId: string): Promise<string | null>;
  recordAttempt(log: AttemptLog): Promise<void>;
  finish(row: DeliveryRow, values: Record<string, unknown>): Promise<void>;
  listDue(nowIso: string, limit: number): Promise<DeliveryRow[]>;
  reclaimStale(staleBeforeIso: string, nowIso: string): Promise<number>;
}

export interface SendResult {
  success: boolean;
  statusCode: number;
  responseBody: string;
}

export interface WebhookDeps {
  store: WebhookStore;
  send: (url: string, req: SignedRequest) => Promise<SendResult>;
  decryptSecret: (ciphertext: string, ownerId: string) => Promise<string>;
  now: () => Date;
}

const DELIVERY_COLUMNS =
  "id, user_id, event_id, event_type, subject_id, payload, status, attempts, max_attempts, next_attempt_at";

const dbStore: WebhookStore = {
  async insertDelivery(row) {
    const { data, error } = await supabaseAdmin
      .from("webhook_deliveries")
      .upsert(row, { onConflict: "user_id,event_type,subject_id", ignoreDuplicates: true })
      .select(DELIVERY_COLUMNS);
    if (error) throw new Error(`webhook enqueue failed: ${error.message}`);
    const rows = (data ?? []) as DeliveryRow[];
    return rows[0] ?? null;
  },
  async loadEndpoint(userId) {
    const { data, error } = await supabaseAdmin
      .from("api_webhook_endpoints")
      .select("url, secret_ciphertext")
      .eq("user_id", userId) // US-268
      .maybeSingle();
    if (error) throw new Error(`webhook endpoint read failed: ${error.message}`);
    return (data as EndpointRow | null) ?? null;
  },
  async claim(row, nowIso) {
    const { data, error } = await supabaseAdmin
      .from("webhook_deliveries")
      .update({ status: "running", attempts: row.attempts + 1, last_attempt_at: nowIso })
      .eq("id", row.id)
      .eq("user_id", row.user_id) // US-268
      .eq("status", "pending")
      .eq("attempts", row.attempts)
      .select(DELIVERY_COLUMNS);
    if (error) {
      console.error(`[Webhook] claim failed for ${row.id}: ${error.message}`);
      return null;
    }
    return ((data ?? []) as DeliveryRow[])[0] ?? null;
  },
  async closeExhausted(row) {
    const { data, error } = await supabaseAdmin
      .from("webhook_deliveries")
      .update({ status: "failed", last_error: "exhausted retries" })
      .eq("id", row.id)
      .eq("user_id", row.user_id) // US-268
      .eq("status", "pending")
      .eq("attempts", row.attempts)
      .select("id");
    if (error) {
      console.error(`[Webhook] close failed for ${row.id}: ${error.message}`);
      return false;
    }
    return (data ?? []).length > 0;
  },
  async legacyKeyHash(userId) {
    const { data } = await supabaseAdmin
      .from("api_keys")
      .select("key_hash, expires_at")
      .eq("user_id", userId) // US-268
      .order("created_at", { ascending: true });
    const now = Date.now();
    const live = ((data ?? []) as Array<{ key_hash: string; expires_at: string | null }>)
      .find((k) => !k.expires_at || new Date(k.expires_at).getTime() > now);
    return live?.key_hash ?? null;
  },
  async recordAttempt(log) {
    const { error } = await supabaseAdmin.from("webhook_delivery_attempts").insert(log);
    if (error) console.error(`[Webhook] attempt log failed for ${log.delivery_id}: ${error.message}`);
  },
  async finish(row, values) {
    const { error } = await supabaseAdmin
      .from("webhook_deliveries")
      .update(values)
      .eq("id", row.id)
      .eq("user_id", row.user_id) // US-268
      .eq("status", "running");
    if (error) console.error(`[Webhook] finish failed for ${row.id}: ${error.message}`);
  },
  async listDue(nowIso, limit) {
    const { data, error } = await supabaseAdmin
      .from("webhook_deliveries")
      .select(DELIVERY_COLUMNS)
      .eq("status", "pending")
      .lte("next_attempt_at", nowIso)
      .order("next_attempt_at", { ascending: true })
      .limit(limit);
    if (error) throw new Error(`webhook due scan failed: ${error.message}`);
    return (data ?? []) as DeliveryRow[];
  },
  async reclaimStale(staleBeforeIso, nowIso) {
    const { data, error } = await supabaseAdmin
      .from("webhook_deliveries")
      .update({ status: "pending", next_attempt_at: nowIso, last_error: "worker lost mid-attempt" })
      .eq("status", "running")
      .lt("updated_at", staleBeforeIso)
      .select("id");
    if (error) throw new Error(`webhook reclaim failed: ${error.message}`);
    return (data ?? []).length;
  },
};

async function httpSend(url: string, req: SignedRequest): Promise<SendResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
  try {
    // US-345: re-validate at delivery time; DNS can change after set-time.
    await assertPublicUrl(url);
    // redirect: "manual" so a 3xx cannot bounce the delivery to an internal host.
    const response = await fetch(url, {
      method: "POST",
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
      redirect: "manual",
    });
    const responseBody = await response.text().catch(() => "");
    return {
      success: response.status >= 200 && response.status < 300,
      statusCode: response.status,
      responseBody: responseBody.slice(0, 500),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      statusCode: 0,
      responseBody: error instanceof SsrfError
        ? `Delivery refused: ${message}`
        : `Delivery error: ${message}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export const realWebhookDeps: WebhookDeps = {
  store: dbStore,
  send: httpSend,
  decryptSecret: decryptWebhookSecret,
  now: () => new Date(),
};

// ── Delivery loop ───────────────────────────────────────────────────

export type AttemptOutcome = "delivered" | "retry" | "failed" | "cancelled" | "skipped";

export function backoffAfter(attempts: number): number {
  return RETRY_BACKOFF_MS[Math.min(Math.max(attempts, 1), RETRY_BACKOFF_MS.length) - 1]!;
}

/**
 * Claim one row and make ONE attempt. Never throws: a failure is written to the
 * row, which is the only trace a customer or support will look at.
 */
export async function attemptDelivery(
  row: DeliveryRow,
  deps: WebhookDeps = realWebhookDeps,
): Promise<AttemptOutcome> {
  const { store } = deps;
  const started = deps.now();

  // A row that already spent its budget (reclaimed after its last attempt
  // died mid-flight) is closed without another send.
  if (row.attempts >= row.max_attempts) {
    return (await store.closeExhausted(row)) ? "failed" : "skipped";
  }

  const claimed = await store.claim(row, started.toISOString());
  if (!claimed) return "skipped";

  try {
    const endpoint = await store.loadEndpoint(claimed.user_id);
    if (!endpoint) {
      await store.finish(claimed, {
        status: "cancelled",
        last_error: "no webhook endpoint configured",
      });
      return "cancelled";
    }

    const secret = endpoint.secret_ciphertext
      ? await deps.decryptSecret(endpoint.secret_ciphertext, claimed.user_id)
      : null;
    const legacyKeyHash = secret ? null : await store.legacyKeyHash(claimed.user_id);
    const req = await buildSignedRequest({
      eventId: claimed.event_id,
      payload: claimed.payload,
      secret,
      legacyKeyHash,
      nowSec: Math.floor(started.getTime() / 1000),
    });

    const result = await deps.send(endpoint.url, req);
    const finishedAt = deps.now();
    await store.recordAttempt({
      delivery_id: claimed.id,
      user_id: claimed.user_id,
      attempt: claimed.attempts,
      success: result.success,
      status_code: result.statusCode || null,
      error: result.success ? null : result.responseBody.slice(0, 500),
      response_excerpt: result.responseBody.slice(0, 500) || null,
      duration_ms: finishedAt.getTime() - started.getTime(),
    });

    if (result.success) {
      await store.finish(claimed, {
        status: "delivered",
        delivered_at: finishedAt.toISOString(),
        last_status_code: result.statusCode,
        last_error: null,
      });
      return "delivered";
    }
    return await failAttempt(claimed, deps, result.statusCode || null, result.responseBody);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
      return await failAttempt(claimed, deps, null, `threw: ${message}`);
    } catch {
      // The row stays 'running' and the stale reclaim returns it to 'pending'.
      return "retry";
    }
  }
}

async function failAttempt(
  row: DeliveryRow,
  deps: WebhookDeps,
  statusCode: number | null,
  error: string,
): Promise<AttemptOutcome> {
  const terminal = row.attempts >= row.max_attempts;
  await deps.store.finish(row, terminal
    ? { status: "failed", last_status_code: statusCode, last_error: error.slice(0, 500) }
    : {
      status: "pending",
      last_status_code: statusCode,
      last_error: error.slice(0, 500),
      next_attempt_at: new Date(deps.now().getTime() + backoffAfter(row.attempts)).toISOString(),
    });
  return terminal ? "failed" : "retry";
}

/**
 * Record one event for an account and try it once right away. Returns null
 * when the account has no endpoint or the event was already recorded, which is
 * how a re-run of the grading pipeline stays a single delivery.
 */
export async function enqueueWebhookEvent(
  ownerId: string,
  eventType: string,
  subjectId: string,
  data: Record<string, unknown>,
  deps: WebhookDeps = realWebhookDeps,
  opts: { maxAttempts?: number } = {},
): Promise<{ deliveryId: string; eventId: string; outcome: AttemptOutcome } | null> {
  const endpoint = await deps.store.loadEndpoint(ownerId);
  if (!endpoint) return null;

  // The event id is minted here rather than by the column default so the
  // payload can carry it from the first write: a receiver that logs bodies but
  // not headers can still dedupe, and a retry sends the very same body.
  const eventId = crypto.randomUUID();
  const row = await deps.store.insertDelivery({
    user_id: ownerId,
    event_id: eventId,
    event_type: eventType,
    subject_id: subjectId,
    payload: { id: eventId, event: eventType, data, timestamp: deps.now().toISOString() },
    ...(opts.maxAttempts !== undefined ? { max_attempts: opts.maxAttempts } : {}),
  });
  if (!row) return null;

  const outcome = await attemptDelivery(row, deps);
  return { deliveryId: row.id, eventId: row.event_id, outcome };
}

export interface SweepResult {
  reclaimed: number;
  scanned: number;
  delivered: number;
  retried: number;
  exhausted: number;
  cancelled: number;
  skipped: number;
}

/** The retry cron's body: reclaim dead workers' rows, then attempt what is due. */
export async function sweepWebhookDeliveries(
  deps: WebhookDeps = realWebhookDeps,
): Promise<SweepResult> {
  const now = deps.now();
  const reclaimed = await deps.store.reclaimStale(
    new Date(now.getTime() - RUNNING_STALE_MS).toISOString(),
    now.toISOString(),
  );
  const due = await deps.store.listDue(now.toISOString(), SWEEP_LIMIT);
  const out: SweepResult = {
    reclaimed,
    scanned: due.length,
    delivered: 0,
    retried: 0,
    exhausted: 0,
    cancelled: 0,
    skipped: 0,
  };
  for (const row of due) {
    const outcome = await attemptDelivery(row, deps);
    if (outcome === "delivered") out.delivered++;
    else if (outcome === "retry") out.retried++;
    else if (outcome === "failed") out.exhausted++;
    else if (outcome === "cancelled") out.cancelled++;
    else out.skipped++;
  }
  return out;
}

/**
 * Called by the grading pipeline once a grade is final. One event per
 * submission per account, whatever the number of API keys.
 */
export async function notifyWebhooks(
  userId: string,
  submissionId: string,
  gradeReport: Record<string, unknown>,
  deps: WebhookDeps = realWebhookDeps,
): Promise<void> {
  const result = await enqueueWebhookEvent(
    userId,
    GRADE_COMPLETED,
    submissionId,
    { submission_id: submissionId, grade_report: gradeReport },
    deps,
  );
  if (result) {
    console.log(
      `[Webhook] ${GRADE_COMPLETED} for submission ${submissionId}: ${result.outcome} (delivery ${result.deliveryId})`,
    );
  }
}
