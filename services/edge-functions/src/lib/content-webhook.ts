import { supabaseAdmin } from "./supabase.ts";
import { captureServer } from "./posthog.ts";
import { captureException, recordMetric } from "./observability.ts";

// Outbound webhook dispatcher for the content module.
//
// Fires publish events to Make.com URLs configured in content_settings.
// HMAC signs the body with CONTENT_WEBHOOK_SIGNING_SECRET so the
// downstream scenario can verify authenticity before posting to
// LinkedIn / X / etc.
//
// Behavior:
//   - 3 attempts: 0s, 5s, 30s (mirrors webhook-delivery.ts shape)
//   - 10s per-attempt timeout
//   - Each attempt logged to content_webhook_log
//   - Terminal failure alerts ops (metric + error tracker + alert webhook,
//     US-487) and stays retryable via POST /webhooks/:logId/retry
//   - Best-effort: errors throw out of this function only on the LAST
//     attempt; intermediate failures retry. The caller still wraps in
//     a try/catch so a webhook failure never rolls back a publish.

import type { SocialPlatform } from "./social-platforms.ts";

export type WebhookEvent = "blog.published" | "social.published";
export type SocialFormat = "long" | "short";

export interface WebhookPayloadBlog {
  event: "blog.published";
  timestamp: string;
  data: {
    id: string;
    url: string;
    title: string;
    excerpt: string | null;
    hero_image_url: string | null;
    primary_keyword: string | null;
    tags: string[];
    product_focus: "gradethread" | "flipdesk" | "both";
  };
}

export interface WebhookPayloadSocial {
  event: "social.published";
  // Legacy long/short discriminator. Optional now that US-870 fans out by
  // platform; retained so old log rows + the test-fire path keep working.
  format?: SocialFormat;
  // US-870: the platform this variant targets. Present on platform fan-out;
  // absent on the legacy long/short path.
  platform?: SocialPlatform;
  timestamp: string;
  data: {
    id: string;
    body: string;
    hashtags: string[];
    cta_url: string | null;
    product_focus: "gradethread" | "flipdesk" | "both";
    // US-870: branded social-card aspect label (US-871/US-872).
    image_field?: string | null;
    // US-871: resolved image URL — the post's uploaded asset_image_url, or an
    // auto-filled branded /og/social/card URL when no asset exists. Always
    // present so the receiving automation never posts image-less.
    image_url?: string | null;
  };
}

type WebhookPayload = WebhookPayloadBlog | WebhookPayloadSocial;

const ATTEMPT_DELAYS_MS = [0, 5_000, 30_000];
const ATTEMPT_TIMEOUT_MS = 10_000;

function getSigningSecret(): string | null {
  return Deno.env.get("CONTENT_WEBHOOK_SIGNING_SECRET")?.trim() || null;
}

/**
 * Sign a serialized webhook body with CONTENT_WEBHOOK_SIGNING_SECRET, or null
 * when no secret is configured. Exported so the settings page's "Test
 * webhook" fire carries the same X-Content-Signature a real publish does.
 */
export async function signContentBody(body: string): Promise<string | null> {
  const secret = getSigningSecret();
  return secret ? await hmacSha256Hex(secret, body) : null;
}

// HMAC-SHA256 hex signature. Uses Web Crypto so this works under Deno
// without pulling Node's crypto.
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

interface ResolvedTarget {
  url: string;
  // Echoed into the log row so we can group attempts by intended target.
  field: string;
}

async function resolveTargetUrl(
  payload: WebhookPayload,
): Promise<ResolvedTarget | null> {
  const { data, error } = await supabaseAdmin
    .from("content_settings")
    .select(
      "make_webhook_blog, make_webhook_social, make_webhook_social_long, make_webhook_social_short",
    )
    .eq("id", 1)
    .maybeSingle();
  if (error || !data) return null;

  if (payload.event === "blog.published") {
    return data.make_webhook_blog
      ? { url: data.make_webhook_blog as string, field: "blog" }
      : null;
  }

  // social.published
  const socialRouter = (data.make_webhook_social as string | null) ?? null;
  const longUrl = (data.make_webhook_social_long as string | null) ?? null;
  const shortUrl = (data.make_webhook_social_short as string | null) ?? null;

  // US-870 platform fan-out: prefer the single router webhook (a Make.com
  // router branches on `platform`); fall back to the legacy long/short URLs so
  // existing deployments keep delivering — X/Threads → short, the rest → long.
  if (payload.platform) {
    const field = `social_${payload.platform}`;
    if (socialRouter) return { url: socialRouter, field };
    const legacy = payload.platform === "x" || payload.platform === "threads"
      ? shortUrl
      : longUrl;
    return legacy ? { url: legacy, field } : null;
  }

  // Legacy long/short path (no platform).
  if (payload.format === "long" && longUrl) {
    return { url: longUrl, field: "social_long" };
  }
  if (payload.format === "short" && shortUrl) {
    return { url: shortUrl, field: "social_short" };
  }
  return null;
}

