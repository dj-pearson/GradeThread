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
  type AttemptOutcome,
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
): Promise<{ signing_secret: string | null }> {
  let signingSecret: string | null = null;
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
    if (existing) {
      const { error } = await db.from("api_webhook_endpoints").update({ url }).eq("user_id", ownerId); // US-268
      if (error) throw new AccountWebhookError(`webhook update failed: ${error.message}`);
    } else {
      signingSecret = generateWebhookSecret();
      const { error } = await db.from("api_webhook_endpoints").insert({
        user_id: ownerId,
        url,
        secret_ciphertext: await encryptWebhookSecret(signingSecret, ownerId),
        secret_created_at: new Date().toISOString(),
      });
      if (error) throw new AccountWebhookError(`webhook create failed: ${error.message}`);
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
  return { signing_secret: signingSecret };
}

/** Mint a new secret. Null when the account has no endpoint to rotate. */
export async function rotateWebhookSecret(
  ownerId: string,
  db: WebhookDb = supabaseAdmin,
): Promise<{ signing_secret: string; secret_created_at: string } | null> {
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
