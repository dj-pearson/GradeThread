// The account webhook's reads and writes (00830), shared by the two surfaces
// that manage it: the public API (/api/v1/webhook, API-key auth) and the
// dashboard (/api/keys/webhook, session auth). They used to be written inline
// in api-v1.ts; the dashboard needs exactly the same rules (one endpoint per
// account, the secret shown once, URL changes never touching the secret), so
// they live here once rather than twice.
//
// TENANCY (US-268). Every function takes the account owner id the caller has
// already resolved (the API key's owner, or workspaceOwnerId ?? userId) and
// every query is `.eq("user_id", ownerId)`. Nothing here takes a row id.
//
// `db` is injectable so account-webhook_test.ts can prove that scoping query by
// query without a database.

import { supabaseAdmin } from "./supabase.ts";
import {
  attemptDelivery,
  type AttemptOutcome,
  type DeliveryRow,
  encryptWebhookSecret,
  enqueueWebhookEvent,
  generateWebhookSecret,
  realWebhookDeps,
  type WebhookDeps,
} from "./webhook-delivery.ts";

// deno-lint-ignore no-explicit-any
export type WebhookDb = any;

export class AccountWebhookError extends Error {}

export interface WebhookConfig {
  webhook_url: string | null;
  has_signing_secret: boolean;
  secret_created_at: string | null;
  updated_at: string | null;
}

export async function getWebhookConfig(ownerId: string, db: WebhookDb = supabaseAdmin): Promise<WebhookConfig> {
  const { data, error } = await db
    .from("api_webhook_endpoints")
    .select("url, secret_ciphertext, secret_created_at, updated_at")
    .eq("user_id", ownerId) // US-268
    .maybeSingle();
  if (error) throw new AccountWebhookError(`webhook read failed: ${error.message}`);
  const row = data as
    | { url: string; secret_ciphertext: string | null; secret_created_at: string | null; updated_at: string }
    | null;
  return {
    webhook_url: row?.url ?? null,
    has_signing_secret: Boolean(row?.secret_ciphertext),
    secret_created_at: row?.secret_created_at ?? null,
    updated_at: row?.updated_at ?? null,
  };
}

/**
 * Set (url) or clear (null) the account's endpoint. Returns the new signing
 * secret only when this call CREATED the endpoint; that is the one time it is
 * ever shown. Changing an existing URL never changes the secret. The URL must
 * already have passed assertPublicUrl.
 */
export async function setWebhookUrl(
  ownerId: string,
  url: string | null,
  db: WebhookDb = supabaseAdmin,
): Promise<{ signing_secret: string | null; secret_created_at: string | null }> {
  let signingSecret: string | null = null;
  let secretCreatedAt: string | null = null;
  if (url === null) {
    const { error } = await db.from("api_webhook_endpoints").delete().eq("user_id", ownerId); // US-268
    if (error) throw new AccountWebhookError(`webhook clear failed: ${error.message}`);
  } else {
    const { data: existing, error: readError } = await db
      .from("api_webhook_endpoints")
      .select("user_id")
      .eq("user_id", ownerId) // US-268
      .maybeSingle();
    if (readError) throw new AccountWebhookError(`webhook read failed: ${readError.message}`);
    // DEV-11: the create is an upsert that ignores a conflict on user_id, so
    // two first-time saves racing past the read above cannot collide on the
    // primary key with a 500. Only the save whose row came back minted the
    // stored secret; the other falls through to a plain URL update.
    let created = false;
    if (!existing) {
      const secret = generateWebhookSecret();
      const createdAt = new Date().toISOString();
      const { data: inserted, error } = await db
        .from("api_webhook_endpoints")
        .upsert(
          {
            user_id: ownerId,
            url,
            secret_ciphertext: await encryptWebhookSecret(secret, ownerId),
            secret_created_at: createdAt,
          },
          { onConflict: "user_id", ignoreDuplicates: true },
        )
        .select("user_id");
      if (error) throw new AccountWebhookError(`webhook create failed: ${error.message}`);
      if (Array.isArray(inserted) && inserted.length > 0) {
        created = true;
        signingSecret = secret;
        secretCreatedAt = createdAt;
      }
    }
    if (!created) {
      const { error } = await db.from("api_webhook_endpoints").update({ url }).eq("user_id", ownerId); // US-268
      if (error) throw new AccountWebhookError(`webhook update failed: ${error.message}`);
    }
  }

  // api_keys.webhook_url is still written so a rolled-back edge keeps
  // delivering; nothing new reads it. A failure here is logged, not raised:
  // the endpoint row is the source of truth and is already written.
  const { error: mirrorError } = await db
    .from("api_keys")
    .update({ webhook_url: url })
    .eq("user_id", ownerId); // US-268
  if (mirrorError) {
    console.error(`[account-webhook] mirror onto api_keys failed: ${mirrorError.message}`);
  }
  return { signing_secret: signingSecret, secret_created_at: secretCreatedAt };
}