async function logAttempt(row: {
  event: WebhookEvent;
  // Carries the platform (US-870) or legacy long/short label, for grouping.
  format: string | null;
  target_url: string;
  payload: WebhookPayload;
  attempt_no: number;
  http_status: number | null;
  response_body: string | null;
  succeeded: boolean;
  error: string | null;
}): Promise<void> {
  await supabaseAdmin
    .from("content_webhook_log")
    .insert(row)
    .then(({ error }) => {
      if (error) {
        console.warn("[content-webhook] log insert failed:", error.message);
      }
    });
}

// Sleep helper. AbortSignal-friendly so a future caller can cancel.
function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

export async function dispatchContentWebhook(
  payload: WebhookPayload,
): Promise<{ delivered: boolean; attempts: number; last_status: number | null }> {
  const format =
    payload.event === "social.published" ? payload.format : undefined;
  const platform =
    payload.event === "social.published" ? payload.platform : undefined;
  // Short label for headers/logs/console: platform (US-870) else long/short.
  const label = platform ?? format;
  const target = await resolveTargetUrl(payload);
  if (!target) {
    console.log(
      `[content-webhook] no URL configured for event=${payload.event}${
        label ? `/${label}` : ""
      } — skipping`,
    );
    return { delivered: false, attempts: 0, last_status: null };
  }

  const body = JSON.stringify(payload);
  const signature = await signContentBody(body);

  let lastStatus: number | null = null;
  for (let i = 0; i < ATTEMPT_DELAYS_MS.length; i++) {
    if (i > 0) await sleep(ATTEMPT_DELAYS_MS[i] ?? 0);
    const attemptNo = i + 1;
    let status: number | null = null;
    let respBody = "";
    let ok = false;
    let errStr: string | null = null;

    try {
      const res = await fetch(target.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(signature ? { "X-Content-Signature": signature } : {}),
          "X-Content-Event": payload.event,
          ...(format ? { "X-Content-Format": format } : {}),
          ...(platform ? { "X-Content-Platform": platform } : {}),
        },
        body,
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
      format: label ?? null,
      target_url: target.url,
      payload,
      attempt_no: attemptNo,
      http_status: status,
      response_body: respBody || null,
      succeeded: ok,
      error: errStr,
    });

    if (ok) {
      console.log(
        `[content-webhook] delivered ${payload.event}${
          label ? `/${label}` : ""
        } on attempt ${attemptNo} (${status})`,
      );
      captureWebhookDispatched(payload, true);
      return { delivered: true, attempts: attemptNo, last_status: status };
    }
    console.warn(
      `[content-webhook] attempt ${attemptNo} failed for ${payload.event}: ${
        errStr ?? status
      }`,
    );
  }

  console.error(
    `[content-webhook] gave up on ${payload.event}${
      label ? `/${label}` : ""
    } after ${ATTEMPT_DELAYS_MS.length} attempts`,
  );
  captureWebhookDispatched(payload, false);
  await alertDeliveryFailure(payload, label, target, lastStatus);
  return {
    delivered: false,
    attempts: ATTEMPT_DELAYS_MS.length,
    last_status: lastStatus,
  };
}

