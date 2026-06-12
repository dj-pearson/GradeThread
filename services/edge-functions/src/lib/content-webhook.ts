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
  format: SocialFormat;
  timestamp: string;
  data: {
    id: string;
    body: string;
    hashtags: string[];
    cta_url: string | null;
    product_focus: "gradethread" | "flipdesk" | "both";
  };
}

type WebhookPayload = WebhookPayloadBlog | WebhookPayloadSocial;

const ATTEMPT_DELAYS_MS = [0, 5_000, 30_000];
const ATTEMPT_TIMEOUT_MS = 10_000;

function getSigningSecret(): string | null {
  return Deno.env.get("CONTENT_WEBHOOK_SIGNING_SECRET")?.trim() || null;
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
  event: WebhookEvent,
  format?: SocialFormat,
): Promise<ResolvedTarget | null> {
  const { data, error } = await supabaseAdmin
    .from("content_settings")
    .select(
      "make_webhook_blog, make_webhook_social_long, make_webhook_social_short",
    )
    .eq("id", 1)
    .maybeSingle();
  if (error || !data) return null;

  if (event === "blog.published") {
    return data.make_webhook_blog
      ? { url: data.make_webhook_blog as string, field: "blog" }
      : null;
  }
  if (event === "social.published") {
    if (format === "long" && data.make_webhook_social_long) {
      return {
        url: data.make_webhook_social_long as string,
        field: "social_long",
      };
    }
    if (format === "short" && data.make_webhook_social_short) {
      return {
        url: data.make_webhook_social_short as string,
        field: "social_short",
      };
    }
  }
  return null;
}

async function logAttempt(row: {
  event: WebhookEvent;
  format: SocialFormat | null;
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
  const target = await resolveTargetUrl(payload.event, format);
  if (!target) {
    console.log(
      `[content-webhook] no URL configured for event=${payload.event}${
        format ? `/${format}` : ""
      } — skipping`,
    );
    return { delivered: false, attempts: 0, last_status: null };
  }

  const body = JSON.stringify(payload);
  const secret = getSigningSecret();
  const signature = secret ? await hmacSha256Hex(secret, body) : null;

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
      format: format ?? null,
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
          format ? `/${format}` : ""
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
      format ? `/${format}` : ""
    } after ${ATTEMPT_DELAYS_MS.length} attempts`,
  );
  captureWebhookDispatched(payload, false);
  await alertDeliveryFailure(payload, format, target, lastStatus);
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
  format: SocialFormat | undefined,
  target: ResolvedTarget,
  lastStatus: number | null,
): Promise<void> {
  const summary =
    `[GradeThread content] webhook delivery FAILED: ${payload.event}` +
    `${format ? `/${format}` : ""} (post ${payload.data.id}) to ${target.field} ` +
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
