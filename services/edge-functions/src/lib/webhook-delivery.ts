import { supabaseAdmin } from "./supabase.ts";

const RETRY_DELAYS_MS = [5_000, 30_000, 120_000]; // 5s, 30s, 120s
const DELIVERY_TIMEOUT_MS = 10_000; // 10 second timeout per attempt

interface WebhookPayload {
  event: string;
  data: Record<string, unknown>;
  timestamp: string;
}

/**
 * Computes an HMAC-SHA256 signature for the webhook payload.
 * Uses the API key's key_hash as the signing secret.
 */
async function computeHmacSignature(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", encoder.encode(payload), key);
  return Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Attempts a single webhook delivery with timeout.
 * Returns { success, statusCode, responseBody }.
 */
async function attemptDelivery(
  url: string,
  body: string,
  signature: string
): Promise<{ success: boolean; statusCode: number; responseBody: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-GradeThread-Signature": signature,
        "User-Agent": "GradeThread-Webhook/1.0",
      },
      body,
      signal: controller.signal,
    });

    const responseBody = await response.text().catch(() => "");
    return {
      success: response.ok,
      statusCode: response.status,
      responseBody: responseBody.slice(0, 500), // Limit stored response body
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      statusCode: 0,
      responseBody: `Delivery error: ${message}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Delivers a webhook to the specified URL with HMAC signature and retry logic.
 * Retries up to 3 times with exponential backoff (5s, 30s, 120s).
 * Logs all delivery attempts.
 */
async function deliverWebhook(
  webhookUrl: string,
  payload: WebhookPayload,
  signingSecret: string
): Promise<void> {
  const body = JSON.stringify(payload);
  const signature = await computeHmacSignature(body, signingSecret);

  // First attempt
  const maxAttempts = 1 + RETRY_DELAYS_MS.length; // 1 initial + 3 retries
  let attempt = 0;

  while (attempt < maxAttempts) {
    attempt++;

    console.log(
      `[Webhook] Attempt ${attempt}/${maxAttempts} delivering to ${webhookUrl} | event=${payload.event}`
    );

    const result = await attemptDelivery(webhookUrl, body, signature);

    console.log(
      `[Webhook] Attempt ${attempt} result: success=${result.success} status=${result.statusCode} | ` +
        `response=${result.responseBody.slice(0, 100)}`
    );

    if (result.success) {
      console.log(`[Webhook] Delivery successful on attempt ${attempt}`);
      return;
    }

    // If we have retries left, wait before next attempt
    const retryIndex = attempt - 1;
    if (retryIndex < RETRY_DELAYS_MS.length) {
      const delay = RETRY_DELAYS_MS[retryIndex]!;
      console.log(`[Webhook] Retrying in ${delay / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  console.error(
    `[Webhook] All ${maxAttempts} delivery attempts failed for ${webhookUrl} | event=${payload.event}`
  );
}

/**
 * Sends webhook notifications for a completed grade to all of the user's API keys
 * that have a webhook_url configured.
 *
 * Called from the grading pipeline after a grade report is created.
 */
export async function notifyWebhooks(
  userId: string,
  submissionId: string,
  gradeReport: Record<string, unknown>
): Promise<void> {
  // Find all API keys for this user with webhook_url set
  const { data: keys, error } = await supabaseAdmin
    .from("api_keys")
    .select("id, key_hash, webhook_url, expires_at")
    .eq("user_id", userId)
    .not("webhook_url", "is", null);

  if (error) {
    console.error("[Webhook] Failed to fetch API keys for webhook delivery:", error);
    return;
  }

  if (!keys || keys.length === 0) {
    console.log(`[Webhook] No webhook URLs configured for user ${userId}`);
    return;
  }

  // Filter out expired keys
  const activeKeys = keys.filter((key) => {
    if (!key.expires_at) return true;
    return new Date(key.expires_at) > new Date();
  });

  if (activeKeys.length === 0) {
    console.log(`[Webhook] All API keys with webhooks are expired for user ${userId}`);
    return;
  }

  const payload: WebhookPayload = {
    event: "grade.completed",
    data: {
      submission_id: submissionId,
      grade_report: gradeReport,
    },
    timestamp: new Date().toISOString(),
  };

  console.log(
    `[Webhook] Delivering grade.completed webhook to ${activeKeys.length} endpoint(s) for submission ${submissionId}`
  );

  // Deliver to all configured webhook URLs in parallel
  const deliveryPromises = activeKeys.map((key) =>
    deliverWebhook(key.webhook_url as string, payload, key.key_hash).catch((err) => {
      console.error(`[Webhook] Unhandled error delivering to key ${key.id}:`, err);
    })
  );

  await Promise.allSettled(deliveryPromises);
}