// US-487: a delivery that exhausts every retry must page someone, not just
// sit in content_webhook_log. Three channels, all fail-safe: a metric line
// (content_webhook.delivery_failed), the error tracker, and an ops webhook
// (CONTENT_ALERT_WEBHOOK, falling back to the grading monitor's
// MONITOR_ALERT_WEBHOOK — Slack/PagerDuty-compatible `text`+`summary` body).
// Never throws into the dispatcher; the failed payload stays retryable from
// the dashboard (POST /webhooks/:logId/retry).
async function alertDeliveryFailure(
  payload: WebhookPayload,
  label: string | undefined,
  target: ResolvedTarget,
  lastStatus: number | null,
): Promise<void> {
  const summary =
    `[GradeThread content] webhook delivery FAILED: ${payload.event}` +
    `${label ? `/${label}` : ""} (post ${payload.data.id}) to ${target.field} ` +
    `after ${ATTEMPT_DELAYS_MS.length} attempts ` +
    `(last status: ${lastStatus ?? "network error"}). ` +
    `Retry from Content Settings → webhook log.`;

  recordMetric("content_webhook.delivery_failed", 1, {
    event: payload.event,
    target: target.field,
  });
  captureException(new Error(summary), {
    route: "content-webhook.dispatch",
    tags: { event: payload.event, target: target.field },
  });

  // US-882: land the terminal failure in the unified dead-letter queue
  // (webhook_dead_letters, provider='content') so it's inspectable + replayable
  // from the cross-provider console — not just buried in content_webhook_log.
  await recordContentDeadLetter(payload, label, target.field, lastStatus);

  const hook = Deno.env.get("CONTENT_ALERT_WEBHOOK")?.trim() ||
    Deno.env.get("MONITOR_ALERT_WEBHOOK")?.trim() || "";
  if (!hook) return;
  try {
    const res = await fetch(hook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: summary, // Slack
        summary, // PagerDuty/generic
        event: payload.event,
        post_id: payload.data.id,
        last_status: lastStatus,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    await res.body?.cancel();
  } catch (err) {
    captureException(err, { route: "content-webhook.alert" });
  }
}

// US-882: a stable (provider, event_id) key for a content dead letter. A single
// post can fail to several platform targets, so the key includes the target
// label — each failed destination is its own replayable row, deduped on re-drop.
function contentDeadLetterEventId(
  payload: WebhookPayload,
  label: string | undefined,
): string {
  return `${payload.data.id}:${label ?? payload.event}`;
}

// US-882: record a terminal content-webhook failure into webhook_dead_letters so
// the unified console can surface + replay it. Content payloads are public
// blog/social data (no PII/secrets), so they're stored raw — replay reconstructs
// the exact WebhookPayload and re-dispatches. Never throws (best-effort, mirrors
// recordWebhookDeadLetter's contract).
async function recordContentDeadLetter(
  payload: WebhookPayload,
  label: string | undefined,
  targetField: string,
  lastStatus: number | null,
): Promise<void> {
  try {
    const eventType = `${payload.event}${label ? `/${label}` : ""}`;
    const { error } = await supabaseAdmin
      .from("webhook_dead_letters")
      .upsert(
        {
          provider: "content",
          event_id: contentDeadLetterEventId(payload, label),
          event_type: eventType,
          payload,
          error_message:
            `content webhook delivery to ${targetField} failed after ${ATTEMPT_DELAYS_MS.length} ` +
            `attempts (last status: ${lastStatus ?? "network error"})`,
        },
        { onConflict: "provider,event_id", ignoreDuplicates: true },
      );
    if (error && error.code !== "23505") {
      console.warn("[content-webhook] dead-letter write failed:", error.message);
    }
  } catch (err) {
    console.warn(
      "[content-webhook] dead-letter write threw:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

// US-882: replay a content dead letter — narrow the stored payload back to a
// WebhookPayload and re-dispatch it through the normal content webhook path
// (the same dispatcher, not a re-implementation — satisfies AC#6). Returns
// whether delivery succeeded so the console can mark the row resolved.
export async function replayContentWebhook(
  payload: unknown,
): Promise<{ delivered: boolean }> {
  if (!isWebhookPayload(payload)) {
    throw new Error("dead-letter payload is not a valid content webhook payload");
  }
  const result = await dispatchContentWebhook(payload);
  return { delivered: result.delivered };
}

function isWebhookPayload(p: unknown): p is WebhookPayload {
  if (!p || typeof p !== "object") return false;
  const o = p as Record<string, unknown>;
  if (o.event !== "blog.published" && o.event !== "social.published") return false;
  const data = o.data as Record<string, unknown> | undefined;
  return !!data && typeof data.id === "string";
}

// US-255: emit the server-side 'webhook.dispatched' analytics event once a
// dispatch reaches a terminal outcome. surface + product_focus on every event
// (matching the dashboard-fired content.* events). No user in this context —
// keyed to a stable system distinct id. Fire-and-forget; never throws.
function captureWebhookDispatched(payload: WebhookPayload, succeeded: boolean) {
  const surface = payload.event === "blog.published" ? "blog" : "social";
  void captureServer("system:content", "webhook.dispatched", {
    surface,
    product_focus: payload.data.product_focus,
    event: payload.event,
    succeeded,
  });
}