/** Mint a new secret. Null when the account has no endpoint to rotate. */
export async function rotateWebhookSecret(
  ownerId: string,
  db: WebhookDb = supabaseAdmin,
): Promise<{ signing_secret: string; secret_created_at: string } | null> {
  // No webhook is a 404, decided before anything is encrypted: a caller with
  // no endpoint must never reach the key, and a missing key must not turn
  // "you have no webhook" into a 500.
  const { data: existing, error: readError } = await db
    .from("api_webhook_endpoints")
    .select("user_id")
    .eq("user_id", ownerId) // US-268
    .limit(1);
  if (readError) throw new AccountWebhookError(`webhook rotate read failed: ${readError.message}`);
  if (!existing || existing.length === 0) return null;
  const secret = generateWebhookSecret();
  const createdAt = new Date().toISOString();
  const { data, error } = await db
    .from("api_webhook_endpoints")
    .update({
      secret_ciphertext: await encryptWebhookSecret(secret, ownerId),
      secret_created_at: createdAt,
    })
    .eq("user_id", ownerId) // US-268
    .select("user_id");
  if (error) throw new AccountWebhookError(`webhook rotate failed: ${error.message}`);
  if (!data || data.length === 0) return null;
  return { signing_secret: secret, secret_created_at: createdAt };
}

export const DELIVERY_LIST_COLUMNS =
  "event_id, event_type, subject_id, status, attempts, max_attempts, next_attempt_at, " +
  "last_attempt_at, last_status_code, last_error, delivered_at, created_at";

/** Clamp a ?limit= to 1..100, default 20. */
export function deliveryLimit(raw: string | undefined): number {
  const n = Number(raw ?? "20");
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), 100) : 20;
}

export async function listWebhookDeliveries(
  ownerId: string,
  limit: number,
  db: WebhookDb = supabaseAdmin,
): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await db
    .from("webhook_deliveries")
    .select(DELIVERY_LIST_COLUMNS)
    .eq("user_id", ownerId) // US-268
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new AccountWebhookError(`webhook deliveries read failed: ${error.message}`);
  return (data ?? []) as Array<Record<string, unknown>>;
}

// ── Drill-in and resend (DEV-12) ─────────────────────────────────────

const EVENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Headers every attempt carries (webhook-delivery.ts buildSignedRequest). */
export const DELIVERY_HEADER_NAMES = [
  "Content-Type",
  "User-Agent",
  "webhook-id",
  "webhook-timestamp",
  "webhook-signature",
];

