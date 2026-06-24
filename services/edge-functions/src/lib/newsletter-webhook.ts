// US-923: outbound Make.com notification for newsletter lifecycle events.
//
// Mirrors content-webhook.ts: fires issue.created / issue.sent events to a single
// configurable Make.com webhook URL (newsletter_make_webhook_url, settings registry)
// so a downstream automation can react. The body is HMAC-signed with
// NEWSLETTER_WEBHOOK_SIGNING_SECRET (X-Newsletter-Signature) so the receiver can
// verify authenticity. Delivery is retried (0s / 5s / 30s, 10s/attempt timeout) and
// EVERY attempt is logged to newsletter_webhook_log; a terminal failure raises an ops
// alert. Best-effort by contract — the caller wraps in try/catch so a webhook failure
// never rolls back the issue's lifecycle.

import { supabaseAdmin } from "./supabase.ts";
import { assertPublicUrl, SsrfError } from "./ssrf.ts";
import { getSetting } from "./system-settings.ts";
import { captureException, recordMetric } from "./observability.ts";
import { emitOpsEvent } from "./ops-events.ts";

export type NewsletterWebhookEvent = "issue.created" | "issue.sent";

export interface NewsletterWebhookData {
  id: string;
  title: string;
  subject: string;
  status: string;
  scheduled_for?: string | null;
  sent_at?: string | null;
  recipients_total?: number;
  sent_count?: number;
  skipped_count?: number;
  failed_count?: number;
  pillar?: string | null;
}

export interface NewsletterWebhookPayload {
  event: NewsletterWebhookEvent;
  timestamp: string;
  data: NewsletterWebhookData;
}

const ATTEMPT_DELAYS_MS = [0, 5_000, 30_000];
const ATTEMPT_TIMEOUT_MS = 10_000;

function getSigningSecret(): string | null {
  return Deno.env.get("NEWSLETTER_WEBHOOK_SIGNING_SECRET")?.trim() || null;
}

// HMAC-SHA256 hex signature (Web Crypto — no Node dependency). Pure given a secret.
async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Sign a serialized webhook body with NEWSLETTER_WEBHOOK_SIGNING_SECRET, or null
 * when no secret is configured. Exported so a test (or a future "test webhook" fire)
 * carries the same X-Newsletter-Signature a real notification does.
 */
export async function signNewsletterBody(body: string): Promise<string | null> {
  const secret = getSigningSecret();
  return secret ? await hmacSha256Hex(secret, body) : null;
}

// The configurable downstream URL (settings registry; empty = not configured).
async function resolveTargetUrl(): Promise<string | null> {
  const url = (await getSetting<string>("newsletter_make_webhook_url", "")).trim();
  return url || null;
}

async function logAttempt(row: {
  event: NewsletterWebhookEvent;
  issue_id: string;
  target_url: string;
  payload: NewsletterWebhookPayload;
  attempt_no: number;
  http_status: number | null;
  response_body: string | null;
  succeeded: boolean;
  error: string | null;
}): Promise<void> {
  const { error } = await supabaseAdmin.from("newsletter_webhook_log").insert(row);
  if (error) {
    console.warn("[newsletter-webhook] log insert failed:", error.message);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Deliver one newsletter lifecycle webhook with retry + per-attempt logging.
 * Returns the terminal outcome. A missing destination URL is a no-op (delivered:
 * false, attempts: 0) — not an error. Never throws.
 */
export async function dispatchNewsletterWebhook(
  payload: NewsletterWebhookPayload,
): Promise<{ delivered: boolean; attempts: number; last_status: number | null }> {
  const url = await resolveTargetUrl();
  if (!url) {
    console.log(
      `[newsletter-webhook] no URL configured for ${payload.event} — skipping`,
    );
    return { delivered: false, attempts: 0, last_status: null };
  }

  // SSRF: admin-configured URL fetched server-side — re-validate at delivery
  // time and refuse private/internal targets (DNS can change after it was set).
  try {
    await assertPublicUrl(url);
  } catch (e) {
    if (e instanceof SsrfError) {
      console.warn(`[newsletter-webhook] target URL rejected by SSRF guard: ${e.message} — skipping`);
      return { delivered: false, attempts: 0, last_status: null };
    }
    throw e;
  }

  const body = JSON.stringify(payload);
  const signature = await signNewsletterBody(body);

  let lastStatus: number | null = null;
  for (let i = 0; i < ATTEMPT_DELAYS_MS.length; i++) {
    if (i > 0) await sleep(ATTEMPT_DELAYS_MS[i] ?? 0);
    const attemptNo = i + 1;
    let status: number | null = null;
    let respBody = "";
    let ok = false;
    let errStr: string | null = null;

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(signature ? { "X-Newsletter-Signature": signature } : {}),
          "X-Newsletter-Event": payload.event,
        },
        body,
        redirect: "manual", // never follow a redirect to an internal host
        signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      });
      status = res.status;
      respBody = (await res.text()).slice(0, 1000);
      ok = res.ok;
    } catch (e) {
      errStr = e instanceof Error ? e.message : String(e);
    }
    lastStatus = status;

    await logAttempt({
      event: payload.event,
      issue_id: payload.data.id,
      target_url: url,
      payload,
      attempt_no: attemptNo,
      http_status: status,
      response_body: respBody || null,
      succeeded: ok,
      error: errStr,
    });

    if (ok) {
      console.log(
        `[newsletter-webhook] delivered ${payload.event} on attempt ${attemptNo} (${status})`,
      );
      return { delivered: true, attempts: attemptNo, last_status: status };
    }
    console.warn(
      `[newsletter-webhook] attempt ${attemptNo} failed for ${payload.event}: ${errStr ?? status}`,
    );
  }

  console.error(
    `[newsletter-webhook] gave up on ${payload.event} after ${ATTEMPT_DELAYS_MS.length} attempts`,
  );
  recordMetric("newsletter_webhook.delivery_failed", 1, { event: payload.event });
  // A terminal delivery failure must page someone, not just sit in the log.
  await emitOpsEvent("newsletter.webhook", "warning", {
    title: `Newsletter webhook delivery FAILED: ${payload.event} (issue ${payload.data.id})`,
    source: "newsletter-webhook",
    data: { event: payload.event, issueId: payload.data.id, lastStatus },
  }).catch((err) => captureException(err, { tags: { area: "newsletter-webhook.alert" } }));

  return { delivered: false, attempts: ATTEMPT_DELAYS_MS.length, last_status: lastStatus };
}

/**
 * Pure cadence gate for the kickoff trigger: is the program due to create a new
 * issue? True when nothing has been created yet, or the most recent issue was
 * created at least `cadenceDays` ago — so re-triggers WITHIN the same period are
 * no-ops and the Make schedule can be simple / over-fire safely. Takes `nowMs` so
 * it is deterministic + unit-testable with no DB.
 */
export function kickoffDue(
  lastCreatedMs: number | null,
  cadenceDays: number,
  nowMs: number,
): boolean {
  if (lastCreatedMs == null || !Number.isFinite(lastCreatedMs)) return true;
  const period = Math.max(0, cadenceDays) * 86_400_000;
  return nowMs - lastCreatedMs >= period;
}