export interface WebhookAttemptView {
  attempt: number;
  success: boolean;
  status_code: number | null;
  error: string | null;
  response_excerpt: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface WebhookDeliveryDetail extends Record<string, unknown> {
  payload: Record<string, unknown>;
  header_names: string[];
  attempts_log: WebhookAttemptView[];
}

/**
 * One delivery and every attempt at it. Null for an event id that is not this
 * owner's (or not a uuid, which would otherwise reach Postgres as 22P02). The
 * attempts are read by the delivery's own id AND the owner, never by an id
 * from the request.
 */
export async function getWebhookDelivery(
  ownerId: string,
  eventId: string,
  db: WebhookDb = supabaseAdmin,
): Promise<WebhookDeliveryDetail | null> {
  if (!EVENT_ID_RE.test(eventId)) return null;
  const { data: row, error } = await db
    .from("webhook_deliveries")
    .select(`id, payload, ${DELIVERY_LIST_COLUMNS}`)
    .eq("user_id", ownerId) // US-268
    .eq("event_id", eventId)
    .maybeSingle();
  if (error) throw new AccountWebhookError(`webhook delivery read failed: ${error.message}`);
  if (!row) return null;
  const delivery = row as Record<string, unknown> & { id: string; payload: Record<string, unknown> };
  const { data: attempts, error: attemptsError } = await db
    .from("webhook_delivery_attempts")
    .select("attempt, success, status_code, error, response_excerpt, duration_ms, created_at")
    .eq("user_id", ownerId) // US-268
    .eq("delivery_id", delivery.id)
    .order("created_at", { ascending: true });
  if (attemptsError) {
    throw new AccountWebhookError(`webhook attempts read failed: ${attemptsError.message}`);
  }
  const { id: _internalId, ...rest } = delivery;
  return {
    ...rest,
    payload: delivery.payload,
    header_names: DELIVERY_HEADER_NAMES,
    attempts_log: (attempts ?? []) as WebhookAttemptView[],
  };
}

const REDELIVER_COLUMNS =
  "id, user_id, event_id, event_type, subject_id, payload, status, attempts, max_attempts, next_attempt_at";

export type RedeliverResult =
  | { kind: "not_found" }
  | { kind: "running" }
  | { kind: "sent"; event_id: string; outcome: AttemptOutcome };

/**
 * Send a recorded event again under the SAME event_id, so a receiver that
 * dedupes on webhook-id still sees one event. The row is reset to pending with
 * attempts 0 and attempted once now; the retry cron takes it from there. A row
 * already being sent is refused, in the same UPDATE, so two resends (or a
 * resend and the cron) cannot both claim it.
 */
export async function redeliverWebhook(
  ownerId: string,
  eventId: string,
  db: WebhookDb = supabaseAdmin,
  deps: WebhookDeps = realWebhookDeps,
): Promise<RedeliverResult> {
  if (!EVENT_ID_RE.test(eventId)) return { kind: "not_found" };
  const { data, error } = await db
    .from("webhook_deliveries")
    .update({
      status: "pending",
      attempts: 0,
      next_attempt_at: deps.now().toISOString(),
      delivered_at: null,
    })
    .eq("user_id", ownerId) // US-268
    .eq("event_id", eventId)
    .in("status", ["pending", "delivered", "failed", "cancelled"])
    .select(REDELIVER_COLUMNS);
  if (error) throw new AccountWebhookError(`webhook redeliver failed: ${error.message}`);
  const row = ((data ?? []) as DeliveryRow[])[0];
  if (!row) {
    const { data: existing, error: readError } = await db
      .from("webhook_deliveries")
      .select("status")
      .eq("user_id", ownerId) // US-268
      .eq("event_id", eventId)
      .maybeSingle();
    if (readError) throw new AccountWebhookError(`webhook redeliver read failed: ${readError.message}`);
    return existing ? { kind: "running" } : { kind: "not_found" };
  }
  const outcome = await attemptDelivery(row, deps);
  return { kind: "sent", event_id: row.event_id, outcome };
}

export const TEST_EVENT = "webhook.test";

/**
 * Send one signed `webhook.test` event to the account's endpoint now. It is a
 * real delivery row, so it shows in the delivery log, but with max_attempts 1:
 * a customer's broken endpoint answers the button, and the retry cron never
 * keeps pinging it for hours afterwards. Null when there is no endpoint.
 */
export async function sendTestWebhook(
  ownerId: string,
  deps: WebhookDeps = realWebhookDeps,
): Promise<{ event_id: string; outcome: AttemptOutcome } | null> {
  const subjectId = `test:${crypto.randomUUID()}`;
  const result = await enqueueWebhookEvent(
    ownerId,
    TEST_EVENT,
    subjectId,
    { message: "Test event from the GradeThread dashboard. No action needed." },
    deps,
    { maxAttempts: 1 },
  );
  if (!result) return null;
  return { event_id: result.eventId, outcome: result.outcome };
}
